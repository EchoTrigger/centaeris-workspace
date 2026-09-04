use std::collections::BTreeMap;

use centaeris_core::session::external_context::canonical_json_string;
use centaeris_core::tool::inputs::InputIdentityV1;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(crate) const PROCESSING_SPECIFICATION_SCHEMA: &str = "knowledge.processing_specification.v1";
const MAX_MODEL_DIGESTS: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProcessingSpecificationV1 {
    pub(crate) schema: String,
    pub(crate) processor_id: String,
    pub(crate) processor_version: String,
    pub(crate) execution_image_digest: String,
    pub(crate) model_digests: BTreeMap<String, String>,
    pub(crate) options: ProcessingOptionsV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProcessingOptionsV1 {
    pub(crate) render_dpi: u16,
    pub(crate) max_input_bytes: u64,
    pub(crate) max_rendered_pixels_per_page: u64,
    pub(crate) max_output_bytes: u64,
}

impl ProcessingSpecificationV1 {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.schema != PROCESSING_SPECIFICATION_SCHEMA {
            return Err("processing specification schema mismatch".to_string());
        }
        require_identity("processorId", self.processor_id.as_str())?;
        require_identity("processorVersion", self.processor_version.as_str())?;
        if self.processor_version.eq_ignore_ascii_case("latest") {
            return Err("processorVersion must be immutable".to_string());
        }
        validate_sha256(self.execution_image_digest.as_str(), "executionImageDigest")?;
        if self.model_digests.len() > MAX_MODEL_DIGESTS {
            return Err("processing specification has too many model digests".to_string());
        }
        for (model_id, digest) in &self.model_digests {
            require_identity("modelDigests key", model_id)?;
            validate_sha256(digest, "modelDigests value")?;
        }
        self.options.validate()
    }

    pub(crate) fn spec_digest(&self) -> Result<String, String> {
        self.validate()?;
        let value = serde_json::to_value(self)
            .map_err(|error| format!("serialize processing specification failed: {error}"))?;
        Ok(sha256(canonical_json_string(&value).as_bytes()))
    }
}

impl ProcessingOptionsV1 {
    fn validate(&self) -> Result<(), String> {
        if self.render_dpi != 220 {
            return Err("R3 renderDpi must be exactly 220".to_string());
        }
        if self.max_input_bytes == 0
            || self.max_rendered_pixels_per_page == 0
            || self.max_output_bytes == 0
        {
            return Err("processing resource limits must be positive".to_string());
        }
        if self.max_output_bytes < self.max_input_bytes {
            return Err("maxOutputBytes must be at least maxInputBytes".to_string());
        }
        Ok(())
    }
}

pub(crate) fn representation_id(
    input_identity: &InputIdentityV1,
    spec_digest: &str,
) -> Result<String, String> {
    input_identity.validate()?;
    validate_sha256(spec_digest, "specDigest")?;
    let preimage = serde_json::json!({
        "inputIdentity": input_identity,
        "specDigest": spec_digest,
    });
    Ok(format!(
        "representation:{}",
        sha256(canonical_json_string(&preimage).as_bytes())
    ))
}

fn require_identity(field: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value != value.trim() {
        Err(format!("{field} must be a non-empty canonical identity"))
    } else {
        Ok(())
    }
}

fn validate_sha256(value: &str, field: &str) -> Result<(), String> {
    let digest = value
        .strip_prefix("sha256:")
        .ok_or_else(|| format!("{field} must use sha256:<64 lowercase hex characters>"))?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(format!(
            "{field} must use sha256:<64 lowercase hex characters>"
        ));
    }
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn specification() -> ProcessingSpecificationV1 {
        ProcessingSpecificationV1 {
            schema: PROCESSING_SPECIFICATION_SCHEMA.to_string(),
            processor_id: "centaeris.document.cpu".to_string(),
            processor_version: "1.0.0".to_string(),
            execution_image_digest: format!("sha256:{}", "b".repeat(64)),
            model_digests: BTreeMap::from([(
                "PP-OCRv6_small_det".to_string(),
                format!("sha256:{}", "c".repeat(64)),
            )]),
            options: ProcessingOptionsV1 {
                render_dpi: 220,
                max_input_bytes: 64 * 1024 * 1024,
                max_rendered_pixels_per_page: 16_000_000,
                max_output_bytes: 256 * 1024 * 1024,
            },
        }
    }

    #[test]
    fn processing_digest_is_canonical_and_rejects_mutable_versions() {
        let digest = specification().spec_digest().expect("spec digest");
        assert!(digest.starts_with("sha256:"));
        let mut invalid = specification();
        invalid.processor_version = "latest".to_string();
        assert!(invalid.validate().is_err());
        let mut old_fields = serde_json::to_value(specification()).expect("spec value");
        old_fields["options"]["maxPages"] = serde_json::json!(1_000);
        assert!(serde_json::from_value::<ProcessingSpecificationV1>(old_fields).is_err());
    }
}
