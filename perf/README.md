# Isolated performance harness

Run from the repository root. The only deployment controller is
`python perf/harness/control.py`. It pins project `centaeris-perf`, the base and
performance Compose files, and `perf/.state/test.env`. It does not read the root
private `.env`. Do not invoke Compose manually to change slots.

## Setup and smoke

```powershell
python perf/harness/control.py init
bash perf/certs/generate.sh
python perf/harness/control.py check
python perf/harness/control.py build
python perf/harness/control.py up
python perf/harness/control.py smoke --experiment-id smoke-001
python perf/harness/control.py slots --slots 6
python perf/harness/control.py smoke --experiment-id smoke-002
```

For a short end-to-end harness check (not a capacity claim), use the pinned K6
builder and a bounded load:

```powershell
bash perf/k6/build.sh
python perf/harness/control.py load --experiment-id load-001 --rate 12 --seconds 15
python perf/harness/control.py sample --experiment-id sample-001 --seconds 30
```

`load` records accepted run IDs, final per-run timestamps/status, K6 logs, resource
samples and baseline history counts. All accepted IDs must match completed durable
runs exactly. A failed command, invalid sample, unsuccessful terminal or drain
timeout fails the experiment. The outcome is explicitly continuous-history; fixed
snapshot restoration is a separate operator preparation step, not an automatic
consequence of draining. The existing controller runs one stage per invocation.

Initialization refuses to replace existing credentials or certificates. API is
bound to localhost:18000; optional Web uses localhost:13000. The test project owns
separate networks and data volumes. Mock CA trust is added only by the performance
overlay. TLS validation stays enabled. Production image tags are not rebuilt by
the controller; the document processor image is an existing shared read-only
dependency and must be built using the normal project build before setup.

Fresh isolated CA files use `perf/certs/out/isolated/`, leaving any legacy certificate
files mounted by an existing development stack unchanged.

Slot changes require zero queued/running runs, replace only the worker using
`--no-deps`, and verify that all other container identities are unchanged. Run
`stop` only after the stack drains; it preserves test volumes. There is no automatic
volume deletion, password reset, cancellation, or replay of failed runs.

## Evidence and source boundary

Only source scripts, tests and configuration belong here. Credentials under
`.state/`, generated certificates under `certs/out/`, downloaded binaries under
`k6/bin/` and old results under `results/` are ignored. The entire `perf/` directory
is excluded from production Docker build contexts; the mock has its own context.

Evidence is written to the sibling `centaeris-perf-evidence/<experiment-id>/`;
experiment IDs cannot be reused. Manifests record revisions, dirty paths, container
identities and image digests without credentials. Original evidence snapshots are
retained outside the repository. Superseded deployment/sampling scripts are archived
there under `harness-migration-20260906` and are not supported entry points.

## Measurement discipline

Preflight checks container ownership, health, a verified TLS handshake from API to
mock, and complete resource samples. A sampling/command failure invalidates the
experiment; empty columns must never be treated as zero resource use.

An empty queue does not mean unchanged history. For a fixed-history comparison,
restore the same synthetic test-data snapshot before each stage and record its
identity. Continuous-history experiments must be labeled as such. Never attach
production volumes or reuse production accounts. Existing K6 scenarios are workload
sources; accepted requests and completed iterations are not completed AgentRuns.
Persist exact run IDs and verify their terminal states separately.

The controller's smoke requires a completed run. It does not establish throughput,
capacity, fairness, restart recovery, or historical-cost independence. Run failures
must remain visible; cancellation must not count as successful draining.

## Tests

For the bounded historical-notification amplification probe, run
`python perf/harness/outbox_profile.py --experiment-id outbox-001`. It requires
an idle isolated stack with no active waiters, temporarily stops its worker,
replaces only `perf.outbox.history` synthetic fixtures at 0/3,641/36,410 rows,
and exercises real reconcile/pending/waiter endpoints. It resets PostgreSQL
statement statistics on this test server and records HTTP results, fixture
generation/pending counts and SQL work. Worker startup is restored afterward.
The largest acknowledged fixture remains in the test database. This probe does
not establish steady-state CPU or capacity; do not run it alongside another test.

For a bounded loaded comparison, run `python perf/harness/history_load.py
--experiment-id history-load-001`. It requires two worker slots and an idle stack,
then runs 30 arrivals/minute for 90 seconds at 0/3,641/36,410/0 acknowledged
synthetic notification rows. Each fixture change stops only the idle worker and
preserves all real runs. Real run history accumulates; the final zero-fixture
stage helps identify time drift but does not replace a restored-snapshot study.
Each stage saves database-clock timestamps, raw session counters, statement
statistics, resource samples, accepted IDs and completed run receipts. Counter
resets and invalid windows fail measurement. Windows include setup and drain;
they are not pure steady-state samples. After success the 36,410-row baseline is
restored. Do not run alongside another load or reset database statistics.

```powershell
python -m unittest discover -s perf/tests -v
```

These regressions also run in `scripts/ci.ps1`. Docker Compose rendering tests use
synthetic configuration; live smoke runs require the isolated deployment.
