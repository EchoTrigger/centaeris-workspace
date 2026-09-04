use postgres::{Client, NoTls};
use std::fmt;

mod external_context;
mod reliability;
mod runtime;
mod schema;
mod transactions;
mod turn_supplement;

#[derive(Clone)]
pub struct PostgresRuntimeStore {
    database_url: String,
}

impl fmt::Debug for PostgresRuntimeStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PostgresRuntimeStore")
            .field("database_url", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentRunExecutionControlState {
    pub cancellation_requested: bool,
    pub lifecycle_lease_current: bool,
}

impl PostgresRuntimeStore {
    pub fn new(database_url: &str) -> Result<Self, String> {
        if database_url.trim().is_empty() {
            return Err("Postgres runtime database URL is required".to_string());
        }
        let store = Self {
            database_url: database_url.to_string(),
        };
        store.with_client(schema::ensure_schema)?;
        Ok(store)
    }

    pub(crate) fn with_client<T: Send>(
        &self,
        operation: impl FnOnce(&mut Client) -> Result<T, String> + Send,
    ) -> Result<T, String> {
        // ponytail: one connection per actor operation; add a bounded pool when measured
        // connection setup latency matters. Correctness and multi-instance safety do not depend on pooling.
        run_postgres_blocking(|| {
            let mut client = self.connect()?;
            operation(&mut client)
        })
    }

    pub(crate) fn with_client_error<T: Send, E: From<String> + Send>(
        &self,
        operation: impl FnOnce(&mut Client) -> Result<T, E> + Send,
    ) -> Result<T, E> {
        run_postgres_blocking_error(|| {
            let mut client = self.connect().map_err(E::from)?;
            operation(&mut client)
        })
    }

    pub(crate) fn with_execution_control_client<T: Send>(
        &self,
        operation: impl FnOnce(&mut Client) -> Result<T, String> + Send,
    ) -> Result<T, String> {
        // ponytail: one isolated connection per probe; add a DB actor only if measured polling load requires it.
        run_postgres_blocking(|| {
            let mut client = self.connect()?;
            operation(&mut client)
        })
    }

    fn connect(&self) -> Result<Client, String> {
        let mut client = Client::connect(self.database_url.as_str(), NoTls)
            .map_err(|error| format!("connect Postgres runtime store failed: {error}"))?;
        client
            .batch_execute("SET search_path TO runtime, public")
            .map_err(|error| format!("set Postgres runtime search_path failed: {error}"))?;
        Ok(client)
    }
}

pub(crate) fn run_postgres_blocking<T: Send>(
    operation: impl FnOnce() -> Result<T, String> + Send,
) -> Result<T, String> {
    run_postgres_blocking_error(operation)
}

fn run_postgres_blocking_error<T: Send, E: From<String> + Send>(
    operation: impl FnOnce() -> Result<T, E> + Send,
) -> Result<T, E> {
    if tokio::runtime::Handle::try_current().is_ok() {
        return std::thread::scope(|scope| {
            scope
                .spawn(operation)
                .join()
                .map_err(|_| E::from("Postgres blocking operation thread panicked".to_string()))?
        });
    }
    operation()
}

pub(crate) use runtime::hydrate_session_wire_values;
pub use runtime::PostgresSessionLog;

#[cfg(test)]
mod integration_tests;

#[cfg(test)]
mod tests {
    use super::{PostgresRuntimeStore, PostgresSessionLog};
    use centaeris_core::session::{
        canonical_session_record, RuntimeJobLeaseFence, SequencedSessionRecord, SessionRecordType,
    };

    #[test]
    fn connect_inside_tokio_runtime_returns_error_instead_of_panicking() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build Tokio runtime");
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            runtime.block_on(async {
                PostgresRuntimeStore::new("postgresql://127.0.0.1:1/centaeris?connect_timeout=1")
            })
        }));

        assert!(
            result.is_ok(),
            "Postgres connect must not panic inside Tokio"
        );
        assert!(
            result.expect("connection attempt must not panic").is_err(),
            "closed test port must return an error"
        );
    }

    #[test]
    fn synchronous_session_append_inside_tokio_returns_error_instead_of_panicking() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build Tokio runtime");
        let session_log = PostgresSessionLog::new(
            "postgresql://127.0.0.1:1/centaeris?connect_timeout=1".to_string(),
            "workspace_1".to_string(),
            "session_1".to_string(),
            "hello".to_string(),
        );
        let events = vec![SequencedSessionRecord {
            sequence: 1,
            event: canonical_session_record(
                "event_1",
                SessionRecordType::AgentRunStarted,
                "session_1",
                Some("run_1".to_string()),
                Some("run_1".to_string()),
                1,
                serde_json::json!({"userObjective":"hello"}),
            )
            .expect("canonical turn start"),
        }];
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            runtime.block_on(async {
                session_log.append_session_records_with_runtime_job_lease_blocking(
                    "run_1",
                    events.as_slice(),
                    &RuntimeJobLeaseFence {
                        job_id: "run.lifecycle:run_1".to_string(),
                        job_kind: "run.lifecycle".to_string(),
                        lease_owner: "worker_1".to_string(),
                    },
                )
            })
        }));

        assert!(
            result.is_ok(),
            "sync SessionLog API must not panic in Tokio"
        );
        assert!(result.expect("SessionLog call must not panic").is_err());
    }
}
