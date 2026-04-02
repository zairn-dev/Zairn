/**
 * Privacy-preserving location sharing module
 *
 * Implements a formally-grounded, multi-layer defense against
 * long-term location inference attacks.
 *
 * Layer 1: Planar Laplace mechanism (ε-geo-indistinguishability)
 *          [Andrés et al., CCS 2013]
 * Layer 2: Deterministic grid snap (display consistency + sub-grid hiding)
 * Layer 3: Sensitive place detection (on-device only)
 * Layer 4: Graduated privacy zones (PriSTE-inspired noise amplification)
 *          [Cao et al., ICDE 2019]
 * Layer 5: Temporally-aware adaptive reporting (exponential backoff)
 *          [Cao et al., arXiv 2017 — temporal DP correlation]
 * Layer 6: API hardening (no distances, cell IDs only)
 *          [Dhondt et al., USENIX Security 2024]
 *
 * Key insight from de Montjoye et al. (Nature 2013): 4 spatiotemporal
 * points uniquely identify 95% of people. Deterministic obfuscation
 * (grid snap alone) is fundamentally insufficient — formal DP noise
 * is required, combined with temporal budget management.
 */

// ============================================================
// Types
// ============================================================

export interface SensitivePlace {
  id: string;
  label: 'home' | 'work' | 'school' | 'medical' | 'custom';
  /** True center (never leaves device) */
  lat: number;
  lon: number;
  /** Privacy zone radius in meters */
  radiusM: number;
  /** Buffer zone radius (graduated noise area) */
  bufferRadiusM: number;
  visitCount: number;
  avgDwellMinutes: number;
}

export interface PrivacyZoneRule {
  /** What to share when inside the core zone */
  coreMode: 'suppress' | 'state-only';
  /** Noise multiplier in the buffer zone (e.g., 10 = 10x more noise) */
  bufferNoiseMultiplier: number;
  /** State label for state-only mode */
  stateLabel?: string;
}

export type LocationState =
  | { type: 'precise'; lat: number; lon: number; accuracy?: number }
  | { type: 'coarse'; lat: number; lon: number; cellId: string; gridSizeM: number }
  | { type: 'state'; label: string; since?: string }
  | { type: 'proximity'; distanceBucket: string }
  | { type: 'suppressed'; reason: 'privacy_zone' | 'ghost_mode' | 'budget_exhausted' };

export interface PrivacyConfig {
  autoDetectSensitivePlaces: boolean;
  minVisitsForSensitive: number;
  minDwellMinutes: number;
  defaultZoneRadiusM: number;
  defaultBufferRadiusM: number;
  nightHoursStart: number;
  nightHoursEnd: number;
  /**
   * Base epsilon for Planar Laplace (per meter).
   * Recommended: ln(2)/500 ≈ 0.001386 for ln(2)-indistinguishability within 500m.
   * Smaller = more private but noisier.
   */
  baseEpsilon: number;
  /** Grid cell size in meters for display snap */
  gridSizeM: number;
  /** Per-user seed for grid offset (prevents cross-user correlation) */
  gridSeed: string;
  /** Max reports per hour when moving */
  maxReportsPerHourMoving: number;
  /** Max reports per hour when stationary */
  maxReportsPerHourStationary: number;
  /** Departure jitter range in minutes */
  departureJitterMinMinutes: number;
  departureJitterMaxMinutes: number;
  /** Zone rules per label */
  zoneRules: Record<string, PrivacyZoneRule>;
}

export const DEFAULT_PRIVACY_CONFIG: PrivacyConfig = {
  autoDetectSensitivePlaces: true,
  minVisitsForSensitive: 5,
  minDwellMinutes: 60,
  defaultZoneRadiusM: 200,
  defaultBufferRadiusM: 1000,
  nightHoursStart: 22,
  nightHoursEnd: 6,
  baseEpsilon: Math.LN2 / 500, // ln(2)-indist within 500m
  gridSizeM: 500,
  gridSeed: '',
  maxReportsPerHourMoving: 12,
  maxReportsPerHourStationary: 2,
  departureJitterMinMinutes: 5,
  departureJitterMaxMinutes: 15,
  zoneRules: {
    home: { coreMode: 'state-only', bufferNoiseMultiplier: 10, stateLabel: 'At home' },
    work: { coreMode: 'state-only', bufferNoiseMultiplier: 10, stateLabel: 'At work' },
    school: { coreMode: 'state-only', bufferNoiseMultiplier: 5, stateLabel: 'At school' },
    medical: { coreMode: 'suppress', bufferNoiseMultiplier: 20 },
    custom: { coreMode: 'state-only', bufferNoiseMultiplier: 3, stateLabel: 'Nearby' },
  },
};

