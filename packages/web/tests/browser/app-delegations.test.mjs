import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createServer } from "vite";

test("application consent, one-time token, revocation and administrator lifecycle", async () => {
  assert.ok(process.env.CHROME_BIN, "Set CHROME_BIN to a Chromium executable");
  const profile = await mkdtemp(join(tmpdir(), "centaeris-app-delegations-"));
  const server = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), server: { port: 0, host: "127.0.0.1", strictPort: false } });
  try {
    await server.listen();
    const url = `${server.resolvedUrls.local[0]}tests/browser/app-delegations.html`;
    const { stdout } = await promisify(execFile)(process.env.CHROME_BIN, ["--headless", "--disable-gpu", ...(process.platform === "win32" ? ["--no-sandbox"] : []), "--no-first-run", `--user-data-dir=${profile}`, "--virtual-time-budget=15000", "--dump-dom", url], { timeout: 30000, maxBuffer: 2_000_000 });
    const payload = stdout.match(/<pre id="results">(.*?)<\/pre>/s)?.[1];
    assert.ok(payload, `browser did not report completed assertions: ${stdout.slice(-3000)}`);
    const results = JSON.parse(payload.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
    assert.ok(results.length >= 30, JSON.stringify(results));
    assert.deepEqual(results.filter(result => JSON.stringify(result.actual) !== JSON.stringify(result.expected)), []);
  } finally {
    await server.close();
    const resolvedProfile = await realpath(profile);
    assert.equal(dirname(resolvedProfile).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.ok(basename(resolvedProfile).startsWith("centaeris-app-delegations-"));
    await rm(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
