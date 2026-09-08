//! Bounded archive transfer for the processor's explicit file contract.
use super::{shared, MUTATION_TIMEOUT};
use bollard::query_parameters::{DownloadFromContainerOptions, UploadToContainerOptions};
use bytes::Bytes;
use futures::{Stream, StreamExt, TryStreamExt};
use std::io::{self, Read};
use std::path::{Component, Path};
use std::pin::Pin;
use tokio::io::AsyncReadExt;

pub(crate) fn upload_file(
    id: &str,
    source: &Path,
    destination_directory: &str,
    name: &str,
) -> Result<(), String> {
    if !matches!(name, "source" | "request.json") || destination_directory != "/data/input" {
        return Err("unsupported processor input destination".into());
    }
    let engine = shared()?;
    engine.run(MUTATION_TIMEOUT, async {
        let file = tokio::fs::File::open(source)
            .await
            .map_err(|e| e.to_string())?;
        let metadata = file.metadata().await.map_err(|e| e.to_string())?;
        if !metadata.is_file() {
            return Err("processor input is not a regular file".into());
        }
        let size = metadata.len();
        let mut header = tar::Header::new_gnu();
        header.set_path(name).map_err(|e| e.to_string())?;
        header.set_size(size);
        header.set_mode(0o644);
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_cksum();
        let head = Bytes::copy_from_slice(header.as_bytes());
        let contents =
            futures::stream::try_unfold((file, size), |(mut file, remaining)| async move {
                if remaining == 0 {
                    return Ok(None);
                }
                let mut chunk = vec![0; remaining.min(64 * 1024) as usize];
                let count = file.read(&mut chunk).await?;
                if count == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "processor source changed during transfer",
                    ));
                }
                chunk.truncate(count);
                Ok(Some((Bytes::from(chunk), (file, remaining - count as u64))))
            });
        let tail = Bytes::from(vec![0; ((512 - size % 512) % 512 + 1024) as usize]);
        let stream = futures::stream::once(async { Ok::<_, io::Error>(head) })
            .chain(contents)
            .chain(futures::stream::once(async { Ok(tail) }));
        engine
            .docker
            .upload_to_container(
                id,
                Some(UploadToContainerOptions {
                    path: destination_directory.into(),
                    no_overwrite_dir_non_dir: Some("true".into()),
                    ..Default::default()
                }),
                bollard::body_try_stream(stream),
            )
            .await
            .map_err(|e| format!("Docker archive upload failed; not replayed: {e}"))
    })
}

struct ArchiveReader {
    stream: Pin<Box<dyn Stream<Item = Result<Bytes, bollard::errors::Error>> + Send>>,
    pending: Bytes,
    remaining: u64,
}
impl Read for ArchiveReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        while self.pending.is_empty() {
            let next = shared()
                .map_err(io::Error::other)?
                .run(MUTATION_TIMEOUT, async {
                    self.stream.try_next().await.map_err(|e| e.to_string())
                })
                .map_err(io::Error::other)?;
            let Some(bytes) = next else {
                return Ok(0);
            };
            self.remaining = self
                .remaining
                .checked_sub(bytes.len() as u64)
                .ok_or_else(|| io::Error::other("processor archive exceeds byte budget"))?;
            self.pending = bytes;
        }
        let count = buffer.len().min(self.pending.len());
        buffer[..count].copy_from_slice(&self.pending.split_to(count));
        Ok(count)
    }
}

fn output_name(path: &Path) -> Result<Option<String>, String> {
    let mut components = Vec::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::Normal(value) => {
                components.push(value.to_str().ok_or("non-UTF8 processor output")?)
            }
            _ => return Err("processor archive path escapes output directory".into()),
        }
    }
    if components.first() == Some(&"output") {
        components.remove(0);
    }
    if components.is_empty() {
        return Ok(None);
    }
    if components.len() != 1
        || !matches!(
            components[0],
            "canonical.md" | "manifest.json" | "preview.pdf"
        )
    {
        return Err("processor archive contains an unknown output".into());
    }
    Ok(Some(components[0].into()))
}

