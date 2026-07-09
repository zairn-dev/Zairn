import assert from 'node:assert/strict';
import {
  createSensingGate,
  DEFAULT_GATE_CONFIG,
  DEFAULT_PRIVACY_CONFIG,
} from '../dist/privacy-location.js';

const NOW = 1_000_000_000;
const MINUTE = 60 * 1000;

const home = {
  id: 'sp-0',
  label: 'home',
  lat: 0,
  lon: 0,
  radiusM: 200,
  bufferRadiusM: 1000,
  visitCount: 30,
  avgDwellMinutes: 480,
};

function makeGate(overrides = {}, zones = [home]) {
  return createSensingGate({
    ...DEFAULT_PRIVACY_CONFIG,
    ...overrides,
    sensingGate: {
      ...DEFAULT_GATE_CONFIG,
      ...(overrides.sensingGate ?? {}),
    },
  }, zones);
}

{
  const decision = makeGate().shouldAcquire({
    now: NOW,
    lastFix: null,
    motion: 'unknown',
  });
  assert.deepEqual(decision, {
    acquire: true,
    mode: 'gnss',
    nextCheckMs: 0,
    reason: 'cold-start',
  });
}

{
  const gate = makeGate();
  const early = gate.shouldAcquire({
    now: NOW,
    lastFix: { lat: 0, lon: 0, timestamp: NOW - MINUTE },
    motion: 'walking',
  });
  const later = gate.shouldAcquire({
    now: NOW,
    lastFix: { lat: 0, lon: 0, timestamp: NOW - 100_000 },
    motion: 'walking',
  });

  assert.equal(early.acquire, false);
  assert.equal(early.mode, 'skip');
  assert.equal(early.reason, 'zone-dwell');
  assert.equal(later.reason, 'zone-dwell');
  assert.ok(early.nextCheckMs > later.nextCheckMs);
  assert.ok(later.nextCheckMs >= DEFAULT_GATE_CONFIG.minNextCheckMs);
  assert.ok(early.nextCheckMs <= DEFAULT_GATE_CONFIG.maxNextCheckMs);
}

{
  const decision = makeGate({
    sensingGate: { movingIntervalMs: MINUTE },
  }).shouldAcquire({
    now: NOW,
    lastFix: { lat: 0, lon: 0, timestamp: NOW - 200_000 },
    motion: 'walking',
  });

  assert.equal(decision.acquire, true);
  assert.equal(decision.mode, 'gnss');
  assert.equal(decision.reason, 'due-moving');
}

{
  const gate = makeGate({}, []);
  const stationaryWait = gate.shouldAcquire({
    now: NOW,
    lastFix: { lat: 1, lon: 1, timestamp: NOW - 10 * MINUTE },
    motion: 'stationary',
  });
  const stationaryDue = gate.shouldAcquire({
    now: NOW,
    lastFix: { lat: 1, lon: 1, timestamp: NOW - 30 * MINUTE },
    motion: 'stationary',
  });
  const movingWait = gate.shouldAcquire({
    now: NOW,
    lastFix: { lat: 1, lon: 1, timestamp: NOW - 4 * MINUTE },
    motion: 'driving',
  });
  const movingDue = gate.shouldAcquire({
    now: NOW,
    lastFix: { lat: 1, lon: 1, timestamp: NOW - 5 * MINUTE },
    motion: 'walking',
  });

  assert.equal(stationaryWait.acquire, false);
  assert.equal(stationaryWait.reason, 'cadence-wait');
  assert.equal(stationaryWait.nextCheckMs, 20 * MINUTE);
  assert.equal(stationaryDue.acquire, true);
  assert.equal(stationaryDue.reason, 'due-stationary');
  assert.equal(movingWait.acquire, false);
  assert.equal(movingWait.nextCheckMs, MINUTE);
  assert.equal(movingDue.acquire, true);
  assert.equal(movingDue.reason, 'due-moving');
}

{
  const decision = makeGate({ coarseOnly: true }).shouldAcquire({
    now: NOW,
    lastFix: { lat: 0, lon: 0, timestamp: NOW - 61 * MINUTE },
    motion: 'stationary',
  });

  assert.equal(decision.acquire, true);
  assert.equal(decision.mode, 'gnss');
  assert.equal(decision.reason, 'staleness-floor');
}

{
  const decision = makeGate({ coarseOnly: true }, []).shouldAcquire({
    now: NOW,
    lastFix: { lat: 1, lon: 1, timestamp: NOW - 5 * MINUTE },
    motion: 'walking',
  });

  assert.equal(decision.acquire, true);
  assert.equal(decision.mode, 'network');
  assert.equal(decision.reason, 'due-moving');
}

{
  // caller-accumulated displacement bound: a long stationary dwell inside a
  // zone keeps skipping (zone-dwell) far past the naive elapsed×speed bound,
  // until the staleness floor takes over
  const gate = makeGate();
  const longDwell = gate.shouldAcquire({
    now: NOW,
    lastFix: { lat: 0, lon: 0, timestamp: NOW - 45 * MINUTE },
    motion: 'stationary',
    maxDisplacementM: 3,
  });
  assert.equal(longDwell.acquire, false);
  assert.equal(longDwell.reason, 'zone-dwell');

  const pastFloor = gate.shouldAcquire({
    now: NOW,
    lastFix: { lat: 0, lon: 0, timestamp: NOW - 61 * MINUTE },
    motion: 'stationary',
    maxDisplacementM: 3,
  });
  assert.equal(pastFloor.acquire, true);
  assert.equal(pastFloor.reason, 'staleness-floor');

  // ...but a large accumulated displacement disables the dwell proof
  const walkedOut = gate.shouldAcquire({
    now: NOW,
    lastFix: { lat: 0, lon: 0, timestamp: NOW - 45 * MINUTE },
    motion: 'stationary',
    maxDisplacementM: 250,
  });
  assert.equal(walkedOut.reason, 'due-stationary');
  assert.equal(walkedOut.acquire, true);
}

console.log('sensing-gate tests passed');
