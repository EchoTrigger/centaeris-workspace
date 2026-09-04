use serde::Deserialize;
use unicode_normalization::UnicodeNormalization;

use crate::agent_run_authorization::WorkspaceAgentRunAuthorization;

pub const AGENT_RUN_START_SCHEMA: &str = "workspace.agent_run.start.v1";
pub const AGENT_RUN_STEP_SCHEMA: &str = "runtime.agent_run.step.v1";
pub const AGENT_RUN_CANCEL_SCHEMA: &str = "runtime.agent_run.cancel.v1";
pub const AGENT_RUN_SUPPLEMENT_SCHEMA: &str = "runtime.agent_run.supplement.v1";
pub const AGENT_RUN_TEARDOWN_SCHEMA: &str = "runtime.agent_run.teardown.v1";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunStart {
    pub schema: String,
    pub agent_run_id: String,
    pub turn_id: String,
    pub prompt: String,
    pub agent_instructions: String,
    pub model_context_tokens: u32,
    pub model_max_output_tokens: u32,
    pub authorization_digest: String,
    pub authorization_signature: String,
    pub authorization: WorkspaceAgentRunAuthorization,
    pub tail_action: AgentRunTailAction,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum AgentRunTailAction {
    Append,
    RewriteLastUser {
        #[serde(rename = "targetMessageId")]
        target_message_id: String,
        #[serde(rename = "expectedTailMessageId")]
        expected_tail_message_id: String,
    },
}

impl AgentRunStart {
    pub fn validate(self, signing_key: &[u8]) -> Result<Self, String> {
        if self.schema != AGENT_RUN_START_SCHEMA {
            return Err("schema_mismatch".to_string());
        }
        for (name, value) in [
            ("agentRunId", self.agent_run_id.as_str()),
            ("turnId", self.turn_id.as_str()),
            ("prompt", self.prompt.as_str()),
            ("authorizationDigest", self.authorization_digest.as_str()),
            (
                "authorizationSignature",
                self.authorization_signature.as_str(),
            ),
        ] {
            if value.trim().is_empty() {
                return Err(format!("{name} is required"));
            }
        }
        if self.turn_id == self.agent_run_id {
            return Err("turnId must differ from agentRunId".to_string());
        }
        validate_agent_instructions(self.agent_instructions.as_str())?;
        self.authorization
            .validate_agent_run_binding(self.agent_run_id.as_str())?;
        if self.model_context_tokens == 0
            || self.model_max_output_tokens == 0
            || self.model_max_output_tokens >= self.model_context_tokens
        {
            return Err("model token limits are invalid".to_string());
        }
        let expected_digest = self.authorization.digest()?;
        if self.authorization_digest != expected_digest {
            return Err("workspace AgentRun authorization digest mismatch".to_string());
        }
        self.authorization
            .verify_signature(signing_key, self.authorization_signature.as_str())?;
        if let AgentRunTailAction::RewriteLastUser {
            target_message_id,
            expected_tail_message_id,
        } = &self.tail_action
        {
            if target_message_id.trim().is_empty() || expected_tail_message_id.trim().is_empty() {
                return Err("rewrite tail message identities are required".to_string());
            }
        }
        Ok(self)
    }
}

fn validate_agent_instructions(value: &str) -> Result<(), String> {
    if value != value.trim()
        || value.chars().count() > 16_000
        || value.nfc().ne(value.chars())
        || value
            .chars()
            .any(|character| character.is_control() && character != '\n' && character != '\t')
    {
        return Err("agentInstructions is invalid".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunStepRequest {
    pub schema: String,
    pub job_id: String,
    pub lease_owner: String,
    pub agent_run_start: AgentRunStart,
}

impl AgentRunStepRequest {
    pub fn validate(self, signing_key: &[u8]) -> Result<Self, String> {
        if self.schema != AGENT_RUN_STEP_SCHEMA {
            return Err("agent_run_step_schema_mismatch".to_string());
        }
        if self.job_id.trim().is_empty()
            || self.lease_owner.len() < 16
            || self.lease_owner.len() > 160
            || self.lease_owner.chars().any(char::is_control)
        {
            return Err("agent_run_step_identity_invalid".to_string());
        }
        let mut request = self;
        request.agent_run_start = request.agent_run_start.validate(signing_key)?;
        Ok(request)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunCancelRequest {
    pub schema: String,
    pub agent_run_start: AgentRunStart,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunSupplementRequest {
    pub schema: String,
    pub supplement_id: String,
    pub job_id: String,
    pub message: String,
    pub agent_run_start: AgentRunStart,
}

impl AgentRunSupplementRequest {
    pub fn validate(self, signing_key: &[u8]) -> Result<Self, String> {
        if self.schema != AGENT_RUN_SUPPLEMENT_SCHEMA {
            return Err("agent_run_supplement_schema_mismatch".to_string());
        }
        centaeris_core::session::supplement::validate_turn_supplement_id(
            self.supplement_id.as_str(),
        )
        .map_err(|error| error.to_string())?;
        centaeris_core::session::supplement::validate_turn_supplement_message(
            self.message.as_str(),
        )
        .map_err(|error| error.to_string())?;
        if self.job_id.trim().is_empty() {
            return Err("agent_run_supplement_job_id_required".to_string());
        }
        let mut request = self;
        request.agent_run_start = request.agent_run_start.validate(signing_key)?;
        if request.job_id
            != centaeris_core::session::reliability::agent_run_lifecycle_job_id(
                request.agent_run_start.agent_run_id.as_str(),
            )?
        {
            return Err("agent_run_supplement_job_id_mismatch".to_string());
        }
        Ok(request)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunTeardownRequest {
    pub schema: String,
    pub job_id: String,
    pub lease_owner: String,
    pub agent_run_start: AgentRunStart,
}

impl AgentRunTeardownRequest {
    pub fn validate(self, signing_key: &[u8]) -> Result<Self, String> {
        if self.schema != AGENT_RUN_TEARDOWN_SCHEMA {
            return Err("agent_run_teardown_schema_mismatch".to_string());
        }
        if self.job_id.trim().is_empty()
            || self.lease_owner.len() < 16
            || self.lease_owner.len() > 160
            || self.lease_owner.chars().any(char::is_control)
        {
            return Err("agent_run_teardown_identity_invalid".to_string());
        }
        let mut request = self;
        request.agent_run_start = request.agent_run_start.validate(signing_key)?;
        Ok(request)
    }
}

impl AgentRunCancelRequest {
    pub fn validate(self, signing_key: &[u8]) -> Result<Self, String> {
        if self.schema != AGENT_RUN_CANCEL_SCHEMA {
            return Err("agent_run_cancel_schema_mismatch".to_string());
        }
        let mut request = self;
        request.agent_run_start = request.agent_run_start.validate(signing_key)?;
        Ok(request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_authorization() -> serde_json::Value {
        let plugin_activation = centaeris_core::extension::build_plugin_activation_snapshot(&[])
            .expect("empty plugin activation");
        serde_json::json!({
            "schema": "workspace.agent_run_authorization.v1",
            "id": "authorization_1",
            "organizationId": "org_1",
            "workspaceId": "ws_1",
            "userId": "user_1",
            "agentId": "centaeris",
            "sessionId": "sess_1",
            "agentRunId": "agent_run_1",
            "sessionWorkspace": {
                "generation": 0,
                "snapshotSha256": "",
                "snapshotSizeBytes": 0,
                "expandedSizeBytes": 0,
                "fileCount": 0
            },
            "modelConfigRef": "model_1",
            "thinkingMode": null,
            "artifactScopeRef": "artifact_scope_1",
            "assetRefs": [],
            "messageAssetRefs": [],
            "imageCapability": "workspace_general_v1",
            "imageDigest": format!("sha256:{}", "a".repeat(64)),
            "pluginActivation": plugin_activation,
            "resources": {
                "memoryBytes": 2147483648_u64,
                "cpuMilli": 2000,
                "pidsLimit": 512,
                "dataTmpfsBytes": 4294967296_u64
            }
        })
    }

    fn valid_agent_run_start_value() -> serde_json::Value {
        let authorization =
            serde_json::from_value::<WorkspaceAgentRunAuthorization>(valid_authorization())
                .expect("authorization");
        let digest = authorization.digest().expect("digest");
        let signature = authorization
            .signature(b"test-run-authorization-signing-key")
            .expect("signature");
        serde_json::json!({
            "schema": AGENT_RUN_START_SCHEMA,
            "agentRunId": "agent_run_1",
            "turnId": "turn_1",
            "prompt": "hello",
            "agentInstructions": "Work precisely.",
            "modelContextTokens": 200000,
            "modelMaxOutputTokens": 32768,
            "authorizationDigest": digest,
            "authorizationSignature": signature,
            "authorization": authorization,
            "tailAction": {"type": "append"}
        })
    }

    fn valid_agent_run_start() -> AgentRunStart {
        serde_json::from_value(valid_agent_run_start_value()).expect("run start")
    }

    #[test]
    fn agent_run_start_requires_authorization() {
        let payload = serde_json::json!({
            "schema": AGENT_RUN_START_SCHEMA,
            "agentRunId": "agent_run_1",
            "turnId": "turn_1",
            "prompt": "hello",
            "agentInstructions": "",
            "modelContextTokens": 200000,
            "modelMaxOutputTokens": 32768
        });
        let error = serde_json::from_value::<AgentRunStart>(payload)
            .expect_err("missing authorization must fail");
        assert!(error.to_string().contains("authorizationDigest"));
    }

    #[test]
    fn agent_run_start_accepts_authorization_and_digest() {
        valid_agent_run_start()
            .validate(b"test-run-authorization-signing-key")
            .expect("validate run start");

        let mut payload = valid_agent_run_start_value();
        payload["tailAction"] = serde_json::json!({
            "type": "rewriteLastUser",
            "targetMessageId": "message:old:user",
            "expectedTailMessageId": "message:old:assistant"
        });
        let rewrite =
            serde_json::from_value::<AgentRunStart>(payload).expect("rewrite AgentRun start");
        assert!(matches!(
            rewrite.tail_action,
            AgentRunTailAction::RewriteLastUser { .. }
        ));
    }

    #[test]
    fn agent_run_start_rejects_non_canonical_agent_instructions() {
        let mut payload = valid_agent_run_start_value();
        payload["agentInstructions"] = serde_json::json!(" trailing ");
        let error = serde_json::from_value::<AgentRunStart>(payload)
            .expect("decode run start")
            .validate(b"test-run-authorization-signing-key")
            .expect_err("non-canonical Agent instructions must fail");
        assert_eq!(error, "agentInstructions is invalid");
    }

    #[test]
    fn agent_run_supplement_contract_is_strict_and_signed() {
        AgentRunSupplementRequest {
            schema: AGENT_RUN_SUPPLEMENT_SCHEMA.to_string(),
            supplement_id: "supplement-1".to_string(),
            job_id: "agent_run.lifecycle:agent_run_1".to_string(),
            message: "check the cancellation edge".to_string(),
            agent_run_start: valid_agent_run_start(),
        }
        .validate(b"test-run-authorization-signing-key")
        .expect("validate supplement request");

        let error = AgentRunSupplementRequest {
            schema: AGENT_RUN_SUPPLEMENT_SCHEMA.to_string(),
            supplement_id: "supplement-1".to_string(),
            job_id: "agent_run.lifecycle:banana".to_string(),
            message: "banana".to_string(),
            agent_run_start: valid_agent_run_start(),
        }
        .validate(b"test-run-authorization-signing-key")
        .expect_err("wrong lifecycle job identity must fail");
        assert_eq!(error, "agent_run_supplement_job_id_mismatch");

        let error = serde_json::from_value::<AgentRunSupplementRequest>(serde_json::json!({
            "schema": AGENT_RUN_SUPPLEMENT_SCHEMA,
            "supplementId": "supplement-1",
            "jobId": "agent_run.lifecycle:agent_run_1",
            "message": "banana",
            "agentRunStart": valid_agent_run_start_value(),
            "legacyQueue": true
        }))
        .expect_err("unknown supplement fields must fail");
        assert!(error.to_string().contains("unknown field"));
    }
}
