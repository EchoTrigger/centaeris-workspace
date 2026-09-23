import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCoreRevision, resolveCoreRevision } from './resolve-core-revision.mjs';

const coreRoot = fileURLToPath(new URL('../../centaeris/', import.meta.url));

export function verifyCoreCheckout(runGit = execFileSync, expected = resolveCoreRevision()) {
  const actual = parseCoreRevision(runGit('git', ['-C', coreRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8', timeout: 30_000,
  }));
  if (actual !== expected) {
    throw new Error(`Local Core checkout ${actual} does not match pinned ${expected}`);
  }
  return actual;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(verifyCoreCheckout());
}
