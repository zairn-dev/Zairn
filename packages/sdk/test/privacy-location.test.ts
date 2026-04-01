import { describe, it, expect } from 'vitest';
import {
  detectSensitivePlaces,
  obfuscateLocation,
  processLocation,
  FrequencyBudget,
  jitterDepartureTime,
  DEFAULT_PRIVACY_CONFIG,
} from '../src/privacy-location';
import type { SensitivePlace, PrivacyConfig } from '../src/privacy-location';

// ============================================================
// Sensitive Place Detection
// ============================================================

describe('detectSensitivePlaces', () => {
  it('returns empty for insufficient history', () => {
    const history = [{ lat: 35.68, lon: 139.76, timestamp: '2026-01-01T00:00:00Z' }];
    expect(detectSensitivePlaces(history)).toEqual([]);
  });

  it('detects home from nighttime repeated stays', () => {
    const history: Array<{ lat: number; lon: number; timestamp: string }> = [];
    const homeLat = 35.6812;
    const homeLon = 139.7671;

    // 10 nights: stay at home 23:00-01:00 (6 points every 20min), then leave
    for (let day = 0; day < 10; day++) {
      const base = new Date(2026, 0, day + 1, 23, 0, 0);
      for (let m = 0; m < 6; m++) {
        const t = new Date(base.getTime() + m * 20 * 60000);
        history.push({
          lat: homeLat + (Math.random() - 0.5) * 0.0001,
          lon: homeLon + (Math.random() - 0.5) * 0.0001,
          timestamp: t.toISOString(),
        });
      }
      // Leave (far away point to break the stay)
      const away = new Date(base.getTime() + 8 * 3600000);
      history.push({ lat: 35.66, lon: 139.70, timestamp: away.toISOString() });
    }

    history.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const config = {
      ...DEFAULT_PRIVACY_CONFIG,
      minVisitsForSensitive: 3,
      minDwellMinutes: 30,
    };
    const places = detectSensitivePlaces(history, config);
    const home = places.find(p => p.label === 'home');
    expect(home).toBeDefined();
    if (home) {
      // Detected home should be within 200m of actual
      const dist = haversine(home.lat, home.lon, homeLat, homeLon);
      expect(dist).toBeLessThan(200);
    }
  });
});

// ============================================================
// Anti-Averaging Obfuscation
// ============================================================

describe('obfuscateLocation', () => {
  const seed = 'user-abc-123';

  it('returns a different point than the input', () => {
    const result = obfuscateLocation(35.6812, 139.7671, 500, seed);
    // Should be offset from original
    const dist = haversine(result.lat, result.lon, 35.6812, 139.7671);
    expect(dist).toBeGreaterThan(0);
    expect(dist).toBeLessThan(1000); // within grid range
  });

  it('is deterministic (same input → same output)', () => {
    const a = obfuscateLocation(35.6812, 139.7671, 500, seed);
    const b = obfuscateLocation(35.6812, 139.7671, 500, seed);
    expect(a.lat).toBe(b.lat);
    expect(a.lon).toBe(b.lon);
  });

  it('does NOT converge to true location when averaged', () => {
    // Simulate 100 slightly different positions around the same spot
    const trueLat = 35.6812;
    const trueLon = 139.7671;
    let sumLat = 0, sumLon = 0;
    const n = 100;

    for (let i = 0; i < n; i++) {
      const jitteredLat = trueLat + (Math.random() - 0.5) * 0.001;
      const jitteredLon = trueLon + (Math.random() - 0.5) * 0.001;
      const result = obfuscateLocation(jitteredLat, jitteredLon, 500, seed);
      sumLat += result.lat;
      sumLon += result.lon;
    }

    const avgLat = sumLat / n;
    const avgLon = sumLon / n;
    const avgDist = haversine(avgLat, avgLon, trueLat, trueLon);

    // Average should NOT converge to true location
    // (it converges to grid cell center, which is offset)
    // We just verify it's not suspiciously close
    // With 500m grid, the expected offset from cell center is ~125m
    // The grid center itself is offset by the seed, so avg should
    // be offset from true location
    expect(avgDist).toBeGreaterThan(10); // at least 10m off
  });

  it('different seeds produce different grids', () => {
    const a = obfuscateLocation(35.6812, 139.7671, 500, 'user-1');
    const b = obfuscateLocation(35.6812, 139.7671, 500, 'user-2');
    // Different users should get different obfuscated points
    expect(a.lat !== b.lat || a.lon !== b.lon).toBe(true);
  });

  it('shifts away from sensitive places', () => {
    const home: SensitivePlace = {
      id: 'sp-0', label: 'home',
      lat: 35.6812, lon: 139.7671,
      radiusM: 200, visitCount: 30, avgDwellMinutes: 480,
    };

    const result = obfuscateLocation(35.6812, 139.7671, 500, seed, [home]);
    const distFromHome = haversine(result.lat, result.lon, home.lat, home.lon);
    // Should be pushed outside the privacy zone
    expect(distFromHome).toBeGreaterThan(100);
  });
});