// ============================================================
// Layer 1: Planar Laplace Mechanism
// ============================================================

/**
 * Lambert W function (W_{-1} branch) approximation.
 * Used for sampling from the Planar Laplace distribution.
 * Accurate to ~10^-8 for x in [-1/e, 0).
 */
function lambertWm1(x: number): number {
  // Approximation via Halley's method from initial estimate
  if (x >= 0 || x < -1 / Math.E) return NaN;
  // Initial estimate
  let w = x < -0.3 ? -1 - Math.sqrt(2 * (1 + Math.E * x)) : Math.log(-x) - Math.log(-Math.log(-x));
  // Halley's iterations
  for (let i = 0; i < 20; i++) {
    const ew = Math.exp(w);
    const wew = w * ew;
    const f = wew - x;
    const fp = ew * (w + 1);
    const fpp = ew * (w + 2);
    const delta = f / (fp - (f * fpp) / (2 * fp));
    w -= delta;
    if (Math.abs(delta) < 1e-12) break;
  }
  return w;
}

/**
 * Sample radius from the Planar Laplace distribution.
 * CDF inverse: r = -(1/ε) * (W_{-1}((p-1)/e) + 1)
 */
function samplePlanarLaplaceRadius(epsilon: number): number {
  const p = Math.random();
  const w = lambertWm1((p - 1) / Math.E);
  return -(1 / epsilon) * (w + 1);
}

/**
 * Add Planar Laplace noise to a coordinate.
 * Provides ε-geo-indistinguishability: for any two points x, x',
 * Pr(output | x) ≤ e^(ε·d(x,x')) · Pr(output | x')
 *
 * @param epsilon Privacy parameter per meter. Smaller = more private.
 *   Recommended: ln(2)/500 for ln(2)-indist within 500m.
 */
export function addPlanarLaplaceNoise(
  lat: number,
  lon: number,
  epsilon: number,
): { lat: number; lon: number } {
  const theta = Math.random() * 2 * Math.PI;
  const rMeters = samplePlanarLaplaceRadius(epsilon);

  const dLat = (rMeters * Math.cos(theta)) / 111320;
  const dLon = (rMeters * Math.sin(theta)) / (111320 * Math.cos(lat * Math.PI / 180));

  return { lat: lat + dLat, lon: lon + dLon };
}

// ============================================================
// Layer 2: Grid Snap (deterministic, per-user offset)
// ============================================================

/**
 * Snap a (noisy) coordinate to a grid cell.
 * The grid is offset per-user to prevent cross-user grid alignment
 * (which would enable boundary-detection trilateration).
 *
 * Returns both the snapped coordinate AND a cell ID string.
 * API should expose cell ID, never raw coordinates.
 */
export function gridSnap(
  lat: number,
  lon: number,
  gridSizeM: number,
  gridSeed: string,
): { lat: number; lon: number; cellId: string } {
  const seedHash = fnv1a(gridSeed);
  const offsetLat = ((seedHash & 0xFFFF) / 0xFFFF) * (gridSizeM / 111320);
  const offsetLon = (((seedHash >> 16) & 0xFFFF) / 0xFFFF) *
    (gridSizeM / (111320 * Math.cos(lat * Math.PI / 180)));

  const gridLat = gridSizeM / 111320;
  const gridLon = gridSizeM / (111320 * Math.cos(lat * Math.PI / 180));

  const cellRow = Math.floor((lat + offsetLat) / gridLat);
  const cellCol = Math.floor((lon + offsetLon) / gridLon);

  const snappedLat = (cellRow + 0.5) * gridLat - offsetLat;
  const snappedLon = (cellCol + 0.5) * gridLon - offsetLon;

  // Cell ID includes seed hash prefix to prevent cross-user cell matching
  const cellId = `${(seedHash & 0xFF).toString(16)}:${cellRow}:${cellCol}`;

  return { lat: snappedLat, lon: snappedLon, cellId };
}

