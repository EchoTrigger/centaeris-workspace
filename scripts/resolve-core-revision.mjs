import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function parseCoreRevision(output) {
  const match = /^([0-9a-f]{40})\trefs\/heads\/main(?:\r?\n)?$/.exec(output);
  if (!match) throw new Error('Expected exactly one full Core SHA for refs/heads/main');
  return match[1];
}

export function resolveCoreRevision(runGit = execFileSync) {
  return parseCoreRevision(runGit('git', [
    'ls-remote', '--exit-code', '--refs',
    'https://github.com/EchoTrigger/centaeris.git', 'refs/heads/main',
  ], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const revision = resolveCoreRevision();
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `revision=${revision}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Core main resolved for this run: [${revision}](https://github.com/EchoTrigger/centaeris/commit/${revision})\n`);
  }
  console.log(revision);
}
