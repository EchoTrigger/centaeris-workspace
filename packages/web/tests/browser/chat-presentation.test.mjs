import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createServer } from "vite";

for (const reduced of [false, true]) test(`chat presentation (reduced motion: ${reduced})`, async () => {
  assert.ok(process.env.CHROME_BIN, "Set CHROME_BIN to a Chromium executable");
  const profile = await mkdtemp(join(tmpdir(), "centaeris-chat-ui-"));
  const server = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), server: { port: 0, host: "127.0.0.1", strictPort: false } });
  try {
    await server.listen();
    const url = `${server.resolvedUrls.local[0]}tests/browser/chat-presentation.html`;
    const { stdout } = await promisify(execFile)(process.env.CHROME_BIN, ["--headless", "--disable-gpu", ...(reduced ? ["--force-prefers-reduced-motion=reduce"] : []), "--no-first-run", `--user-data-dir=${profile}`, "--virtual-time-budget=5000", "--dump-dom", url], { timeout: 30000, maxBuffer: 2_000_000 });
    const payload = stdout.match(/<pre id="results">(.*?)<\/pre>/s)?.[1];
    assert.ok(payload, "browser did not report completed assertions");
    const results = JSON.parse(payload.replaceAll("&quot;", '\"').replaceAll("&amp;", "&"));
    assert.ok(results.length >= 25);
    const failures = results.filter(result => JSON.stringify(result.actual) !== JSON.stringify(result.expected));
    assert.deepEqual(failures, []);
  } finally {
    await server.close();
    const resolvedProfile = await realpath(profile);
    assert.equal(dirname(resolvedProfile).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.ok(basename(resolvedProfile).startsWith("centaeris-chat-ui-"));
    await rm(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
