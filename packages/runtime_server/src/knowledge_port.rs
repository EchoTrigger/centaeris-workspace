use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use centaeris_core::execution::ExecutionCancellationProbe;
use centaeris_core::session::external_context::{
    ExternalContextObject, ExternalContextObjectPayload, ExternalContextPointer,
};
use centaeris_core::session::reliability::{
    RuntimeBackoffPolicy, RuntimeJobRecord, RuntimeJobStatus, RuntimeJobStorePort,
    ScheduleRuntimeJobRequest,
};
use centaeris_core::tool::inputs::{InputIdentityV1, ResolvedInput};
use centaeris_core::tool::knowledge::{CitationV1, KnowledgeLocatorV1};
use centaeris_core::tool::layer::{
    LocalToolOutput, ResolvedInputReadRequest, ResolvedInputReaderPort, ToolExecutionFact,
};
use centaeris_core::tool::{ToolErrorInfo, ToolFailureKind};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::knowledge_processing::{
    knowledge_process_job_id, processor_specification, KnowledgeProcessPayloadV1,
    KNOWLEDGE_PROCESS_JOB_KIND,
};
use crate::knowledge_types::{representation_id, ProcessingSpecificationV1};

const KNOWLEDGE_PROVIDER_ID: &str = "centaeris.knowledge";

pub(crate) struct WorkspaceKnowledgePort {
    api_url: String,
    api_token: String,
    agent_run_id: String,
    authorization_digest: String,
    session_id: String,
    jobs: Arc<dyn RuntimeJobStorePort + Send + Sync>,
    client: reqwest::blocking::Client,
}

