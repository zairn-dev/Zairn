import { describe, expect, it } from 'vitest';
import {
  createSensingGate,
  createSensingGateController,
  DEFAULT_GATE_CONFIG,
  DEFAULT_PRIVACY_CONFIG,
  runSensingCycle,
} from '../src/privacy-location';
import type { PrivacyConfig, SensitivePlace, SensingGateInput } from '../src/privacy-location';

const NOW = 1_000_000_000;
const MINUTE = 60 * 1000;

const home: SensitivePlace = {
  id: 'sp-0',
  label: 'home',
  lat: 0,
  lon: 0,
  radiusM: 200,
  bufferRadiusM: 1000,
  visitCount: 30,
  avgDwellMinutes: 480,
};

function makeGate(
  overrides: Partial<PrivacyConfig> = {},
  zones: SensitivePlace[] = [home],
) {
  return createSensingGate({
    ...DEFAULT_PRIVACY_CONFIG,
    ...overrides,
    sensingGate: {
      ...DEFAULT_GATE_CONFIG,
      ...overrides.sensingGate,
    },
  }, zones);
}

describe('createSensingGate', () => {
  it('acquires GNSS on cold start', () => {
    const decision = makeGate().shouldAcquire({
      now: NOW,
      lastFix: null,
      motion: 'unknown',
    });

    expect(decision).toEqual({
      acquire: true,
      mode: 'gnss',
      nextCheckMs: 0,
      reason: 'cold-start',
    });
  });

  it('returns deterministic decisions for the same input', () => {
    const gate = makeGate({}, []);
    const input: SensingGateInput = {
      now: NOW,
      lastFix: { lat: 1, lon: 1, timestamp: NOW - 4 * MINUTE },
      motion: 'walking',
    };

    expect(gate.shouldAcquire(input)).toEqual(gate.shouldAcquire(input));
  });

  it('skips while zone exit is impossible and shortens the next check', () => {
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

    expect(early.acquire).toBe(false);
    expect(early.mode).toBe('skip');
    expect(early.reason).toBe('zone-dwell');
    expect(later.reason).toBe('zone-dwell');
    expect(early.nextCheckMs).toBeGreaterThan(later.nextCheckMs);
    expect(later.nextCheckMs).toBeGreaterThanOrEqual(DEFAULT_GATE_CONFIG.minNextCheckMs);
    expect(early.nextCheckMs).toBeLessThanOrEqual(DEFAULT_GATE_CONFIG.maxNextCheckMs);
  });

  it('does not prove zone dwell when location uncertainty reaches the boundary', () => {
    const decision = makeGate({
      sensingGate: { movingIntervalMs: MINUTE },
    }).shouldAcquire({
      now: NOW,
      lastFix: { lat: 0, lon: 0, timestamp: NOW - MINUTE, accuracy: 120 },
      motion: 'walking',
    });

    expect(decision).toEqual({
      acquire: true,
      mode: 'gnss',
      nextCheckMs: 0,
      reason: 'due-moving',
    });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'treats invalid accuracy %s as unable to prove zone dwell',
    (accuracy) => {
      const decision = makeGate({
        sensingGate: { movingIntervalMs: MINUTE },
      }).shouldAcquire({
        now: NOW,
        lastFix: { lat: 0, lon: 0, timestamp: NOW - MINUTE, accuracy },
        motion: 'walking',
      });

      expect(decision.reason).toBe('due-moving');
      expect(decision.acquire).toBe(true);
    },
  );

  it('acquires once zone exit becomes plausible', () => {
    const decision = makeGate({
      sensingGate: { movingIntervalMs: MINUTE },
    }).shouldAcquire({
      now: NOW,
      lastFix: { lat: 0, lon: 0, timestamp: NOW - 200_000 },
      motion: 'walking',
    });

    expect(decision.acquire).toBe(true);
    expect(decision.mode).toBe('gnss');
    expect(decision.reason).toBe('due-moving');
  });

  it('applies stationary and moving cadence boundaries', () => {
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

    expect(stationaryWait).toMatchObject({ acquire: false, reason: 'cadence-wait' });
    expect(stationaryWait.nextCheckMs).toBe(20 * MINUTE);
    expect(stationaryDue).toMatchObject({ acquire: true, reason: 'due-stationary' });
    expect(movingWait).toMatchObject({ acquire: false, nextCheckMs: MINUTE });
    expect(movingDue).toMatchObject({ acquire: true, reason: 'due-moving' });
  });

  it('uses the moving cadence for unknown motion', () => {
    const decision = makeGate({}, []).shouldAcquire({
      now: NOW,
      lastFix: { lat: 1, lon: 1, timestamp: NOW - 5 * MINUTE },
      motion: 'unknown',
    });

    expect(decision).toMatchObject({ acquire: true, reason: 'due-moving' });
  });

  it('clamps a future fix timestamp to zero elapsed time', () => {
    const decision = makeGate({}, []).shouldAcquire({
      now: NOW,
      lastFix: { lat: 1, lon: 1, timestamp: NOW + MINUTE },
      motion: 'stationary',
    });

    expect(decision).toEqual({
      acquire: false,
      mode: 'skip',
      nextCheckMs: DEFAULT_GATE_CONFIG.stationaryIntervalMs,
      reason: 'cadence-wait',
    });
  });

  it('enforces the GNSS staleness floor at the exact boundary', () => {
    const decision = makeGate({ coarseOnly: true }).shouldAcquire({
      now: NOW,
      lastFix: { lat: 0, lon: 0, timestamp: NOW - 60 * MINUTE },
      motion: 'stationary',
      maxDisplacementM: 0,
    });

    expect(decision).toEqual({
      acquire: true,
      mode: 'gnss',
      nextCheckMs: 0,
      reason: 'staleness-floor',
    });
  });

  it('downgrades due acquisitions to network in coarse-only mode', () => {
    const decision = makeGate({ coarseOnly: true }, []).shouldAcquire({
      now: NOW,
      lastFix: { lat: 1, lon: 1, timestamp: NOW - 5 * MINUTE },
      motion: 'walking',
    });

    expect(decision).toMatchObject({
      acquire: true,
      mode: 'network',
      reason: 'due-moving',
    });
  });

  it('uses a caller displacement bound until the staleness floor', () => {
    const gate = makeGate();
    const longDwell = gate.shouldAcquire({
      now: NOW,
      lastFix: { lat: 0, lon: 0, timestamp: NOW - 45 * MINUTE },
      motion: 'stationary',
      maxDisplacementM: 3,
    });
    const pastFloor = gate.shouldAcquire({
      now: NOW,
      lastFix: { lat: 0, lon: 0, timestamp: NOW - 61 * MINUTE },
      motion: 'stationary',
      maxDisplacementM: 3,
    });
    const walkedOut = gate.shouldAcquire({
      now: NOW,
      lastFix: { lat: 0, lon: 0, timestamp: NOW - 45 * MINUTE },
      motion: 'stationary',
      maxDisplacementM: 250,
    });

    expect(longDwell).toMatchObject({ acquire: false, reason: 'zone-dwell' });
    expect(pastFloor).toMatchObject({ acquire: true, reason: 'staleness-floor' });
    expect(walkedOut).toMatchObject({ acquire: true, reason: 'due-stationary' });
  });

  it('snapshots sensitive zones when the gate is created', () => {
    const zones = [{ ...home }];
    const gate = makeGate({}, zones);
    zones[0].radiusM = 0;
    zones.length = 0;

    const decision = gate.shouldAcquire({
      now: NOW,
      lastFix: { lat: 0, lon: 0, timestamp: NOW - MINUTE },
      motion: 'walking',
    });

    expect(decision.reason).toBe('zone-dwell');
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to the motion displacement bound for invalid value %s',
    (maxDisplacementM) => {
      const decision = makeGate().shouldAcquire({
        now: NOW,
        lastFix: { lat: 0, lon: 0, timestamp: NOW - 45 * MINUTE },
        motion: 'stationary',
        maxDisplacementM,
      });

      expect(decision.reason).toBe('due-stationary');
    },
  );
});

describe('createSensingGateController', () => {
  it('records successful acquisitions and skips the acquirer until due', async () => {
    const controller = createSensingGateController(DEFAULT_PRIVACY_CONFIG, []);
    const acquiredFix = {
      lat: 35,
      lon: 139,
      timestamp: NOW,
      accuracy: 25,
    };
    const modes: Array<'gnss' | 'network'> = [];
    const acquirer = {
      async acquire(mode: 'gnss' | 'network') {
        modes.push(mode);
        return acquiredFix;
      },
    };

    const first = await runSensingCycle(
      controller,
      { now: NOW, motion: 'unknown' },
      acquirer,
    );
    const second = await runSensingCycle(
      controller,
      {
        now: NOW + MINUTE,
        motion: 'walking',
        displacementBoundDeltaM: 0,
      },
      acquirer,
    );

    expect(first).toEqual({
      decision: {
        acquire: true,
        mode: 'gnss',
        nextCheckMs: 0,
        reason: 'cold-start',
      },
      fix: acquiredFix,
    });
    expect(second).toMatchObject({
      decision: { acquire: false, reason: 'cadence-wait' },
      fix: null,
    });
    expect(modes).toEqual(['gnss']);
    expect(controller.getState()).toEqual({
      lastFix: acquiredFix,
      maxDisplacementM: 0,
      lastCheckAt: NOW + MINUTE,
    });
  });

  it('uses the network acquirer when a coarse-only policy is due', async () => {
    const controller = createSensingGateController(
      { coarseOnly: true },
      [],
      { lat: 35, lon: 139, timestamp: NOW - 5 * MINUTE },
    );
    const modes: Array<'gnss' | 'network'> = [];

    const result = await runSensingCycle(
      controller,
      {
        now: NOW,
        motion: 'walking',
        displacementBoundDeltaM: 0,
      },
      {
        async acquire(mode) {
          modes.push(mode);
          return { lat: 35.1, lon: 139.1, timestamp: NOW };
        },
      },
    );

    expect(result.decision).toMatchObject({
      acquire: true,
      mode: 'network',
      reason: 'due-moving',
    });
    expect(modes).toEqual(['network']);
    expect(controller.getState().lastFix).toEqual(result.fix);
  });

  it('accumulates conservative displacement increments since the last fix', () => {
    const controller = createSensingGateController(
      DEFAULT_PRIVACY_CONFIG,
      [home],
      { lat: 0, lon: 0, timestamp: NOW },
    );

    const first = controller.shouldAcquire({
      now: NOW + MINUTE,
      motion: 'stationary',
      displacementBoundDeltaM: 4,
    });
    const second = controller.shouldAcquire({
      now: NOW + 2 * MINUTE,
      motion: 'stationary',
      displacementBoundDeltaM: 6,
    });

    expect(first.reason).toBe('zone-dwell');
    expect(second.reason).toBe('zone-dwell');
    expect(controller.getState()).toMatchObject({
      maxDisplacementM: 10,
      lastCheckAt: NOW + 2 * MINUTE,
    });
  });

  it('falls back to the policy motion bound for invalid increments', () => {
    const controller = createSensingGateController(
      DEFAULT_PRIVACY_CONFIG,
      [home],
      { lat: 0, lon: 0, timestamp: NOW },
    );

    controller.shouldAcquire({
      now: NOW + MINUTE,
      motion: 'walking',
      displacementBoundDeltaM: Number.NaN,
    });

    expect(controller.getState().maxDisplacementM).toBe(90);
  });

  it('applies sensitive-place updates to later decisions', () => {
    const initialFix = { lat: 0, lon: 0, timestamp: NOW - MINUTE };
    const controller = createSensingGateController(
      { sensingGate: { movingIntervalMs: MINUTE } },
      [],
      initialFix,
    );

    expect(controller.shouldAcquire({
      now: NOW,
      motion: 'walking',
      displacementBoundDeltaM: 0,
    }).reason).toBe('due-moving');

    controller.updateSensitivePlaces([home]);
    controller.recordFix(initialFix);

    expect(controller.shouldAcquire({
      now: NOW,
      motion: 'walking',
      displacementBoundDeltaM: 0,
    }).reason).toBe('zone-dwell');
  });

  it('keeps the previous fix when acquisition fails', async () => {
    const initialFix = { lat: 1, lon: 1, timestamp: NOW - 5 * MINUTE };
    const controller = createSensingGateController(
      DEFAULT_PRIVACY_CONFIG,
      [],
      initialFix,
    );

    await expect(runSensingCycle(
      controller,
      {
        now: NOW,
        motion: 'walking',
        displacementBoundDeltaM: 0,
      },
      {
        async acquire() {
          throw new Error('unavailable');
        },
      },
    )).rejects.toThrow('unavailable');

    expect(controller.getState()).toEqual({
      lastFix: initialFix,
      maxDisplacementM: 0,
      lastCheckAt: NOW,
    });
  });

  it('returns state snapshots and resets to a cold start', () => {
    const controller = createSensingGateController(
      DEFAULT_PRIVACY_CONFIG,
      [],
      { lat: 1, lon: 1, timestamp: NOW },
    );
    const snapshot = controller.getState();
    snapshot.lastFix!.lat = 99;

    expect(controller.getState().lastFix?.lat).toBe(1);

    controller.reset();

    expect(controller.getState()).toEqual({
      lastFix: null,
      maxDisplacementM: 0,
      lastCheckAt: null,
    });
    expect(controller.shouldAcquire({
      now: NOW + MINUTE,
      motion: 'stationary',
    }).reason).toBe('cold-start');
  });
});
