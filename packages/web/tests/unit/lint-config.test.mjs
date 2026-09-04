import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const biomeEntry = resolve(repoRoot, "node_modules/@biomejs/biome/bin/biome");

function runFixture(source) {
  const fixturePath = resolve(repoRoot, "packages/web/src/.lint-contract-test.tsx");
  writeFileSync(fixturePath, source);
  try {
    return spawnSync(process.execPath, [biomeEntry, "lint", fixturePath], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } finally {
    rmSync(fixturePath, { force: true });
  }
}

test("missing React dependencies are reported without blocking the gate", () => {
  const result = runFixture(`
    import { useEffect } from "react";
    export function LintContract({ value }) {
      useEffect(() => console.log(value), []);
      return null;
    }
  `);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /lint\/correctness\/useExhaustiveDependencies/);
});

test("conditional React hooks block the gate", () => {
  const result = runFixture(`
    import { useEffect } from "react";
    export function LintContract({ enabled }) {
      if (enabled) useEffect(() => {}, []);
      return null;
    }
  `);
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /lint\/correctness\/useHookAtTopLevel/);
});

test("explicit any blocks the gate", () => {
  const result = runFixture(`
    export function readIdentity(value: any) {
      return value.id;
    }
  `);
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /lint\/suspicious\/noExplicitAny/);
});

test("core chat implementations remain strict TypeScript", () => {
  const chatRoot = resolve(repoRoot, "packages/web/src/chat");
  for (const moduleName of [
    "sessionEvents",
    "chatViewStore",
    "workspaceChatController",
    "workspaceWebTransport",
  ]) {
    assert.equal(existsSync(resolve(chatRoot, `${moduleName}.ts`)), true);
    assert.equal(existsSync(resolve(chatRoot, `${moduleName}.mjs`)), false);
  }
  const tsconfig = JSON.parse(
    readFileSync(resolve(repoRoot, "packages/web/tsconfig.json"), "utf8"),
  );
  assert.equal(tsconfig.compilerOptions.strict, true);
  assert.equal(tsconfig.compilerOptions.noEmit, true);
});