impl WorkspaceKnowledgePort {
    pub(crate) fn new(
        api_url: String,
        api_token: String,
        agent_run_id: String,
        authorization_digest: String,
        session_id: String,
        jobs: Arc<dyn RuntimeJobStorePort + Send + Sync>,
    ) -> Result<Self, String> {
        Ok(Self {
            api_url,
            api_token,
            agent_run_id,
            authorization_digest,
            session_id,
            jobs,
            client: reqwest::blocking::Client::builder()
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|error| format!("build knowledge API client failed: {error}"))?,
        })
    }

    fn read_response(
        &self,
        request: &ResolvedInputReadRequest,
        specification: &ProcessingSpecificationV1,
        spec_digest: &str,
    ) -> Result<Value, KnowledgePortError> {
        let inputs = request
            .inputs
            .iter()
            .map(|input| {
                let identity = resolved_identity(input)?;
                Ok(json!({
                    "inputRef": input.input_ref,
                    "representationId": representation_id(&identity, spec_digest)?,
                }))
            })
            .collect::<Result<Vec<_>, String>>()
            .map_err(|error| {
                eprintln!("knowledge read input identity invalid: {error}");
                KnowledgePortError::invalid_input("knowledge_input_invalid")
            })?;
        self.post(
            "/internal/knowledge/read",
            json!({
                "schema": "knowledge.read.v1",
                "agentRunId": self.agent_run_id,
                "authorizationDigest": self.authorization_digest,
                "processingSpecification": specification,
                "specDigest": spec_digest,
                "inputs": inputs,
                "offset": request.offset,
                "limit": request.limit,
            }),
            None,
        )
    }

    fn post(
        &self,
        path: &str,
        body: Value,
        cancellation_probe: Option<&ExecutionCancellationProbe>,
    ) -> Result<Value, KnowledgePortError> {
        poll_cancellation(cancellation_probe)
            .map_err(|_| KnowledgePortError::cancelled("knowledge_request_cancelled"))?;
        let response = self
            .client
            .post(format!("{}{}", self.api_url, path))
            .header("X-Internal-Token", self.api_token.as_str())
            .json(&body)
            .send()
            .map_err(KnowledgePortError::transport)?;
        poll_cancellation(cancellation_probe)
            .map_err(|_| KnowledgePortError::cancelled("knowledge_request_cancelled"))?;
        let status = response.status();
        let value = response.json::<Value>().map_err(|error| {
            eprintln!("decode knowledge API response failed: {error}");
            KnowledgePortError::provider("knowledge_api_response_invalid")
        })?;
        if !status.is_success() {
            return Err(KnowledgePortError::http(
                status.as_u16(),
                value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("knowledge_api_error"),
            ));
        }
        Ok(value)
    }

    fn schedule_missing(
        &self,
        missing: &[Value],
        inputs: &[ProcessInput],
        spec_digest: &str,
        cancellation_probe: Option<&ExecutionCancellationProbe>,
    ) -> Result<(), KnowledgePortError> {
        let by_ref = inputs
            .iter()
            .map(|input| (input.input_ref.as_str(), input))
            .collect::<HashMap<_, _>>();
        for item in missing {
            poll_cancellation(cancellation_probe)
                .map_err(|_| KnowledgePortError::cancelled("knowledge_request_cancelled"))?;
            let input_ref = required_string(item, "inputRef").map_err(|error| {
                eprintln!("decode knowledge missing inputRef failed: {error}");
                KnowledgePortError::provider("knowledge_provider_response_invalid")
            })?;
            let representation = required_string(item, "representationId").map_err(|error| {
                eprintln!("decode knowledge missing representationId failed: {error}");
                KnowledgePortError::provider("knowledge_provider_response_invalid")
            })?;
            let input = by_ref.get(input_ref).ok_or_else(|| {
                KnowledgePortError::provider("knowledge_provider_response_invalid")
            })?;
            if input.representation_id != representation {
                return Err(KnowledgePortError::provider(
                    "knowledge_provider_response_invalid",
                ));
            }
            let now = now_ms().map_err(|error| {
                eprintln!("knowledge scheduling clock failed: {error}");
                KnowledgePortError::unavailable("knowledge_scheduler_unavailable")
            })?;
            let job_id = knowledge_process_job_id(representation).map_err(|error| {
                eprintln!("derive knowledge process job identity failed: {error}");
                KnowledgePortError::provider("knowledge_provider_response_invalid")
            })?;
            if let Some(existing) = self
                .jobs
                .get_runtime_job(job_id.as_str())
                .map_err(|error| {
                    eprintln!("load knowledge processing job failed: {error}");
                    KnowledgePortError::unavailable("knowledge_job_store_unavailable")
                })?
            {
                validate_existing_processing_job(&existing, job_id.as_str())?;
                continue;
            }
            let payload = KnowledgeProcessPayloadV1 {
                schema: "knowledge.process.payload.v1".to_string(),
                agent_run_id: self.agent_run_id.clone(),
                authorization_digest: self.authorization_digest.clone(),
                session_id: self.session_id.clone(),
                input_ref: input.input_ref.clone(),
                display_name: input.display_name.clone(),
                content_type: input.content_type.clone(),
                size_bytes: input.size_bytes,
                source_version: input.identity.generation.to_string(),
                input_identity: input.identity.clone(),
                representation_id: input.representation_id.clone(),
                spec_digest: spec_digest.to_string(),
            };
            let scheduled = match self.jobs.schedule_runtime_job(ScheduleRuntimeJobRequest {
                job: RuntimeJobRecord {
                    job_id: job_id.clone(),
                    job_kind: KNOWLEDGE_PROCESS_JOB_KIND.to_string(),
                    status: RuntimeJobStatus::Queued,
                    run_at_ms: now,
                    lease_owner: None,
                    lease_expires_at_ms: None,
                    heartbeat_at_ms: None,
                    retry_count: 0,
                    max_retries: 3,
                    backoff_policy: RuntimeBackoffPolicy::default(),
                    idempotency_key: job_id.clone(),
                    session_id: Some(self.session_id.clone()),
                    branch_id: None,
                    checkpoint_id: None,
                    payload_ref: Some(payload.encode().map_err(|error| {
                        eprintln!("encode knowledge process payload failed: {error}");
                        KnowledgePortError::provider("knowledge_process_payload_invalid")
                    })?),
                    output_refs: vec![],
                    last_error: None,
                    created_at_ms: now,
                    updated_at_ms: now,
                },
            }) {
                Ok(value) => value,
                Err(error) => {
                    let existing = self
                        .jobs
                        .get_runtime_job(job_id.as_str())
                        .map_err(|load_error| {
                            eprintln!(
                                "schedule knowledge processing job failed: {error}; reload failed: {load_error}"
                            );
                            KnowledgePortError::unavailable("knowledge_job_store_unavailable")
                        })?;
                    if let Some(existing) = existing {
                        validate_existing_processing_job(&existing, job_id.as_str())?;
                        continue;
                    }
                    eprintln!("schedule knowledge processing job failed: {error}");
                    return Err(KnowledgePortError::unavailable(
                        "knowledge_job_store_unavailable",
                    ));
                }
            };
            if scheduled.job.status.is_terminal() {
                eprintln!(
                    "knowledge processing ended without its representation: jobId={} status={:?}",
                    scheduled.job.job_id, scheduled.job.status
                );
                return Err(KnowledgePortError::terminal("knowledge_processing_failed"));
            }
        }
        Ok(())
    }

    fn pending_output(
        &self,
        tool_name: &str,
        missing: &[Value],
        poll_args: Value,
    ) -> Result<LocalToolOutput, String> {
        let mut digest = Sha256::new();
        for value in missing {
            digest.update(required_string(value, "representationId")?.as_bytes());
            digest.update([0]);
        }
        let poll_key = format!("sha256:{:x}", digest.finalize());
        Ok(LocalToolOutput::success(
            "Authorized document processing is still in progress.",
            json!({
                "schema": "knowledge.pending.v1",
                "dynamicTool": true,
                "providerId": KNOWLEDGE_PROVIDER_ID,
                "toolName": tool_name,
                "schemaHash": null,
                "result": {
                    "providerPolling": {
                        "status": "pending",
                        "pollKey": poll_key,
                        "pollArgs": poll_args,
                        // Match the scheduler tick while preserving the existing 20-minute ceiling.
                        "nextPollAtMs": now_ms()?.saturating_add(1_000),
                        "leaseMs": 30_000,
                        "maxPollAttempts": 1_200,
                        "idempotencyKey": format!("knowledge.poll:{}", poll_key),
                    }
                }
            }),
        ))
    }

    fn ready_output(
        &self,
        tool_name: &str,
        tool_call_id: &str,
        response: Value,
        identities: &HashMap<String, InputIdentityV1>,
    ) -> Result<LocalToolOutput, String> {
        let values = match tool_name {
            "read" => response
                .get("items")
                .and_then(Value::as_array)
                .ok_or_else(|| "knowledge read result items are missing".to_string())?,
            "search_knowledge" => response
                .get("hits")
                .and_then(Value::as_array)
                .ok_or_else(|| "knowledge search result hits are missing".to_string())?,
            _ => return Err("unsupported knowledge tool name".to_string()),
        };
        let citations = values
            .iter()
            .filter_map(|value| {
                match knowledge_citation(
                    value,
                    identities,
                    tool_name,
                    tool_call_id,
                    self.session_id.as_str(),
                    self.agent_run_id.as_str(),
                ) {
                    Ok(Some(citation)) => Some(Ok(citation)),
                    Ok(None) => None,
                    Err(error) => Some(Err(error)),
                }
            })
            .collect::<Result<Vec<_>, String>>()?;
        let content = if tool_name == "read" {
            if values.len() == 1 {
                required_string(&values[0], "content")?.to_string()
            } else {
                values
                    .iter()
                    .map(|value| {
                        Ok(format!(
                            "## {}\n\n{}",
                            required_string(value, "displayName")?,
                            required_string(value, "content")?
                        ))
                    })
                    .collect::<Result<Vec<_>, String>>()?
                    .join("\n\n")
            }
        } else if values.is_empty() {
            "No authorized knowledge matched the query.".to_string()
        } else {
            values
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    let locator = serde_json::from_value::<KnowledgeLocatorV1>(
                        value
                            .get("locator")
                            .cloned()
                            .ok_or_else(|| "knowledge search locator is missing".to_string())?,
                    )
                    .map_err(|error| format!("decode knowledge search locator failed: {error}"))?;
                    Ok(format!(
                        "[{}] {} · inputRef={} · {}\n{}",
                        index + 1,
                        required_string(value, "displayName")?,
                        required_string(value, "inputRef")?,
                        knowledge_locator_label(&locator),
                        required_string(value, "content")?
                    ))
                })
                .collect::<Result<Vec<_>, String>>()?
                .join("\n\n")
        };
        let updated_at_ms = now_ms()?;
        let preimage = serde_json::to_vec(&json!({
            "toolName": tool_name,
            "response": response,
        }))
        .map_err(|error| format!("encode knowledge result identity failed: {error}"))?;
        let object_id = format!("external_context:knowledge_{:x}", Sha256::digest(preimage));
        let object_kind = if tool_name == "read" {
            "knowledgeRead"
        } else {
            "knowledgeSearch"
        };
        let object = ExternalContextObject {
            schema_version: "external_context.v1".to_string(),
            object_id: object_id.clone(),
            object_kind: object_kind.to_string(),
            source_provider_id: KNOWLEDGE_PROVIDER_ID.to_string(),
            source_tool_name: tool_name.to_string(),
            title: if tool_name == "read" {
                "Authorized document read".to_string()
            } else {
                "Authorized knowledge search".to_string()
            },
            content: content.clone(),
            metadata: json!({
                "schema": "knowledge.external_metadata.v1",
                "knowledgeCitations": citations,
            }),
            updated_at_ms,
        };
        let external = ExternalContextObjectPayload {
            mode: "externalObject".to_string(),
            pointer: ExternalContextPointer {
                object_id,
                object_kind: object_kind.to_string(),
                source: KNOWLEDGE_PROVIDER_ID.to_string(),
                recency: "currentRun".to_string(),
                trust: "authorized".to_string(),
                score: None,
                reason: "current AgentRun authorized knowledge".to_string(),
                updated_at_ms,
            },
            object,
        };
        let mut details = if tool_name == "read" && values.len() == 1 {
            values[0].clone()
        } else {
            response
        };
        let details = details
            .as_object_mut()
            .ok_or_else(|| "knowledge result must be an object".to_string())?;
        details.insert("dynamicTool".to_string(), Value::Bool(true));
        details.insert(
            "providerId".to_string(),
            Value::String(KNOWLEDGE_PROVIDER_ID.to_string()),
        );
        details.insert("toolName".to_string(), Value::String(tool_name.to_string()));
        details.insert(
            "knowledgeCitations".to_string(),
            Value::Array(citations.clone()),
        );
        details.insert(
            "result".to_string(),
            json!({ "externalObject": external.to_json_value()? }),
        );
        let facts = citations
            .iter()
            .cloned()
            .map(ToolExecutionFact::CitationRecorded)
            .collect();
        Ok(LocalToolOutput::success(content, Value::Object(details.clone())).with_facts(facts))
    }
}