// ============================================================
// Layer 3: Sensitive Place Detection (on-device)
// ============================================================

interface StayPoint {
  lat: number;
  lon: number;
  arrivalTime: Date;
  departureTime: Date;
  isNight: boolean;
}

/**
 * Detect sensitive places from location history.
 * Runs entirely on-device — no data leaves the client.
 */
export function detectSensitivePlaces(
  history: Array<{ lat: number; lon: number; timestamp: string }>,
  config: PrivacyConfig = DEFAULT_PRIVACY_CONFIG,
): SensitivePlace[] {
  if (history.length < 10) return [];

  const stayPoints = extractStayPoints(history, 50, 10);
  if (stayPoints.length === 0) return [];

  const clusters = clusterStayPoints(stayPoints, config.defaultZoneRadiusM);
  const places: SensitivePlace[] = [];
  let id = 0;

  for (const cluster of clusters) {
    if (cluster.points.length < config.minVisitsForSensitive) continue;

    const avgDwell = cluster.points.reduce(
      (sum, sp) => sum + (sp.departureTime.getTime() - sp.arrivalTime.getTime()) / 60000,
      0
    ) / cluster.points.length;

    if (avgDwell < config.minDwellMinutes) continue;

    const nightRatio = cluster.points.filter(sp => sp.isNight).length / cluster.points.length;
    const weekdayDayRatio = cluster.points.filter(sp => {
      const day = sp.arrivalTime.getDay();
      const hour = sp.arrivalTime.getHours();
      return day >= 1 && day <= 5 && hour >= 8 && hour <= 18;
    }).length / cluster.points.length;

    let label: SensitivePlace['label'];
    if (nightRatio > 0.6) label = 'home';
    else if (weekdayDayRatio > 0.5) label = 'work';
    else label = 'custom';

    places.push({
      id: `sp-${id++}`,
      label,
      lat: cluster.centerLat,
      lon: cluster.centerLon,
      radiusM: config.defaultZoneRadiusM,
      bufferRadiusM: config.defaultBufferRadiusM,
      visitCount: cluster.points.length,
      avgDwellMinutes: Math.round(avgDwell),
    });
  }

  return places;
}

function extractStayPoints(
  history: Array<{ lat: number; lon: number; timestamp: string }>,
  distThresholdM: number,
  timeThresholdMin: number,
): StayPoint[] {
  const points: StayPoint[] = [];
  let i = 0;
  while (i < history.length) {
    let j = i + 1;
    while (j < history.length) {
      if (haversine(history[i].lat, history[i].lon, history[j].lat, history[j].lon) > distThresholdM) break;
      j++;
    }
    const arrival = new Date(history[i].timestamp);
    const departure = new Date(history[j - 1].timestamp);
    if ((departure.getTime() - arrival.getTime()) / 60000 >= timeThresholdMin) {
      let sLat = 0, sLon = 0;
      for (let k = i; k < j; k++) { sLat += history[k].lat; sLon += history[k].lon; }
      const cnt = j - i;
      const hour = arrival.getHours();
      points.push({
        lat: sLat / cnt, lon: sLon / cnt,
        arrivalTime: arrival, departureTime: departure,
        isNight: hour >= 22 || hour < 6,
      });
    }
    i = j;
  }
  return points;
}

interface Cluster { centerLat: number; centerLon: number; points: StayPoint[] }

function clusterStayPoints(stayPoints: StayPoint[], radiusM: number): Cluster[] {
  const clusters: Cluster[] = [];
  const assigned = new Set<number>();
  for (let i = 0; i < stayPoints.length; i++) {
    if (assigned.has(i)) continue;
    const cluster: StayPoint[] = [stayPoints[i]];
    assigned.add(i);
    for (let j = i + 1; j < stayPoints.length; j++) {
      if (assigned.has(j)) continue;
      if (haversine(stayPoints[i].lat, stayPoints[i].lon, stayPoints[j].lat, stayPoints[j].lon) <= radiusM) {
        cluster.push(stayPoints[j]);
        assigned.add(j);
      }
    }
    const sLat = cluster.reduce((s, p) => s + p.lat, 0);
    const sLon = cluster.reduce((s, p) => s + p.lon, 0);
    clusters.push({ centerLat: sLat / cluster.length, centerLon: sLon / cluster.length, points: cluster });
  }
  return clusters;
}

