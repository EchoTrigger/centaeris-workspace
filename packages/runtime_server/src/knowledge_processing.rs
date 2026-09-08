use std::collections::{BTreeMap, HashMap};
use std::env;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::knowledge_types::{
    representation_id, ProcessingOptionsV1, ProcessingSpecificationV1,
    PROCESSING_SPECIFICATION_SCHEMA,
};
use crate::postgres_store::PostgresRuntimeStore;
use centaeris_core::session::reliability::{RuntimeJobStatus, RuntimeJobStorePort};
use centaeris_core::tool::inputs::InputIdentityV1;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::docker_execution_host::{bounded_diagnostic, OciRuntime};

pub(crate) const KNOWLEDGE_PROCESS_JOB_KIND: &str = "knowledge.process";
const PAYLOAD_PREFIX: &str = "knowledge.process.v1:";
const PROCESS_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const API_TIMEOUT: Duration = Duration::from_secs(120);

static PROCESSOR_SPECIFICATION: OnceLock<Result<ProcessingSpecificationV1, String>> =
    OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessorDevice {
    Cpu,
    Gpu0,
}

impl ProcessorDevice {
    fn from_value(value: &str) -> Result<Self, String> {
        match value {
            "cpu" => Ok(Self::Cpu),
            "gpu:0" => Ok(Self::Gpu0),
            _ => Err(format!(
                "KNOWLEDGE_PROCESSOR_DEVICE must be exactly cpu or gpu:0, got {value:?}"
            )),
        }
    }

    fn from_environment() -> Result<Self, String> {
        let value = env::var("KNOWLEDGE_PROCESSOR_DEVICE")
            .map_err(|_| "KNOWLEDGE_PROCESSOR_DEVICE is required".to_string())?;
        Self::from_value(value.as_str())
    }