fn knowledge_locator_label(locator: &KnowledgeLocatorV1) -> String {
    match locator {
        KnowledgeLocatorV1::TextSpan {
            page_start,
            page_end,
            start_line,
            end_line,
            ..
        } => match (page_start, page_end) {
            (Some(start), Some(end)) if start == end => {
                format!("page {start}, lines {start_line}-{end_line}")
            }
            (Some(start), Some(end)) => {
                format!("pages {start}-{end}, lines {start_line}-{end_line}")
            }
            _ => format!("lines {start_line}-{end_line}"),
        },
        KnowledgeLocatorV1::PageRegion { page, .. } => format!("page {page}"),
        KnowledgeLocatorV1::TableCell {
            page,
            table_id,
            start_row,
            end_row,
            start_column,
            end_column,
        } => format!(
            "page {page}, table {table_id}, rows {start_row}-{end_row}, columns {start_column}-{end_column}"
        ),
    }
}

fn validate_existing_processing_job(
    job: &RuntimeJobRecord,
    expected_job_id: &str,
) -> Result<(), KnowledgePortError> {
    if job.job_id != expected_job_id
        || job.job_kind != KNOWLEDGE_PROCESS_JOB_KIND
        || job.idempotency_key != expected_job_id
    {
        return Err(KnowledgePortError::provider(
            "knowledge_processing_job_identity_mismatch",
        ));
    }
    if job.status.is_terminal() {
        eprintln!(
            "knowledge processing job cannot produce its missing representation: jobId={} status={:?}",
            job.job_id, job.status
        );
        return Err(KnowledgePortError::terminal("knowledge_processing_failed"));
    }
    Ok(())
}