// ============================================================
// Layer 4: Graduated Privacy Zones
// ============================================================

/**
 * Compute the effective epsilon for a location relative to sensitive places.
 * Inside core zone: returns 0 (suppress or state-only).
 * Inside buffer zone: epsilon is divided by the noise multiplier.
 * Outside all zones: returns base epsilon.
 */
function effectiveEpsilon(
  lat: number,
  lon: number,
  sensitivePlaces: SensitivePlace[],
  config: PrivacyConfig,
): { epsilon: number; zone: SensitivePlace | null; inCore: boolean } {
  for (const place of sensitivePlaces) {
    const dist = haversine(lat, lon, place.lat, place.lon);
    const rule = config.zoneRules[place.label];

    if (dist <= place.radiusM) {
      return { epsilon: 0, zone: place, inCore: true };
    }

    if (dist <= place.bufferRadiusM && rule) {
      return {
        epsilon: config.baseEpsilon / rule.bufferNoiseMultiplier,
        zone: place,
        inCore: false,
      };
    }
  }

  return { epsilon: config.baseEpsilon, zone: null, inCore: false };
}

// ============================================================
// Layer 5: Temporally-Aware Adaptive Reporting
// ============================================================

/**
 * Adaptive frequency controller.
 *
 * Key insight from Cao et al. (2017): when a user is stationary,
 * each additional report provides no new utility but linearly
 * degrades privacy (temporal accumulation). When moving, reports
 * break correlation and are utility-positive.
 *
 * Strategy:
 * - Moving: report at up to maxReportsPerHourMoving
 * - Stationary: exponential backoff, max maxReportsPerHourStationary
 */
export class AdaptiveReporter {
  private lastReportedCell: string | null = null;
  private lastReportTime: number = 0;
  private stationaryCount: number = 0;
  private reportTimestamps: number[] = [];
  private maxMoving: number;
  private maxStationary: number;

  constructor(maxMoving: number = 12, maxStationary: number = 2) {
    this.maxMoving = maxMoving;
    this.maxStationary = maxStationary;
  }

  /**
   * Returns true if a report should be sent.
   */
  shouldReport(currentCellId: string): boolean {
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    this.reportTimestamps = this.reportTimestamps.filter(t => t > oneHourAgo);

    const isMoving = currentCellId !== this.lastReportedCell;
    const maxPerHour = isMoving ? this.maxMoving : this.maxStationary;

    if (this.reportTimestamps.length >= maxPerHour) return false;

    if (!isMoving) {
      // Exponential backoff for stationary reports
      this.stationaryCount++;
      const minInterval = 5 * 60 * 1000; // 5 minutes
      const backoff = minInterval * Math.pow(2, Math.min(this.stationaryCount - 1, 6));
      if (now - this.lastReportTime < backoff) return false;
    } else {
      this.stationaryCount = 0;
    }

    return true;
  }

  /** Record a successful report */
  record(cellId: string): void {
    this.lastReportedCell = cellId;
    this.lastReportTime = Date.now();
    this.reportTimestamps.push(Date.now());
  }

  /** Get remaining budget for this hour */
  remaining(): { moving: number; stationary: number } {
    const now = Date.now();
    const recent = this.reportTimestamps.filter(t => t > now - 3600000).length;
    return {
      moving: Math.max(0, this.maxMoving - recent),
      stationary: Math.max(0, this.maxStationary - recent),
    };
  }
}

/**
 * Add jitter to departure time.
 */
export function jitterDepartureTime(
  actualDepartureTime: Date,
  minJitterMinutes: number = 5,
  maxJitterMinutes: number = 15,
): Date {
  const jitter = minJitterMinutes + Math.random() * (maxJitterMinutes - minJitterMinutes);
  return new Date(actualDepartureTime.getTime() + jitter * 60000);
}

// ============================================================
// Layer 6: Distance Bucketing (API hardening)
// ============================================================

/**
 * Convert exact distance to a coarse bucket string.
 * Prevents trilateration attacks via distance oracle.
 * [Dhondt et al., USENIX Security 2024]
 */
