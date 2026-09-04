use centaeris_core::tool::inputs::{
    DeclaredInput, DeferredInputResolutionError, DeferredInputResolutionFailureKind,
    DeferredInputResolverPort, ResolvedInput,
};
use serde::{Deserialize, Serialize};

const RESOLVE_DEFERRED_INPUT_SCHEMA: &str = "runtime.deferred_input.resolve.v1";

pub struct ApiDeferredInputResolver {
    api_internal_url: String,
    internal_api_token: String,
    agent_run_id: String,
    authorization_digest: String,
    client: reqwest::blocking::Client,
}

impl ApiDeferredInputResolver {
    pub fn new(
        api_internal_url: String,
        internal_api_token: String,
        agent_run_id: String,
        authorization_digest: String,
    ) -> Self {
        Self {
            api_internal_url,
            internal_api_token,
            agent_run_id,
            authorization_digest,
            client: reqwest::blocking::Client::new(),
        }
    }
}

impl DeferredInputResolverPort for ApiDeferredInputResolver {
    fn resolve_deferred_input(
        &self,
        reference: &DeclaredInput,
    ) -> Result<ResolvedInput, DeferredInputResolutionError> {
        let url = format!(
            "{}/internal/agent-runs/resolve-input",
            self.api_internal_url.trim_end_matches('/')
        );
        let response = self
            .client
            .post(url)
            .header("Content-Type", "application/json")
            .header("X-Internal-Token", self.internal_api_token.as_str())
            .json(&ResolveDeferredInputRequest {
                schema: RESOLVE_DEFERRED_INPUT_SCHEMA,
                agent_run_id: self.agent_run_id.as_str(),
                authorization_digest: self.authorization_digest.as_str(),
                input_ref: reference.input_ref.as_str(),
            })
            .send()
            .map_err(|error| {
                host_error(format!("request deferred input resolution failed: {error}"))
            })?;
        let status = response.status();
        let body = response.text().map_err(|error| {
            host_error(format!("read deferred input resolution failed: {error}"))
        })?;
        if !status.is_success() {
            let kind = serde_json::from_str::<ResolveDeferredInputFailure>(body.as_str())
                .ok()
                .and_then(|failure| match failure.error.as_str() {
                    "asset_removed" => Some(DeferredInputResolutionFailureKind::AssetRemoved),
                    "access_revoked" => Some(DeferredInputResolutionFailureKind::AccessRevoked),
                    "source_deleted" => Some(DeferredInputResolutionFailureKind::SourceDeleted),
                    "stale_generation" => Some(DeferredInputResolutionFailureKind::StaleGeneration),
                    "asset_unavailable" => {
                        Some(DeferredInputResolutionFailureKind::AssetUnavailable)
                    }
                    _ => None,
                })
                .unwrap_or(DeferredInputResolutionFailureKind::HostUnavailable);
            return Err(DeferredInputResolutionError::new(
                kind,
                format!("deferred input resolution returned {}", status.as_u16()),
            ));
        }
        let payload = serde_json::from_str::<ResolveDeferredInputResponse>(body.as_str()).map_err(
            |error| host_error(format!("decode deferred input resolution failed: {error}")),
        )?;
        if payload.schema != RESOLVE_DEFERRED_INPUT_SCHEMA {
            return Err(host_error("deferred input resolution schema mismatch"));
        }
        Ok(payload.resolved_input)
    }
}

fn host_error(message: impl Into<String>) -> DeferredInputResolutionError {
    DeferredInputResolutionError::new(DeferredInputResolutionFailureKind::HostUnavailable, message)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolveDeferredInputRequest<'a> {
    schema: &'static str,
    agent_run_id: &'a str,
    authorization_digest: &'a str,
    input_ref: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolveDeferredInputResponse {
    schema: String,
    resolved_input: ResolvedInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveDeferredInputFailure {
    error: String,
}