impl ResolvedInputReaderPort for WorkspaceKnowledgePort {
    fn read(&self, request: ResolvedInputReadRequest) -> Result<LocalToolOutput, String> {
        let specification = match processor_specification() {
            Ok(value) => value,
            Err(error) => {
                eprintln!("load knowledge processor specification failed: {error}");
                return Ok(
                    KnowledgePortError::unavailable("knowledge_processor_unavailable")
                        .output("read"),
                );
            }
        };
        let spec_digest = match specification.spec_digest() {
            Ok(value) => value,
            Err(error) => {
                eprintln!("digest knowledge processor specification failed: {error}");
                return Ok(
                    KnowledgePortError::provider("knowledge_processor_spec_invalid").output("read"),
                );
            }
        };
        let process_inputs = request
            .inputs
            .iter()
            .map(|input| ProcessInput::from_resolved(input, spec_digest.as_str()))
            .collect::<Result<Vec<_>, _>>();
        let process_inputs = match process_inputs {
            Ok(value) => value,
            Err(error) => {
                eprintln!("resolve knowledge input identity failed: {error}");
                return Ok(
                    KnowledgePortError::invalid_input("knowledge_input_invalid").output("read")
                );
            }
        };
        let identities = process_inputs
            .iter()
            .map(|input| (input.input_ref.clone(), input.identity.clone()))
            .collect::<HashMap<_, _>>();
        let response = match self.read_response(&request, &specification, spec_digest.as_str()) {
            Ok(value) => value,
            Err(error) => return Ok(error.output("read")),
        };
        let output = (|| -> Result<LocalToolOutput, String> {
            match required_string(&response, "disposition")? {
                "pending" => {
                    let missing = response
                        .get("missing")
                        .and_then(Value::as_array)
                        .ok_or_else(|| "knowledge read pending result is invalid".to_string())?;
                    if let Err(error) = self.schedule_missing(
                        missing,
                        process_inputs.as_slice(),
                        spec_digest.as_str(),
                        None,
                    ) {
                        return Ok(error.output("read"));
                    }
                    self.pending_output("read", missing, request.poll_args)
                }
                "ready" => {
                    self.ready_output("read", request.tool_call_id.as_str(), response, &identities)
                }
                _ => Err("knowledge read disposition is unsupported".to_string()),
            }
        })();
        match output {
            Ok(value) => Ok(value),
            Err(error) => {
                eprintln!("build knowledge read output failed: {error}");
                Ok(
                    KnowledgePortError::provider("knowledge_provider_response_invalid")
                        .output("read"),
                )
            }
        }
    }
}