// ============================================================
// Frequency Budget
// ============================================================

describe('FrequencyBudget', () => {
  it('allows updates within budget', () => {
    const budget = new FrequencyBudget(5);
    for (let i = 0; i < 5; i++) {
      expect(budget.canUpdate()).toBe(true);
      budget.record();
    }
    expect(budget.canUpdate()).toBe(false);
  });

  it('reports remaining correctly', () => {
    const budget = new FrequencyBudget(10);
    expect(budget.remaining()).toBe(10);
    budget.record();
    expect(budget.remaining()).toBe(9);
  });
});

// ============================================================
// Process Location (Integration)
// ============================================================

describe('processLocation', () => {
  const home: SensitivePlace = {
    id: 'sp-0', label: 'home',
    lat: 35.6812, lon: 139.7671,
    radiusM: 200, visitCount: 30, avgDwellMinutes: 480,
  };

  const config: PrivacyConfig = {
    ...DEFAULT_PRIVACY_CONFIG,
    gridSeed: 'test-seed',
  };

  it('suppresses location inside medical zone', () => {
    const medical: SensitivePlace = {
      ...home, label: 'medical', id: 'sp-1',
    };
    const budget = new FrequencyBudget(12);
    const result = processLocation(
      medical.lat, medical.lon, [medical], config, budget
    );
    expect(result.type).toBe('suppressed');
  });

  it('returns state-only inside home zone', () => {
    const budget = new FrequencyBudget(12);
    const result = processLocation(
      home.lat, home.lon, [home], config, budget
    );
    expect(result.type).toBe('state');
    if (result.type === 'state') {
      expect(result.label).toBe('At home');
    }
  });

  it('returns coarse location outside all zones', () => {
    const budget = new FrequencyBudget(12);
    // Shibuya station (far from home)
    const result = processLocation(
      35.6580, 139.7016, [home], config, budget
    );
    expect(result.type).toBe('coarse');
  });

  it('returns proximity when viewer is far', () => {
    const budget = new FrequencyBudget(12);
    const result = processLocation(
      35.6580, 139.7016, [], config, budget,
      { lat: 35.7, lon: 140.0 } // viewer is ~30km away
    );
    expect(result.type).toBe('proximity');
  });
});

// ============================================================
// Jitter
// ============================================================

describe('jitterDepartureTime', () => {
  it('adds delay within range', () => {
    const actual = new Date('2026-01-01T08:00:00Z');
    const jittered = jitterDepartureTime(actual, 5, 15);
    const diffMin = (jittered.getTime() - actual.getTime()) / 60000;
    expect(diffMin).toBeGreaterThanOrEqual(5);
    expect(diffMin).toBeLessThanOrEqual(15);
  });
});

// ============================================================
// Helper
// ============================================================

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.min(1,
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2
  );
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
