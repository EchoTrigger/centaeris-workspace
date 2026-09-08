import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('cancelled runs are reported immediately as unsuccessful terminals', () => {
  const source = fs.readFileSync(new URL('../k6/scenarios/common.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
  let clock = 0;
  const context = vm.createContext({ __ENV: {}, Date: { now() { return clock += 100000; } }, sleep() {},
    http: { request() { return { status: 200, json(key) { return key === 'agentRuns' ? [{ id: 'r', status: 'cancelled' }] : []; } }; } } });
  const result = vm.runInContext(source + '\nwaitForTerminal({}, "csrf", "s", "r", 120)', context);
  assert.equal(result.status, 'cancelled');
});

test('each submitted run contributes a success or failure rate sample', () => {
  const source = fs.readFileSync(new URL('../k6/scenarios/s2-runs.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
  for (const failed of [false, true]) {
    const samples = [];
    class Metric { constructor(name) { this.name = name; } add(value) { if (this.name === 's2_create_errors') samples.push(value); } }
    const context = vm.createContext({ Trend: Metric, Counter: Metric, Rate: Metric, __ENV: {},
      startRun() { if (failed) throw new Error('fixture failure'); return { sessionId: 's', agentRunId: 'r' }; } });
    vm.runInContext(source + '\ncreateRun({});', context);
    assert.deepEqual(samples, [failed ? 1 : 0]);
  }
});