struct ProcessInput {
    input_ref: String,
    display_name: String,
    content_type: String,
    size_bytes: u64,
    identity: InputIdentityV1,
    representation_id: String,
}

impl ProcessInput {
    fn from_resolved(input: &ResolvedInput, spec_digest: &str) -> Result<Self, String> {
        let identity = resolved_identity(input)?;
        let representation_id = representation_id(&identity, spec_digest)?;
        Ok(Self {
            input_ref: input.input_ref.clone(),
            display_name: input.display_name.clone(),
            content_type: input.content_type.clone(),
            size_bytes: input.size_bytes,
            identity,
            representation_id,
        })
    }
}

fn resolved_identity(input: &ResolvedInput) -> Result<InputIdentityV1, String> {
    let generation = input
        .source_version
        .parse::<u64>()
        .map_err(|_| "resolved input sourceVersion must be an integer generation".to_string())?;
    Ok(InputIdentityV1 {
        owner_kind: input.owner_kind.clone(),
        owner_id: input.object_ref.clone(),
        generation,
        sha256: input.sha256.clone(),
    })
}

fn knowledge_citation(
    value: &Value,
    identities: &HashMap<String, InputIdentityV1>,
    tool_name: &str,
    tool_call_id: &str,
    session_id: &str,
    agent_run_id: &str,
) -> Result<Option<Value>, String> {
    if value.get("citationAllowed").and_then(Value::as_bool) != Some(true)
        || value
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .is_empty()
    {
        return Ok(None);
    }
    let input_ref = required_string(value, "inputRef")?;
    let identity = identities
        .get(input_ref)
        .ok_or_else(|| "knowledge result returned an unknown inputRef".to_string())?
        .clone();
    let locator = serde_json::from_value::<KnowledgeLocatorV1>(
        value
            .get("locator")
            .cloned()
            .ok_or_else(|| "knowledge result locator is missing".to_string())?,
    )
    .map_err(|error| format!("decode knowledge locator failed: {error}"))?;
    let citation = CitationV1::new(
        identity.clone(),
        required_string(value, "representationId")?.to_string(),
        required_string(value, "specDigest")?.to_string(),
        locator.clone(),
        required_string(value, "evidenceSha256")?.to_string(),
        tool_name.to_string(),
        tool_call_id.to_string(),
        session_id.to_string(),
        agent_run_id.to_string(),
    )?;
    citation.validate()?;
    Ok(Some(json!({
        "citationId": citation.citation_id,
        "inputRef": input_ref,
        "ownerRef": required_string(value, "ownerRef")?,
        "ownerKind": required_string(value, "ownerKind")?,
        "displayName": required_string(value, "displayName")?,
        "evidenceKind": required_string(value, "evidenceKind")?,
        "ownerSha256": identity.sha256,
        "ownerGeneration": identity.generation,
        "representationId": citation.representation_id,
        "specDigest": citation.spec_digest,
        "evidenceSha256": citation.evidence_sha256,
        "sourceToolName": tool_name,
        "sourceToolCallId": tool_call_id,
        "locator": locator,
    })))
}

