use std::collections::HashSet;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use centaeris_core::extension::{
    load_mcp_servers_file, McpServerDeclarationV1, McpToolDeclarationV1, McpTransportV1,
    PluginActivationSnapshotV1,
};
use centaeris_core::tool::layer::DynamicToolProvider;
use centaeris_core::tool::limits::ToolContractBudget;
use centaeris_core::tool::DynamicToolContract;
use centaeris_mcp::{
    bounded_stdio_transport, connect_mcp_server_transport, connect_streamable_http_mcp_server,
    lazy_mcp_server_binding, valid_bearer_token, McpConnectError, McpServerConnector,
};
use serde::{Deserialize, Serialize};

use crate::docker_execution_host::DockerExecutionHostRunner;
use crate::skill_projection::{verified_plugin_package_roots_at, PLUGIN_CATALOG_ROOT};

pub(crate) struct McpBindings {
    pub contracts: Vec<DynamicToolContract>,
    pub providers: Vec<Arc<dyn DynamicToolProvider + Send + Sync>>,
}

pub(crate) struct PreparedMcpServers {
    servers: Vec<(String, McpServerDeclarationV1)>,
    credential_resolver: Arc<McpCredentialResolver>,
}

pub(crate) struct McpStartupMetrics {
    pub server_count: usize,
    pub credential_count: usize,
    pub connection_count: usize,
    pub credential_resolve_ms: u128,
    pub discovery_ms: u128,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceMcpCatalogResult {
    pub schema: &'static str,
    pub plugins: Vec<WorkspaceMcpPluginSummary>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceMcpPluginSummary {
    pub plugin_name: String,
    pub servers: Vec<WorkspaceMcpServerSummary>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceMcpServerSummary {
    pub id: String,
    pub model_contract_digest: String,
    pub transport: WorkspaceMcpTransportSummary,
    pub auth: WorkspaceMcpAuthSummary,
    pub startup_timeout_ms: u64,
    pub tool_timeout_ms: u64,
    pub tools: Vec<McpToolDeclarationV1>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceMcpTransportSummary {
    pub r#type: &'static str,
    pub endpoint: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceMcpAuthSummary {
    pub r#type: &'static str,
    pub credential_ref: Option<String>,
}

pub(crate) fn workspace_mcp_catalog(
    activation: &PluginActivationSnapshotV1,
) -> Result<WorkspaceMcpCatalogResult, String> {
    workspace_mcp_catalog_at(activation, Path::new(PLUGIN_CATALOG_ROOT))
}

fn workspace_mcp_catalog_at(
    activation: &PluginActivationSnapshotV1,
    catalog_root: &Path,
) -> Result<WorkspaceMcpCatalogResult, String> {
    let package_roots = verified_plugin_package_roots_at(activation, catalog_root)?;
    let mut plugins = Vec::with_capacity(activation.packages.len());
    let mut declaration_budget = ToolContractBudget::default();
    for (package, package_root) in activation.packages.iter().zip(package_roots) {
        let mut servers = Vec::new();
        for resource in &package.mcp_servers {
            let declaration =
                load_mcp_servers_file(package_root.join(resource.path.as_str()).as_path())?;
            declaration_budget.add(&declaration)?;
            servers.extend(declaration.servers.into_iter().map(|server| {
                let (transport, auth) = match server.transport {
                    McpTransportV1::Stdio { .. } => (
                        WorkspaceMcpTransportSummary {
                            r#type: "stdio",
                            endpoint: None,
                        },
                        WorkspaceMcpAuthSummary {
                            r#type: "none",
                            credential_ref: None,
                        },
                    ),
                    McpTransportV1::StreamableHttp {
                        url,
                        bearer_credential_ref,
                    } => {
                        let auth = WorkspaceMcpAuthSummary {
                            r#type: if bearer_credential_ref.is_some() {
                                "bearer"
                            } else {
                                "none"
                            },
                            credential_ref: bearer_credential_ref,
                        };
                        (
                            WorkspaceMcpTransportSummary {
                                r#type: "streamableHttp",
                                endpoint: Some(url),
                            },
                            auth,
                        )
                    }
                };
                WorkspaceMcpServerSummary {
                    id: server.id,
                    model_contract_digest: server.model_contract_digest,
                    transport,
                    auth,
                    startup_timeout_ms: server.startup_timeout_ms,
                    tool_timeout_ms: server.tool_timeout_ms,
                    tools: server.tools,
                }
            }));
        }
        plugins.push(WorkspaceMcpPluginSummary {
            plugin_name: package.name.clone(),
            servers,
        });
    }
    Ok(WorkspaceMcpCatalogResult {
        schema: "workspace.mcp.catalog.result.v1",
        plugins,
    })
}

pub(crate) struct McpCredentialResolver {
    api_internal_url: String,
    internal_api_token: String,
    agent_run_id: String,
    authorization_ref: String,
    authorization_digest: String,
    client: reqwest::Client,
}

impl McpCredentialResolver {
    pub(crate) fn new(
        api_internal_url: String,
        internal_api_token: String,
        agent_run_id: String,
        authorization_ref: String,
        authorization_digest: String,
    ) -> Result<Self, String> {
        Ok(Self {
            api_internal_url,
            internal_api_token,
            agent_run_id,
            authorization_ref,
            authorization_digest,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(3))
                .build()
                .map_err(|error| format!("build MCP credential client failed: {error}"))?,
        })
    }

    async fn resolve(&self, plugin_name: &str, credential_ref: &str) -> Result<String, String> {
        let url = format!(
            "{}/internal/mcp-bearer-credentials/resolve",
            self.api_internal_url.trim_end_matches('/')
        );
        let response = self
            .client
            .post(url)
            .header("Content-Type", "application/json")
            .header("X-Internal-Token", self.internal_api_token.as_str())
            .json(&McpCredentialResolveRequest {
                schema: "runtime.mcp_bearer_credential.resolve.v1",
                agent_run_id: self.agent_run_id.as_str(),
                authorization_ref: self.authorization_ref.as_str(),
                authorization_digest: self.authorization_digest.as_str(),
                plugin_name,
                credential_ref,
            })
            .send()
            .await
            .map_err(|_| "resolve MCP bearer credential request failed".to_string())?;
        if !response.status().is_success() {
            return Err(format!(
                "resolve MCP bearer credential returned {}",
                response.status().as_u16()
            ));
        }
        let resolved = response
            .json::<McpCredentialResolvedResponse>()
            .await
            .map_err(|_| "decode MCP bearer credential response failed".to_string())?;
        if resolved.schema != "runtime.mcp_bearer_credential.resolved.v1"
            || !valid_bearer_token(resolved.token.as_str())
        {
            return Err("MCP bearer credential response invalid".to_string());
        }
        Ok(resolved.token)
    }
}

struct WorkspaceMcpConnector {
    plugin_name: String,
    server: McpServerDeclarationV1,
    credential_resolver: Arc<McpCredentialResolver>,
    docker: Arc<DockerExecutionHostRunner>,
}

impl McpServerConnector for WorkspaceMcpConnector {
    fn connect<'a>(
        &'a self,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<Arc<dyn DynamicToolProvider + Send + Sync>, McpConnectError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            let credential_started = Instant::now();
            let bearer_token = match &self.server.transport {
                McpTransportV1::StreamableHttp {
                    bearer_credential_ref,
                    ..
                } => match bearer_credential_ref.as_deref() {
                    Some(credential_ref) => Some(
                        self.credential_resolver
                            .resolve(self.plugin_name.as_str(), credential_ref)
                            .await
                            .map_err(McpConnectError::Unavailable)?,
                    ),
                    None => None,
                },
                McpTransportV1::Stdio { .. } => None,
            };
            let credential_resolve_ms = credential_started.elapsed().as_millis();
            let discovery_started = Instant::now();
            let provider = match &self.server.transport {
                McpTransportV1::StreamableHttp { .. } => {
                    connect_streamable_http_mcp_server(
                        self.plugin_name.as_str(),
                        self.server.clone(),
                        bearer_token.as_deref(),
                    )
                    .await?
                }
                McpTransportV1::Stdio { program, args } => {
                    let command = self
                        .docker
                        .mcp_stdio_command(
                            self.plugin_name.as_str(),
                            program.as_str(),
                            args.as_slice(),
                        )
                        .map_err(McpConnectError::Unavailable)?;
                    let transport = bounded_stdio_transport(command).map_err(|error| {
                        McpConnectError::Unavailable(format!(
                            "start MCP stdio server failed: {error}"
                        ))
                    })?;
                    connect_mcp_server_transport(
                        self.plugin_name.as_str(),
                        self.server.clone(),
                        transport,
                    )
                    .await?
                }
            };
            eprintln!(
                "mcp_lazy_connect_profile: pluginName={}; serverId={}; credentialResolveMs={}; connectDiscoveryMs={}",
                self.plugin_name,
                self.server.id,
                credential_resolve_ms,
                discovery_started.elapsed().as_millis(),
            );
            Ok(provider)
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpCredentialResolveRequest<'a> {
    schema: &'static str,
    agent_run_id: &'a str,
    authorization_ref: &'a str,
    authorization_digest: &'a str,
    plugin_name: &'a str,
    credential_ref: &'a str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct McpCredentialResolvedResponse {
    schema: String,
    token: String,
}

pub(crate) async fn prepare_http_mcp_servers(
    activation: PluginActivationSnapshotV1,
    credential_resolver: McpCredentialResolver,
) -> Result<PreparedMcpServers, String> {
    prepare_mcp_servers_at(
        activation,
        credential_resolver,
        Path::new(PLUGIN_CATALOG_ROOT),
    )
}

fn prepare_mcp_servers_at(
    activation: PluginActivationSnapshotV1,
    credential_resolver: McpCredentialResolver,
    catalog_root: &Path,
) -> Result<PreparedMcpServers, String> {
    let mut servers = Vec::new();
    let mut declaration_budget = ToolContractBudget::default();
    for package in &activation.packages {
        for resource in &package.mcp_servers {
            let declaration = load_mcp_servers_file(
                catalog_root
                    .join(package.name.as_str())
                    .join(resource.path.as_str())
                    .as_path(),
            )?;
            declaration_budget.add(&declaration)?;
            servers.extend(
                declaration
                    .servers
                    .into_iter()
                    .map(|server| (package.name.clone(), server)),
            );
        }
    }

    Ok(PreparedMcpServers {
        servers,
        credential_resolver: Arc::new(credential_resolver),
    })
}

pub(crate) async fn connect_mcp_servers(
    prepared: PreparedMcpServers,
    docker: Arc<DockerExecutionHostRunner>,
) -> Result<(McpBindings, McpStartupMetrics), String> {
    let server_count = prepared.servers.len();
    let mut contracts = Vec::new();
    let mut providers: Vec<Arc<dyn DynamicToolProvider + Send + Sync>> = Vec::new();
    let mut provider_ids = HashSet::new();
    for (plugin_name, server) in prepared.servers {
        let binding = lazy_mcp_server_binding(
            plugin_name.as_str(),
            &server,
            Arc::new(WorkspaceMcpConnector {
                plugin_name: plugin_name.clone(),
                server: server.clone(),
                credential_resolver: prepared.credential_resolver.clone(),
                docker: docker.clone(),
            }),
        )?;
        if !provider_ids.insert(binding.provider.provider_id().to_string()) {
            return Err(format!(
                "duplicate MCP server identity: {}",
                binding.provider.provider_id()
            ));
        }
        contracts.extend(binding.contracts);
        providers.push(binding.provider);
    }
    Ok((
        McpBindings {
            contracts,
            providers,
        },
        McpStartupMetrics {
            server_count,
            credential_count: 0,
            connection_count: 0,
            credential_resolve_ms: 0,
            discovery_ms: 0,
        },
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    use centaeris_core::extension::{
        mcp_model_contract_digest, McpLifecycleV1, McpServersFileV1, MCP_SERVERS_SCHEMA_V1,
    };
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn banana_package() -> (PathBuf, PluginActivationSnapshotV1) {
        use centaeris_core::extension::build_plugin_activation_snapshot;

        let catalog_root = std::env::temp_dir().join(format!(
            "centaeris-banana-mcp-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let package_root = catalog_root.join("banana");
        fs::create_dir_all(package_root.join(".centaeris-plugin")).unwrap();
        fs::create_dir_all(package_root.join("mcp")).unwrap();
        fs::write(
            package_root.join(".centaeris-plugin/plugin.json"),
            r#"{"name":"banana","version":"1.0.0","paths":{"mcpServers":["mcp/banana.json"]}}"#,
        )
        .unwrap();
        let tools = vec![McpToolDeclarationV1 {
            source_name: "search".to_string(),
            name: "banana_search".to_string(),
            description: "Search bananas.".to_string(),
            input_schema: json!({"type": "object"}),
            concurrency_safe: true,
            scopes: vec!["banana:read".to_string()],
        }];
        fs::write(
            package_root.join("mcp/banana.json"),
            serde_json::to_vec_pretty(&McpServersFileV1 {
                schema: MCP_SERVERS_SCHEMA_V1.to_string(),
                servers: vec![McpServerDeclarationV1 {
                    id: "banana-source".to_string(),
                    model_contract_digest: mcp_model_contract_digest(
                        "banana-source",
                        tools.as_slice(),
                    )
                    .expect("model contract digest"),
                    transport: McpTransportV1::StreamableHttp {
                        url: "https://banana.invalid/mcp".to_string(),
                        bearer_credential_ref: Some("banana-token".to_string()),
                    },
                    lifecycle: McpLifecycleV1::Auto,
                    startup_timeout_ms: 10_000,
                    tool_timeout_ms: 60_000,
                    tools,
                }],
            })
            .expect("MCP declaration"),
        )
        .unwrap();
        let activation = build_plugin_activation_snapshot(std::slice::from_ref(&package_root))
            .expect("banana activation");
        (catalog_root, activation)
    }

    #[test]
    fn workspace_catalog_reuses_frozen_package_and_core_declaration() {
        let (catalog_root, activation) = banana_package();

        let catalog = workspace_mcp_catalog_at(&activation, catalog_root.as_path())
            .expect("Workspace MCP catalog");

        assert_eq!(catalog.plugins.len(), 1);
        assert_eq!(catalog.plugins[0].plugin_name, "banana");
        assert_eq!(catalog.plugins[0].servers.len(), 1);
        assert_eq!(catalog.plugins[0].servers[0].id, "banana-source");
        assert_eq!(
            catalog.plugins[0].servers[0].transport.endpoint.as_deref(),
            Some("https://banana.invalid/mcp")
        );
        assert_eq!(
            catalog.plugins[0].servers[0].auth.credential_ref.as_deref(),
            Some("banana-token")
        );
        assert_eq!(catalog.plugins[0].servers[0].tools[0].name, "banana_search");
    }

    #[test]
    fn credential_protocol_is_strict_and_secret_safe() {
        assert!(valid_bearer_token("test-secret"));
        assert!(!valid_bearer_token("banana token"));

        assert_eq!(
            serde_json::to_value(McpCredentialResolveRequest {
                schema: "runtime.mcp_bearer_credential.resolve.v1",
                agent_run_id: "agent-run",
                authorization_ref: "authorization",
                authorization_digest: "sha256:banana",
                plugin_name: "banana",
                credential_ref: "banana",
            })
            .expect("serialize resolver request"),
            json!({
                "schema": "runtime.mcp_bearer_credential.resolve.v1",
                "agentRunId": "agent-run",
                "authorizationRef": "authorization",
                "authorizationDigest": "sha256:banana",
                "pluginName": "banana",
                "credentialRef": "banana",
            })
        );
        assert!(
            serde_json::from_value::<McpCredentialResolvedResponse>(json!({
                "schema": "runtime.mcp_bearer_credential.resolved.v1",
                "token": "test-secret",
                "banana": true,
            }))
            .is_err()
        );
    }

    #[test]
    fn preparation_rejects_aggregate_declarations_before_connections() {
        let (catalog_root, _) = banana_package();
        let package_root = catalog_root.join("banana");
        let base = load_mcp_servers_file(&package_root.join("mcp/banana.json")).unwrap();
        let mut paths = Vec::new();
        for index in 0..2 {
            let mut server = base.servers[0].clone();
            server.id = format!("banana-source-{index}");
            server.tools = (0..48)
                .map(|tool_index| {
                    let mut tool = base.servers[0].tools[0].clone();
                    tool.source_name = format!("search_{tool_index:03}");
                    tool.name = format!("banana_{index}_search_{tool_index:03}");
                    tool.input_schema =
                        json!({"type": "object", "description": "x".repeat(48 * 1024)});
                    tool
                })
                .collect();
            server.model_contract_digest =
                mcp_model_contract_digest(&server.id, &server.tools).unwrap();
            let relative = format!("mcp/large-{index}.json");
            fs::write(
                package_root.join(&relative),
                serde_json::to_vec(&McpServersFileV1 {
                    schema: MCP_SERVERS_SCHEMA_V1.to_string(),
                    servers: vec![server],
                })
                .unwrap(),
            )
            .unwrap();
            load_mcp_servers_file(&package_root.join(&relative)).expect("individual file fits");
            paths.push(relative);
        }
        fs::write(
            package_root.join(".centaeris-plugin/plugin.json"),
            serde_json::to_vec(&json!({
                "name": "banana", "version": "1.0.0", "paths": {"mcpServers": paths},
            }))
            .unwrap(),
        )
        .unwrap();
        let activation =
            centaeris_core::extension::build_plugin_activation_snapshot(&[package_root]).unwrap();
        let resolver = McpCredentialResolver::new(
            "http://127.0.0.1:9".to_string(),
            "unused".to_string(),
            "agent-run".to_string(),
            "authorization".to_string(),
            "sha256:banana".to_string(),
        )
        .unwrap();
        assert!(workspace_mcp_catalog_at(&activation, &catalog_root)
            .unwrap_err()
            .contains("4194304 bytes"));
        let error = prepare_mcp_servers_at(activation, resolver, &catalog_root)
            .err()
            .expect("aggregate declarations must fail");
        assert!(error.contains("4194304 bytes"));
        fs::remove_dir_all(catalog_root).unwrap();
    }

    #[test]
    fn agent_run_preparation_loads_static_contract_without_credentials_or_network() {
        let (catalog_root, activation) = banana_package();
        let prepared = prepare_mcp_servers_at(
            activation,
            McpCredentialResolver::new(
                "http://127.0.0.1:9".to_string(),
                "unused".to_string(),
                "agent-run".to_string(),
                "authorization".to_string(),
                "sha256:banana".to_string(),
            )
            .expect("credential resolver"),
            catalog_root.as_path(),
        )
        .expect("static preparation");
        assert_eq!(prepared.servers.len(), 1);
        let (plugin_name, server) = &prepared.servers[0];
        let contracts = server
            .dynamic_tool_contracts(plugin_name.as_str())
            .expect("static contract");
        assert_eq!(contracts[0].provider_id, "mcp:banana:banana-source");
    }
}