fn extract_outputs(reader: impl Read, directory: &Path, output_budget: u64) -> Result<(), String> {
    let mut archive = tar::Archive::new(reader);
    let entries = archive.entries().map_err(|e| e.to_string())?.raw(true);
    let mut remaining = output_budget;
    let mut seen = std::collections::HashSet::new();
    for entry in entries {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().map_err(|e| e.to_string())?;
        let name = output_name(&path)?;
        let kind = entry.header().entry_type();
        let Some(name) = name else {
            if kind.is_dir() && seen.insert("directory".to_string()) {
                continue;
            }
            return Err("invalid processor archive root".into());
        };
        if !kind.is_file() || !seen.insert(name.clone()) {
            return Err("processor archive has a link, special file or duplicate".into());
        }
        let size = entry.header().size().map_err(|e| e.to_string())?;
        if name == "manifest.json" {
            if size > 64 * 1024 * 1024 {
                return Err("processor manifest exceeds byte budget".into());
            }
        } else {
            remaining = remaining
                .checked_sub(size)
                .ok_or("processor output exceeds byte budget")?;
        }
        // Fresh local work directory; create_new also refuses preexisting
        // files/symlinks. Never let an archive choose host paths or ownership.
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(directory.join(name))
            .map_err(|e| e.to_string())?;
        let copied = io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;
        if copied != size {
            return Err("processor archive member is truncated".into());
        }
    }
    // Validate transport completion as well as tar completion. Do not accept
    // an early tar terminator followed by hidden entries or a broken response.
    let mut reader = archive.into_inner();
    let mut trailing = [0u8; 8192];
    loop {
        let count = reader.read(&mut trailing).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        if trailing[..count].iter().any(|byte| *byte != 0) {
            return Err("non-padding data after processor archive".into());
        }
    }
    Ok(())
}

pub(crate) fn download_processor_outputs(
    id: &str,
    directory: &Path,
    output_budget: u64,
) -> Result<(), String> {
    let engine = shared()?;
    let stream = engine.docker.download_from_container(
        id,
        Some(DownloadFromContainerOptions {
            path: "/data/output/.".into(),
        }),
    );
    let reader = ArchiveReader {
        stream: Box::pin(stream),
        pending: Bytes::new(),
        remaining: output_budget
            .saturating_add(64 * 1024 * 1024)
            .saturating_add(16 * 1024),
    };
    extract_outputs(reader, directory, output_budget)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archive_output_paths_are_confined_to_the_processor_contract() {
        assert_eq!(
            output_name(Path::new("output/canonical.md")).unwrap(),
            Some("canonical.md".into())
        );
        for path in [
            "../canonical.md",
            "/canonical.md",
            "output/nested/manifest.json",
            "unknown",
        ] {
            assert!(output_name(Path::new(path)).is_err(), "{path}");
        }
    }
    #[test]
    fn extraction_rejects_links_and_oversized_files_before_writing() {
        for (kind, size) in [(tar::EntryType::Symlink, 0), (tar::EntryType::Regular, 2)] {
            let mut builder = tar::Builder::new(Vec::new());
            let mut header = tar::Header::new_gnu();
            header.set_path("canonical.md").unwrap();
            header.set_entry_type(kind);
            header.set_size(size);
            header.set_mode(0o644);
            if kind.is_symlink() {
                header.set_link_name("/outside").unwrap();
            }
            header.set_cksum();
            builder
                .append(&header, &vec![0; size as usize][..])
                .unwrap();
            let bytes = builder.into_inner().unwrap();
            let error =
                extract_outputs(&bytes[..], Path::new("unused-destination"), 1).unwrap_err();
            assert!(error.contains("link") || error.contains("byte budget"));
        }
    }
}