fn required_string<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("knowledge result {name} is missing"))
}

fn poll_cancellation(
    cancellation_probe: Option<&ExecutionCancellationProbe>,
) -> Result<(), String> {
    if let Some(reason) = cancellation_probe
        .map(|probe| probe())
        .transpose()?
        .flatten()
    {
        return Err(format!("dynamic tool execution cancelled: {reason}"));
    }
    Ok(())
}

#[derive(Debug)]
struct KnowledgePortError {
    code: String,
    error: ToolErrorInfo,
}

impl KnowledgePortError {
    fn new(
        code: impl Into<String>,
        kind: ToolFailureKind,
        model_message: impl Into<String>,
        user_message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        let code = code.into();
        Self {
            error: ToolErrorInfo::new(kind, model_message, user_message)
                .with_diagnostic(code.clone())
                .with_retryable(retryable),
            code,
        }
    }

    fn invalid_input(code: impl Into<String>) -> Self {
        Self::new(
            code,
            ToolFailureKind::InvalidInput,
            "knowledge tool input is invalid; revise the tool arguments and retry",
            "Invalid knowledge input",
            false,
        )
    }

    fn cancelled(code: impl Into<String>) -> Self {
        Self::new(
            code,
            ToolFailureKind::Cancelled,
            "knowledge tool execution was cancelled before completion",
            "Knowledge request cancelled",
            false,
        )
    }

    fn unavailable(code: impl Into<String>) -> Self {
        Self::new(
            code,
            ToolFailureKind::HostUnavailable,
            "knowledge service is temporarily unavailable; retry this tool",
            "Knowledge service unavailable",
            true,
        )
    }

    fn timed_out(code: impl Into<String>) -> Self {
        Self::new(
            code,
            ToolFailureKind::TimedOut,
            "knowledge service timed out; retry this tool",
            "Knowledge request timed out",
            true,
        )
    }

    fn provider(code: impl Into<String>) -> Self {
        Self::new(
            code,
            ToolFailureKind::ProviderError,
            "knowledge provider returned an invalid response",
            "Knowledge provider failed",
            false,
        )
    }