export function bucketizeDistance(distanceM: number): string {
  if (distanceM < 100) return 'nearby';
  if (distanceM < 500) return '<500m';
  if (distanceM < 1000) return '<1km';
  if (distanceM < 2000) return '1-2km';
  if (distanceM < 5000) return '2-5km';
  if (distanceM < 10000) return '5-10km';
  if (distanceM < 50000) return '10-50km';
  return '>50km';
}

// ============================================================
// Main Processor: Integrates All 6 Layers
// ============================================================

/**
 * Transform raw location into privacy-safe output.
 *
 * 1. Check graduated privacy zones (Layer 4)
 * 2. Check adaptive reporting budget (Layer 5)
 * 3. Add Planar Laplace noise with zone-adjusted ε (Layer 1)
 * 4. Snap to per-user grid (Layer 2)
 * 5. Return cell ID, not raw coordinates (Layer 6)
 */
export function processLocation(
  rawLat: number,
  rawLon: number,
  sensitivePlaces: SensitivePlace[],
  config: PrivacyConfig,
  reporter: AdaptiveReporter,
  viewerLocation?: { lat: number; lon: number },
): LocationState {
  // Layer 4: Graduated privacy zones
  const { epsilon, zone, inCore } = effectiveEpsilon(
    rawLat, rawLon, sensitivePlaces, config
  );

  if (inCore && zone) {
    const rule = config.zoneRules[zone.label];
    if (rule?.coreMode === 'suppress') {
      return { type: 'suppressed', reason: 'privacy_zone' };
    }
    return { type: 'state', label: rule?.stateLabel ?? 'Nearby' };
  }

  // Layer 1 + 4: Planar Laplace with zone-adjusted epsilon
  const noisy = addPlanarLaplaceNoise(rawLat, rawLon, epsilon);

  // Layer 2: Grid snap
  const snapped = gridSnap(noisy.lat, noisy.lon, config.gridSizeM, config.gridSeed);

  // Layer 5: Adaptive reporting
  if (!reporter.shouldReport(snapped.cellId)) {
    return { type: 'suppressed', reason: 'budget_exhausted' };
  }
  reporter.record(snapped.cellId);

  // Layer 6: Proximity bucketing for distant viewers
  if (viewerLocation) {
    const dist = haversine(rawLat, rawLon, viewerLocation.lat, viewerLocation.lon);
    if (dist > 5000) {
      return { type: 'proximity', distanceBucket: bucketizeDistance(dist) };
    }
  }

  return {
    type: 'coarse',
    lat: snapped.lat,
    lon: snapped.lon,
    cellId: snapped.cellId,
    gridSizeM: config.gridSizeM,
  };
}

// ============================================================
// Backward Compatibility Exports
// ============================================================

/** @deprecated Use AdaptiveReporter instead */
export class FrequencyBudget {
  private reporter: AdaptiveReporter;
  constructor(maxPerHour: number = 12) {
    this.reporter = new AdaptiveReporter(maxPerHour, maxPerHour);
  }
  canUpdate(): boolean { return this.reporter.shouldReport('_'); }
  record(): void { this.reporter.record('_'); }
  remaining(): number { return this.reporter.remaining().moving; }
}

/** @deprecated Use processLocation with Planar Laplace instead */
export function obfuscateLocation(
  lat: number, lon: number, gridSizeM: number, gridSeed: string,
  sensitivePlaces: SensitivePlace[] = [],
): { lat: number; lon: number } {
  const snapped = gridSnap(lat, lon, gridSizeM, gridSeed);
  // Shift away from sensitive places
  for (const place of sensitivePlaces) {
    if (haversine(snapped.lat, snapped.lon, place.lat, place.lon) < place.radiusM) {
      const gridLat = gridSizeM / 111320;
      const gridLon = gridSizeM / (111320 * Math.cos(lat * Math.PI / 180));
      const bearing = Math.atan2(snapped.lon - place.lon, snapped.lat - place.lat);
      return { lat: snapped.lat + Math.cos(bearing) * gridLat, lon: snapped.lon + Math.sin(bearing) * gridLon };
    }
  }
  return { lat: snapped.lat, lon: snapped.lon };
}

// ============================================================
// Helpers
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

/** FNV-1a hash for deterministic per-user grid offset */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