    fn processor_id(self) -> &'static str {
        match self {
            Self::Cpu => "centaeris.document.cpu",
            Self::Gpu0 => "centaeris.document.cuda.gpu0",
        }
    }

    fn device_requests(self) -> Value {
        match self {
            Self::Cpu => json!([]),
            Self::Gpu0 => json!([{"Driver":"", "DeviceIDs":["0"], "Capabilities":[["gpu"]]}]),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KnowledgeProcessPayloadV1 {
    pub schema: String,
    pub agent_run_id: String,
    pub authorization_digest: String,
    pub session_id: String,
    pub input_ref: String,
    pub display_name: String,
    pub content_type: String,
    pub size_bytes: u64,
    pub source_version: String,
    pub input_identity: InputIdentityV1,
    pub representation_id: String,
    pub spec_digest: String,
}

impl KnowledgeProcessPayloadV1 {
    pub(crate) fn encode(&self) -> Result<String, String> {
        self.validate()?;
        serde_json::to_string(self)
            .map(|value| format!("{PAYLOAD_PREFIX}{value}"))
            .map_err(|error| format!("encode knowledge process payload failed: {error}"))
    }

    pub(crate) fn decode(value: Option<&str>) -> Result<Self, String> {
        let value = value
            .and_then(|value| value.strip_prefix(PAYLOAD_PREFIX))
            .ok_or_else(|| "knowledge process payload prefix is invalid".to_string())?;
        let payload = serde_json::from_str::<Self>(value)
            .map_err(|error| format!("decode knowledge process payload failed: {error}"))?;
        payload.validate()?;
        Ok(payload)
    }

    fn validate(&self) -> Result<(), String> {
        if self.schema != "knowledge.process.payload.v1" {
            return Err("knowledge process payload schema mismatch".to_string());
        }
        self.input_identity.validate()?;
        let specification = processor_specification()?;
        if self.spec_digest != specification.spec_digest()?
            || self.representation_id
                != representation_id(&self.input_identity, self.spec_digest.as_str())?
            || self.source_version != self.input_identity.generation.to_string()
        {
            return Err("knowledge process payload identity mismatch".to_string());
        }
        for value in [
            self.agent_run_id.as_str(),
            self.authorization_digest.as_str(),
            self.session_id.as_str(),
            self.input_ref.as_str(),
            self.display_name.as_str(),
            self.content_type.as_str(),
        ] {
            if value.trim().is_empty() || value.trim() != value {
                return Err("knowledge process payload has an empty identity".to_string());
            }
        }
        Ok(())
    }
}

pub(crate) fn knowledge_process_job_id(representation_id: &str) -> Result<String, String> {
    let digest = representation_id
        .strip_prefix("representation:sha256:")
        .ok_or_else(|| "knowledge representationId prefix is invalid".to_string())?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("knowledge representationId digest is invalid".to_string());
    }
    Ok(format!("knowledge.process:{digest}"))
}

pub(crate) fn processor_specification() -> Result<ProcessingSpecificationV1, String> {
    PROCESSOR_SPECIFICATION
        .get_or_init(load_processor_specification)
        .clone()
}

/// Preserve the deployment's image-presence preflight without a CLI dependency
/// or starting a processor container before Runtime begins listening.
pub(crate) fn validate_processor_image() -> Result<(), String> {
    crate::docker_engine::image_id(&processor_image()?).map(|_| ())
}

fn load_processor_specification() -> Result<ProcessingSpecificationV1, String> {
    let device = ProcessorDevice::from_environment()?;
    let image = processor_image()?;
    let execution_image_digest = crate::docker_engine::image_id(&image)?;
    let name = format!(
        "centaeris-processor-spec-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    );
    let mut body = json!({"Image":execution_image_digest,"Cmd":["spec"],
        "Labels":{"centaeris.processor":"true","centaeris.processor_instance":name},
        "HostConfig":{"Runtime":oci_runtime()?.docker_runtime_name(), "NetworkMode":"none",
            "ReadonlyRootfs":true,"Tmpfs":{"/tmp":"rw,nosuid,nodev,mode=1777"},
            "CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],"DeviceRequests":device.device_requests()}});
    if device == ProcessorDevice::Cpu {
        body["HostConfig"]
            .as_object_mut()
            .unwrap()
            .remove("DeviceRequests");
    }
    let id = crate::docker_engine::ensure_created(&name, body)?;
    let result = crate::docker_engine::start(&id)
        .and_then(|()| crate::docker_engine::wait_output(&id, Duration::from_secs(30)));
    let removed = crate::docker_engine::remove(&id, true);
    let output = match (result, removed) {
        (Ok(output), Ok(())) => output,
        (Ok(_), Err(error)) => return Err(format!("processor spec cleanup failed: {error}")),
        (Err(error), Ok(())) => return Err(error),
        (Err(error), Err(cleanup)) => {
            return Err(format!("{error}; processor spec cleanup failed: {cleanup}"))
        }
    };
    if output.exit_code != 0 {
        return Err(format!(
            "processor spec command failed: {}",
            bounded_diagnostic(output.stderr.as_slice())
        ));
    }
    let declared = serde_json::from_slice::<ProcessorSpecOutput>(output.stdout.as_slice())
        .map_err(|error| format!("decode processor specification failed: {error}"))?;
    if declared.schema != "knowledge.processor_spec.v1" {
        return Err("processor specification schema mismatch".to_string());
    }
    if declared.processor_id != device.processor_id() {
        return Err("processor device identity mismatch".to_string());
    }
    let specification = ProcessingSpecificationV1 {
        schema: PROCESSING_SPECIFICATION_SCHEMA.to_string(),
        processor_id: declared.processor_id,
        processor_version: declared.processor_version,
        execution_image_digest,
        model_digests: declared.model_digests,
        options: declared.options,
    };
    specification.validate()?;
    Ok(specification)
}

pub(crate) fn handle(
    method: &str,
    path: &str,
    headers: &HashMap<String, String>,
    body: &[u8],
    store: &PostgresRuntimeStore,
) -> Option<(u16, Vec<u8>)> {
    if path != "/internal/knowledge/process" {
        return None;
    }
    let token = match env::var("INTERNAL_API_TOKEN") {
        Ok(value) if !value.is_empty() => value,
        _ => return Some(response(500, json!({"error":"internal_token_unavailable"}))),
    };
    if headers.get("x-internal-token").map(String::as_str) != Some(token.as_str()) {
        return Some(response(401, json!({"error":"unauthorized"})));
    }
    if method != "POST" {
        return Some(response(
            404,
            json!({"error":"knowledge_processing_not_found"}),
        ));
    }
    let result = serde_json::from_slice::<ProcessRequest>(body)
        .map_err(|_| "knowledge_process_request_invalid".to_string())
        .and_then(|request| process_claimed_job(request, store));
    Some(match result {
        Ok(value) => response(200, value),
        Err(error) => {
            eprintln!("knowledge processing failed: {error}");
            response(409, json!({"error":"knowledge_processing_failed"}))
        }
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessRequest {
    schema: String,
    job_id: String,
    lease_owner: String,
}

fn process_claimed_job(
    request: ProcessRequest,
    store: &PostgresRuntimeStore,
) -> Result<Value, String> {
    if request.schema != "knowledge.process.request.v1" || request.lease_owner.trim().is_empty() {
        return Err("knowledge process request is invalid".to_string());
    }
    let job = store
        .get_runtime_job(request.job_id.as_str())?
        .ok_or_else(|| "knowledge process job is missing".to_string())?;
    if job.job_kind != KNOWLEDGE_PROCESS_JOB_KIND
        || job.status != RuntimeJobStatus::Running
        || job.lease_owner.as_deref() != Some(request.lease_owner.as_str())
        || job
            .lease_expires_at_ms
            .is_none_or(|expires_at_ms| expires_at_ms <= now_ms().unwrap_or(i64::MAX))
        || job.idempotency_key != job.job_id
    {
        return Err("knowledge process job lease binding mismatch".to_string());
    }
    let payload = KnowledgeProcessPayloadV1::decode(job.payload_ref.as_deref())?;
    if knowledge_process_job_id(payload.representation_id.as_str())? != job.job_id
        || job.session_id.as_deref() != Some(payload.session_id.as_str())
    {
        return Err("knowledge process job identity mismatch".to_string());
    }
    process(payload)?;
    Ok(json!({
        "schema": "knowledge.process.result.v1",
        "jobId": job.job_id,
        "representationId": KnowledgeProcessPayloadV1::decode(job.payload_ref.as_deref())?.representation_id,
    }))
}

fn process(payload: KnowledgeProcessPayloadV1) -> Result<(), String> {
    if representation_ready(&payload)? {
        return Ok(());
    }
    let state_root = PathBuf::from(
        env::var("RUNTIME_STATE_ROOT").map_err(|_| "RUNTIME_STATE_ROOT is required".to_string())?,
    );
    let digest = payload
        .representation_id
        .strip_prefix("representation:sha256:")
        .ok_or_else(|| "knowledge representation prefix mismatch".to_string())?;
    let work_root = state_root
        .join("knowledge")
        .join(format!("{}-{}", &digest[..16], now_ms()?));
    fs::create_dir_all(work_root.join("output"))
        .map_err(|error| format!("create knowledge work root failed: {error}"))?;
    let result = process_in_work_root(&payload, work_root.as_path());
    let cleanup = fs::remove_dir_all(work_root.as_path());
    match (result, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Ok(()), Err(error)) => Err(format!("cleanup knowledge work root failed: {error}")),
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(cleanup)) => Err(format!("{error}; processor cleanup failed: {cleanup}")),
    }
}

fn process_in_work_root(payload: &KnowledgeProcessPayloadV1, root: &Path) -> Result<(), String> {
    let source = root.join("source");
    download_source(payload, source.as_path())?;
    let request_path = root.join("request.json");
    fs::write(
        request_path.as_path(),
        serde_json::to_vec(&json!({
            "schema": "knowledge.processing.request.v1",
            "inputPath": "/data/input/source",
            "displayName": payload.display_name,
            "contentType": payload.content_type,
            "outputDirectory": "/data/output",
        }))
        .map_err(|error| format!("encode processing request failed: {error}"))?,
    )
    .map_err(|error| format!("write processing request failed: {error}"))?;
    let container_name = format!(
        "centaeris-knowledge-{}-{}",
        &payload
            .representation_id
            .strip_prefix("representation:sha256:")
            .expect("validated representation prefix")[..12],
        now_ms()?
    );
    let container_id = create_processor_container(container_name.as_str())?;
    let result = (|| {
        crate::docker_engine::upload_file(&container_id, &source, "/data/input", "source")?;
        crate::docker_engine::upload_file(
            &container_id,
            &request_path,
            "/data/input",
            "request.json",
        )?;
        crate::docker_engine::start(&container_id)?;
        let output = crate::docker_engine::wait_output(&container_id, PROCESS_TIMEOUT)?;
        if output.exit_code != 0 {
            return Err(format!(
                "document processor failed: {}",
                bounded_diagnostic(output.stderr.as_slice())
            ));
        }
        crate::docker_engine::download_processor_outputs(
            &container_id,
            &root.join("output"),
            processor_specification()?.options.max_output_bytes,
        )?;
        commit_outputs(payload, root.join("output").as_path())
    })();
    let removed = crate::docker_engine::remove(&container_id, true);
    match (result, removed) {
        (Ok(()), Ok(_)) => Ok(()),
        (Ok(()), Err(error)) => Err(format!("remove processor container failed: {error}")),
        (Err(error), _) => Err(error),
    }
}

fn create_processor_container(name: &str) -> Result<String, String> {
    let body = processor_container_body(
        name,
        oci_runtime()?.docker_runtime_name(),
        processor_specification()?.execution_image_digest,
        ProcessorDevice::from_environment()?,
    );
    crate::docker_engine::ensure_created(name, body)
}

fn processor_container_body(
    name: &str,
    runtime: &str,
    image: String,
    device: ProcessorDevice,
) -> Value {
    let mut body = json!({"Image":image,"Cmd":["process","/data/input/request.json"],"User":"10001:10001",
        "Labels":{"centaeris.processor":"true","centaeris.processor_instance":name},
        "HostConfig":{"Runtime":runtime,"NetworkMode":"none","ReadonlyRootfs":true,
            "Tmpfs":{"/tmp":"rw,nosuid,nodev,mode=1777"},"Memory":4294967296_i64,
            "NanoCpus":8000000000_i64,"PidsLimit":64,"CapDrop":["ALL"],
            "SecurityOpt":["no-new-privileges"], "DeviceRequests":device.device_requests(),
            "Mounts":[{"Type":"volume","Target":"/data/input"},
                      {"Type":"volume","Target":"/data/output"}]}});
    if device == ProcessorDevice::Cpu {
        body["HostConfig"]
            .as_object_mut()
            .unwrap()
            .remove("DeviceRequests");
    }
    body
}

fn download_source(payload: &KnowledgeProcessPayloadV1, path: &Path) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(API_TIMEOUT)
        .build()
        .map_err(|error| format!("build source client failed: {error}"))?;
    let mut response = client
        .post(format!("{}/internal/agent-runs/read-input", api_url()?))
        .header("X-Internal-Token", api_token()?.as_str())
        .json(&json!({
            "schema": "runtime.deferred_input.read.v1",
            "agentRunId": payload.agent_run_id,
            "authorizationDigest": payload.authorization_digest,
            "inputRef": payload.input_ref,
            "sourceVersion": payload.source_version,
            "sha256": payload.input_identity.sha256,
        }))
        .send()
        .map_err(|error| format!("download knowledge source failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "download knowledge source returned {}",
            response.status()
        ));
    }
    let maximum = processor_specification()?.options.max_input_bytes;
    let mut output = File::create(path)
        .map_err(|error| format!("create knowledge source file failed: {error}"))?;
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("read knowledge source failed: {error}"))?;
        if read == 0 {
            break;
        }
        size = size.saturating_add(read as u64);
        if size > maximum {
            return Err("knowledge source exceeds maxInputBytes".to_string());
        }
        digest.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|error| format!("write knowledge source failed: {error}"))?;
    }
    let actual = format!("sha256:{:x}", digest.finalize());
    if size != payload.size_bytes || actual != payload.input_identity.sha256 {
        return Err("knowledge source identity mismatch".to_string());
    }
    Ok(())
}

fn commit_outputs(payload: &KnowledgeProcessPayloadV1, output: &Path) -> Result<(), String> {
    let entries = fs::read_dir(output)
        .map_err(|error| format!("read processor output directory failed: {error}"))?
        .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read processor output entry failed: {error}"))?;
    if entries.iter().any(|name| {
        !matches!(
            name.as_str(),
            "canonical.md" | "manifest.json" | "preview.pdf"
        )
    }) {
        return Err("document processor produced an unknown output".to_string());
    }
    let canonical = output.join("canonical.md");
    let manifest_path = output.join("manifest.json");
    if !canonical.is_file() || !manifest_path.is_file() {
        return Err("document processor output is incomplete".to_string());
    }
    if file_size(manifest_path.as_path())? > 64 * 1024 * 1024 {
        return Err("processor manifest exceeds its bound".to_string());
    }
    let manifest_bytes = fs::read(manifest_path)
        .map_err(|error| format!("read processor manifest failed: {error}"))?;
    let manifest = serde_json::from_slice::<Value>(manifest_bytes.as_slice())
        .map_err(|error| format!("decode processor manifest failed: {error}"))?;
    let canonical_size = file_size(canonical.as_path())?;
    let canonical_sha = sha256_file(canonical.as_path())?;
    let preview = output.join("preview.pdf");
    let (preview_size, preview_sha) = if preview.is_file() {
        (
            file_size(preview.as_path())?,
            Some(sha256_file(preview.as_path())?),
        )
    } else {
        (0, None)
    };
    if canonical_size.saturating_add(preview_size)
        > processor_specification()?.options.max_output_bytes
    {
        return Err("processor outputs exceed maxOutputBytes".to_string());
    }
    let metadata = json!({
        "schema": "knowledge.processing.commit.v1",
        "jobId": knowledge_process_job_id(payload.representation_id.as_str())?,
        "agentRunId": payload.agent_run_id,
        "authorizationDigest": payload.authorization_digest,
        "inputRef": payload.input_ref,
        "representationId": payload.representation_id,
        "processingSpecification": processor_specification()?,
        "specDigest": payload.spec_digest,
        "canonicalSizeBytes": canonical_size,
        "canonicalSha256": canonical_sha,
        "previewSizeBytes": preview_size,
        "previewSha256": preview_sha,
        "manifest": manifest,
    });
    let metadata = serde_json::to_vec(&metadata)
        .map_err(|error| format!("encode knowledge commit metadata failed: {error}"))?;
    let body_path = output.join("commit.bin");
    let mut body = File::create(body_path.as_path())
        .map_err(|error| format!("create knowledge commit body failed: {error}"))?;
    body.write_all(
        &u32::try_from(metadata.len())
            .map_err(|_| "knowledge commit metadata is too large".to_string())?
            .to_be_bytes(),
    )
    .and_then(|_| body.write_all(metadata.as_slice()))
    .map_err(|error| format!("write knowledge commit metadata failed: {error}"))?;
    copy_file(canonical.as_path(), &mut body)?;
    if preview.is_file() {
        copy_file(preview.as_path(), &mut body)?;
    }
    body.flush()
        .map_err(|error| format!("flush knowledge commit body failed: {error}"))?;
    drop(body);
    let body_file = File::open(body_path.as_path())
        .map_err(|error| format!("open knowledge commit body failed: {error}"))?;
    let body_size = file_size(body_path.as_path())?;
    let response = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(API_TIMEOUT)
        .build()
        .map_err(|error| format!("build knowledge commit client failed: {error}"))?
        .post(format!("{}/internal/knowledge/commit", api_url()?))
        .header("X-Internal-Token", api_token()?.as_str())
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", body_size)
        .body(reqwest::blocking::Body::new(body_file))
        .send()
        .map_err(|error| format!("commit knowledge representation failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("knowledge commit returned {}", response.status()));
    }
    let value = response
        .json::<Value>()
        .map_err(|error| format!("decode knowledge commit response failed: {error}"))?;
    if value.get("representationId").and_then(Value::as_str)
        != Some(payload.representation_id.as_str())
        || value.get("specDigest").and_then(Value::as_str) != Some(payload.spec_digest.as_str())
    {
        return Err("knowledge commit response binding mismatch".to_string());
    }
    Ok(())
}

fn representation_ready(payload: &KnowledgeProcessPayloadV1) -> Result<bool, String> {
    let response = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("build knowledge status client failed: {error}"))?
        .post(format!("{}/internal/knowledge/read", api_url()?))
        .header("X-Internal-Token", api_token()?.as_str())
        .json(&json!({
            "schema": "knowledge.read.v1",
            "agentRunId": payload.agent_run_id,
            "authorizationDigest": payload.authorization_digest,
            "processingSpecification": processor_specification()?,
            "specDigest": payload.spec_digest,
            "inputs": [{"inputRef": payload.input_ref, "representationId": payload.representation_id}],
            "offset": 0,
            "limit": 1,
        }))
        .send()
        .map_err(|error| format!("query knowledge status failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("knowledge status returned {}", response.status()));
    }
    let value = response
        .json::<Value>()
        .map_err(|error| format!("decode knowledge status failed: {error}"))?;
    match value.get("disposition").and_then(Value::as_str) {
        Some("ready") => Ok(true),
        Some("pending") => Ok(false),
        _ => Err("knowledge status disposition is invalid".to_string()),
    }
}

fn processor_image() -> Result<String, String> {
    env::var("KNOWLEDGE_PROCESSOR_IMAGE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "KNOWLEDGE_PROCESSOR_IMAGE is required".to_string())
}

fn oci_runtime() -> Result<OciRuntime, String> {
    OciRuntime::from_environment()
}

fn api_url() -> Result<String, String> {
    env::var("API_INTERNAL_URL")
        .map(|value| value.trim_end_matches('/').to_string())
        .map_err(|_| "API_INTERNAL_URL is required".to_string())
}

fn api_token() -> Result<String, String> {
    env::var("INTERNAL_API_TOKEN").map_err(|_| "INTERNAL_API_TOKEN is required".to_string())
}

fn file_size(path: &Path) -> Result<u64, String> {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .map_err(|error| format!("read processor output metadata failed: {error}"))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("open processor output failed: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("read processor output failed: {error}"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("sha256:{:x}", digest.finalize()))
}

fn copy_file(path: &Path, destination: &mut File) -> Result<(), String> {
    let mut source = File::open(path)
        .map_err(|error| format!("open processor output for commit failed: {error}"))?;
    std::io::copy(&mut source, destination)
        .map(|_| ())
        .map_err(|error| format!("copy processor output into commit failed: {error}"))
}

fn response(status: u16, value: Value) -> (u16, Vec<u8>) {
    (
        status,
        serde_json::to_vec(&value)
            .unwrap_or_else(|_| b"{\"error\":\"serialization_failed\"}".to_vec()),
    )
}

fn now_ms() -> Result<i64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .map_err(|error| format!("system clock is before UNIX epoch: {error}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessorSpecOutput {
    schema: String,
    processor_id: String,
    processor_version: String,
    model_digests: BTreeMap<String, String>,
    options: ProcessingOptionsV1,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knowledge_job_identity_is_exact() {
        let representation = format!("representation:sha256:{}", "a".repeat(64));
        assert_eq!(
            knowledge_process_job_id(representation.as_str()).expect("job id"),
            format!("knowledge.process:{}", "a".repeat(64))
        );
        assert!(knowledge_process_job_id("representation:sha256:banana").is_err());
    }

    #[test]
    fn processor_device_identity_is_exact() {
        assert_eq!(
            ProcessorDevice::from_value("cpu").expect("cpu"),
            ProcessorDevice::Cpu
        );
        assert_eq!(
            ProcessorDevice::from_value("gpu:0").expect("gpu:0"),
            ProcessorDevice::Gpu0
        );
        assert!(ProcessorDevice::from_value("banana").is_err());
        assert!(ProcessorDevice::from_value(" gpu:0").is_err());
    }

    #[test]
    fn processor_uses_read_only_root_and_external_data_volumes() {
        let body = processor_container_body(
            "processor",
            "runsc",
            "sha256:test".to_string(),
            ProcessorDevice::Cpu,
        );
        assert_eq!(body["HostConfig"]["ReadonlyRootfs"], true);
        assert_eq!(body["HostConfig"]["PidsLimit"], 64);
        assert_eq!(body["HostConfig"]["Memory"], 4294967296_i64);
        assert_eq!(body["HostConfig"]["NanoCpus"], 8000000000_i64);
        assert_eq!(
            body["HostConfig"]["Mounts"],
            json!([
                {"Type":"volume","Target":"/data/input"}, {"Type":"volume","Target":"/data/output"}
            ])
        );
        assert!(body["HostConfig"].get("DeviceRequests").is_none());
        let gpu = processor_container_body(
            "processor",
            "runc",
            "sha256:test".to_string(),
            ProcessorDevice::Gpu0,
        );
        assert_eq!(
            gpu["HostConfig"]["DeviceRequests"][0]["DeviceIDs"],
            json!(["0"])
        );
    }
}