    fn terminal(code: impl Into<String>) -> Self {
        Self::new(
            code,
            ToolFailureKind::ProviderError,
            "authorized document processing failed; try another supported file or upload it again",
            "Document processing failed",
            false,
        )
    }

    fn transport(error: reqwest::Error) -> Self {
        eprintln!("knowledge API request failed: {error}");
        if error.is_timeout() {
            Self::timed_out("knowledge_api_timeout")
        } else {
            Self::unavailable("knowledge_api_unavailable")
        }
    }

    fn http(status: u16, code: &str) -> Self {
        eprintln!("knowledge API returned status={status} code={code:?}");
        match status {
            408 => Self::timed_out("knowledge_api_timeout"),
            425 | 429 | 500..=599 => Self::unavailable("knowledge_api_unavailable"),
            400 | 422 => Self::invalid_input("knowledge_api_request_rejected"),
            404 => Self::provider("knowledge_api_endpoint_missing"),
            401 | 403 => Self::new(
                "knowledge_api_permission_denied",
                ToolFailureKind::PermissionDenied,
                "knowledge access was denied",
                "Knowledge access denied",
                false,
            ),
            409 if code == "knowledge_processing_failed" => {
                Self::terminal("knowledge_processing_failed")
            }
            _ => Self::provider("knowledge_api_request_failed"),
        }
    }

    fn output(self, tool_name: &str) -> LocalToolOutput {
        let content = self.error.model_message.clone();
        LocalToolOutput::failure(
            content,
            json!({
                "schema": "knowledge.error.v1",
                "dynamicTool": true,
                "providerId": KNOWLEDGE_PROVIDER_ID,
                "toolName": tool_name,
                "errorCode": self.code,
            }),
            self.error,
        )
    }
}

