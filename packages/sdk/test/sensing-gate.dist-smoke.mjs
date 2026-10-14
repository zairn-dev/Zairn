import assert from 'node:assert/strict';
import {
  createSensingGate,
  createSensingGateController,
  DEFAULT_PRIVACY_CONFIG,
  runSensingCycle,
} from '../dist/index.js';

const gate = createSensingGate(DEFAULT_PRIVACY_CONFIG);
const decision = gate.shouldAcquire({
  now: 1_000_000_000,
  lastFix: null,
  motion: 'unknown',
});

assert.deepEqual(decision, {
  acquire: true,
  mode: 'gnss',
  nextCheckMs: 0,
  reason: 'cold-start',
});

const controller = createSensingGateController(DEFAULT_PRIVACY_CONFIG);
const cycle = await runSensingCycle(
  controller,
  { now: 1_000_000_000, motion: 'unknown' },
  {
    async acquire(mode) {
      assert.equal(mode, 'gnss');
      return { lat: 35, lon: 139, timestamp: 1_000_000_000 };
    },
  },
);

assert.equal(cycle.decision.reason, 'cold-start');
assert.deepEqual(controller.getState().lastFix, cycle.fix);

console.log('sensing-gate dist smoke passed');