fn now_ms() -> Result<i64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .map_err(|error| format!("system clock is before UNIX epoch: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use centaeris_runtime_sqlite::SqliteRuntimeStore;

    #[test]
    fn port_construction_does_not_load_the_processor_specification() {
        let database_path = std::env::temp_dir().join(format!(
            "centaeris-knowledge-port-{}-{}.sqlite",
            std::process::id(),
            now_ms().expect("timestamp")
        ));
        let jobs: Arc<dyn RuntimeJobStorePort + Send + Sync> =
            Arc::new(SqliteRuntimeStore::new(database_path.as_path()).expect("runtime job store"));

        let port = WorkspaceKnowledgePort::new(
            "http://api.invalid".to_string(),
            "token".to_string(),
            "agent_run_1".to_string(),
            format!("sha256:{}", "a".repeat(64)),
            "session_1".to_string(),
            jobs,
        )
        .expect("construct Knowledge port without inspecting a processor image");

        drop(port);
        for suffix in ["", "-shm", "-wal"] {
            let _ = std::fs::remove_file(format!("{}{}", database_path.display(), suffix));
        }
    }

    #[test]
    fn pending_knowledge_poll_uses_short_cadence_without_shortening_its_ceiling() {
        let database_path = std::env::temp_dir().join(format!(
            "centaeris-knowledge-poll-{}-{}.sqlite",
            std::process::id(),
            now_ms().expect("timestamp")
        ));
        let jobs: Arc<dyn RuntimeJobStorePort + Send + Sync> =
            Arc::new(SqliteRuntimeStore::new(database_path.as_path()).expect("runtime job store"));
        let port = WorkspaceKnowledgePort::new(
            "http://api.invalid".to_string(),
            "token".to_string(),
            "agent_run_1".to_string(),
            format!("sha256:{}", "a".repeat(64)),
            "session_1".to_string(),
            jobs,
        )
        .expect("construct Knowledge port");
        let before = now_ms().expect("timestamp");
        let output = port
            .pending_output(
                "read",
                &[json!({"representationId": format!("representation:sha256:{}", "b".repeat(64))})],
                json!({}),
            )
            .expect("pending output");
        let after = now_ms().expect("timestamp");
        let polling = output
            .details
            .pointer("/result/providerPolling")
            .expect("provider polling details");
        let next_poll_at_ms = polling["nextPollAtMs"].as_i64().expect("next poll time");

        assert!((before + 1_000..=after + 1_000).contains(&next_poll_at_ms));
        assert_eq!(polling["maxPollAttempts"], 1_200);

        drop(port);
        for suffix in ["", "-shm", "-wal"] {
            let _ = std::fs::remove_file(format!("{}{}", database_path.display(), suffix));
        }
    }

    #[test]
    fn knowledge_failures_keep_retryability_structured_and_codes_bounded() {
        for (status, expected_kind, expected_retryable, expected_code) in [
            (
                503,
                ToolFailureKind::HostUnavailable,
                true,
                "knowledge_api_unavailable",
            ),
            (
                408,
                ToolFailureKind::TimedOut,
                true,
                "knowledge_api_timeout",
            ),
            (
                400,
                ToolFailureKind::InvalidInput,
                false,
                "knowledge_api_request_rejected",
            ),
            (
                409,
                ToolFailureKind::ProviderError,
                false,
                "knowledge_processing_failed",
            ),
        ] {
            let error = KnowledgePortError::http(status, "knowledge_processing_failed");
            assert_eq!(error.error.kind, expected_kind);
            assert_eq!(error.error.retryable, expected_retryable);
            assert_eq!(error.code, expected_code);
            assert_eq!(error.error.diagnostic_id.as_deref(), Some(expected_code));
        }
    }

    #[test]
    fn terminal_processing_job_is_a_permanent_tool_failure() {
        let digest = "a".repeat(64);
        let job_id = format!("knowledge.process:{digest}");
        let job = RuntimeJobRecord {
            job_id: job_id.clone(),
            job_kind: KNOWLEDGE_PROCESS_JOB_KIND.to_string(),
            status: RuntimeJobStatus::Failed,
            run_at_ms: 1,
            lease_owner: None,
            lease_expires_at_ms: None,
            heartbeat_at_ms: None,
            retry_count: 1,
            max_retries: 3,
            backoff_policy: RuntimeBackoffPolicy::default(),
            idempotency_key: job_id.clone(),
            session_id: Some("session_1".to_string()),
            branch_id: None,
            checkpoint_id: None,
            payload_ref: None,
            output_refs: Vec::new(),
            last_error: Some("knowledge_processing_failed".to_string()),
            created_at_ms: 1,
            updated_at_ms: 2,
        };
        let error = validate_existing_processing_job(&job, job_id.as_str())
            .expect_err("terminal knowledge job");

        assert_eq!(error.error.kind, ToolFailureKind::ProviderError);
        assert!(!error.error.retryable);
        assert_eq!(error.code, "knowledge_processing_failed");
    }

    #[test]
    fn knowledge_citation_keeps_the_source_tool_identity() {
        let input_identity = InputIdentityV1 {
            owner_kind: "sourceObject".to_string(),
            owner_id: "source_1".to_string(),
            generation: 1,
            sha256: format!("sha256:{}", "a".repeat(64)),
        };
        let citation = knowledge_citation(
            &json!({
                "citationAllowed": true,
                "content": "evidence",
                "inputRef": "input_1",
                "ownerRef": "source_1",
                "ownerKind": "sourceObject",
                "displayName": "source.pdf",
                "evidenceKind": "workspaceSource",
                "representationId": format!("representation:sha256:{}", "b".repeat(64)),
                "specDigest": format!("sha256:{}", "c".repeat(64)),
                "evidenceSha256": format!("sha256:{}", "d".repeat(64)),
                "locator": {
                    "kind": "textSpan",
                    "pageStart": 1,
                    "pageEnd": 1,
                    "startByte": 0,
                    "endByte": 8,
                    "startLine": 1,
                    "endLine": 1
                }
            }),
            &HashMap::from([("input_1".to_string(), input_identity)]),
            "search_knowledge",
            "call_search",
            "session_1",
            "agent_run_1",
        )
        .expect("citation")
        .expect("citation allowed");
        assert_eq!(citation["sourceToolName"], "search_knowledge");
        assert_eq!(citation["sourceToolCallId"], "call_search");
    }
}
