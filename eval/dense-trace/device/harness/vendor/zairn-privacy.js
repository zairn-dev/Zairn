"use strict";
var ZairnPrivacy = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // ../../../packages/sdk/dist/privacy-location.js
  var privacy_location_exports = {};
  __export(privacy_location_exports, {
    AdaptiveReporter: () => AdaptiveReporter,
    DEFAULT_GATE_CONFIG: () => DEFAULT_GATE_CONFIG,
    DEFAULT_PRIVACY_CONFIG: () => DEFAULT_PRIVACY_CONFIG,
    FixedRateReporter: () => FixedRateReporter,
    FrequencyBudget: () => FrequencyBudget,
    addPlanarLaplaceNoise: () => addPlanarLaplaceNoise,
    bucketizeDistance: () => bucketizeDistance,
    createPrivacyProcessor: () => createPrivacyProcessor,
    createSensingGate: () => createSensingGate,
    detectSensitivePlaces: () => detectSensitivePlaces,
    gridSnap: () => gridSnap,
    jitterDepartureTime: () => jitterDepartureTime,
    obfuscateLocation: () => obfuscateLocation,
    processLocation: () => processLocation,
    validatePrivacyConfig: () => validatePrivacyConfig
  });
  var DEFAULT_GATE_CONFIG = {
    stationaryIntervalMs: 30 * 60 * 1e3,
    movingIntervalMs: 5 * 60 * 1e3,
    maxStalenessMs: 60 * 60 * 1e3,
    minNextCheckMs: 30 * 1e3,
    maxNextCheckMs: 10 * 60 * 1e3
  };
  var DEFAULT_PRIVACY_CONFIG = {
    autoDetectSensitivePlaces: true,
    minVisitsForSensitive: 5,
    minDwellMinutes: 60,
    defaultZoneRadiusM: 200,
    defaultBufferRadiusM: 1e3,
    nightHoursStart: 22,
    nightHoursEnd: 6,
    baseEpsilon: Math.LN2 / 500,
    // ln(2)-indist within 500m
    gridSizeM: 500,
    gridSeed: "",
    maxReportsPerHourMoving: 12,
    maxReportsPerHourStationary: 2,
    departureJitterMinMinutes: 5,
    departureJitterMaxMinutes: 15,
    coarseOnly: false,
    sensingGate: DEFAULT_GATE_CONFIG,
    zoneRules: {
      home: { coreMode: "state-only", bufferNoiseMultiplier: 10, stateLabel: "At home" },
      work: { coreMode: "state-only", bufferNoiseMultiplier: 10, stateLabel: "At work" },
      school: { coreMode: "state-only", bufferNoiseMultiplier: 5, stateLabel: "At school" },
      medical: { coreMode: "suppress", bufferNoiseMultiplier: 20 },
      custom: { coreMode: "state-only", bufferNoiseMultiplier: 3, stateLabel: "Nearby" }
    }
  };
  function lambertWm1(x) {
    if (x >= 0 || x < -1 / Math.E)
      return NaN;
    let w = x < -0.3 ? -1 - Math.sqrt(2 * (1 + Math.E * x)) : Math.log(-x) - Math.log(-Math.log(-x));
    for (let i = 0; i < 20; i++) {
      const ew = Math.exp(w);
      const wew = w * ew;
      const f = wew - x;
      const fp = ew * (w + 1);
      const fpp = ew * (w + 2);
      const delta = f / (fp - f * fpp / (2 * fp));
      w -= delta;
      if (Math.abs(delta) < 1e-12)
        break;
    }
    return w;
  }
  function samplePlanarLaplaceRadius(epsilon) {
    const p = Math.random();
    const w = lambertWm1((p - 1) / Math.E);
    return -(1 / epsilon) * (w + 1);
  }
  function addPlanarLaplaceNoise(lat, lon, epsilon) {
    const theta = Math.random() * 2 * Math.PI;
    const rMeters = samplePlanarLaplaceRadius(epsilon);
    const dLat = rMeters * Math.cos(theta) / 111320;
    const dLon = rMeters * Math.sin(theta) / (111320 * Math.cos(lat * Math.PI / 180));
    return { lat: lat + dLat, lon: lon + dLon };
  }
  function gridSnap(lat, lon, gridSizeM, gridSeed) {
    const seedHash = fnv1a(gridSeed);
    const offsetLat = (seedHash & 65535) / 65535 * (gridSizeM / 111320);
    const offsetLon = (seedHash >> 16 & 65535) / 65535 * (gridSizeM / (111320 * Math.cos(lat * Math.PI / 180)));
    const gridLat = gridSizeM / 111320;
    const gridLon = gridSizeM / (111320 * Math.cos(lat * Math.PI / 180));
    const cellRow = Math.floor((lat + offsetLat) / gridLat);
    const cellCol = Math.floor((lon + offsetLon) / gridLon);
    const snappedLat = (cellRow + 0.5) * gridLat - offsetLat;
    const snappedLon = (cellCol + 0.5) * gridLon - offsetLon;
    const cellId = `${(seedHash & 255).toString(16)}:${cellRow}:${cellCol}`;
    return { lat: snappedLat, lon: snappedLon, cellId };
  }
  function detectSensitivePlaces(history, config = DEFAULT_PRIVACY_CONFIG) {
    if (history.length < 10)
      return [];
    const stayPoints = extractStayPoints(history, 50, 10);
    if (stayPoints.length === 0)
      return [];
    const clusters = clusterStayPoints(stayPoints, config.defaultZoneRadiusM);
    const places = [];
    let id = 0;
    for (const cluster of clusters) {
      if (cluster.points.length < config.minVisitsForSensitive)
        continue;
      const avgDwell = cluster.points.reduce((sum, sp) => sum + (sp.departureTime.getTime() - sp.arrivalTime.getTime()) / 6e4, 0) / cluster.points.length;
      if (avgDwell < config.minDwellMinutes)
        continue;
      const nightRatio = cluster.points.filter((sp) => sp.isNight).length / cluster.points.length;
      const weekdayDayRatio = cluster.points.filter((sp) => {
        const day = sp.arrivalTime.getDay();
        const hour = sp.arrivalTime.getHours();
        return day >= 1 && day <= 5 && hour >= 8 && hour <= 18;
      }).length / cluster.points.length;
      let label;
      if (nightRatio > 0.6)
        label = "home";
      else if (weekdayDayRatio > 0.5)
        label = "work";
      else
        label = "custom";
      places.push({
        id: `sp-${id++}`,
        label,
        lat: cluster.centerLat,
        lon: cluster.centerLon,
        radiusM: config.defaultZoneRadiusM,
        bufferRadiusM: config.defaultBufferRadiusM,
        visitCount: cluster.points.length,
        avgDwellMinutes: Math.round(avgDwell)
      });
    }
    return places;
  }
  function extractStayPoints(history, distThresholdM, timeThresholdMin) {
    const points = [];
    let i = 0;
    while (i < history.length) {
      let j = i + 1;
      while (j < history.length) {
        if (haversine(history[i].lat, history[i].lon, history[j].lat, history[j].lon) > distThresholdM)
          break;
        j++;
      }
      const arrival = new Date(history[i].timestamp);
      const departure = new Date(history[j - 1].timestamp);
      if ((departure.getTime() - arrival.getTime()) / 6e4 >= timeThresholdMin) {
        let sLat = 0, sLon = 0;
        for (let k = i; k < j; k++) {
          sLat += history[k].lat;
          sLon += history[k].lon;
        }
        const cnt = j - i;
        const hour = arrival.getHours();
        points.push({
          lat: sLat / cnt,
          lon: sLon / cnt,
          arrivalTime: arrival,
          departureTime: departure,
          isNight: hour >= 22 || hour < 6
        });
      }
      i = j;
    }
    return points;
  }
  function clusterStayPoints(stayPoints, radiusM) {
    const clusters = [];
    const assigned = /* @__PURE__ */ new Set();
    for (let i = 0; i < stayPoints.length; i++) {
      if (assigned.has(i))
        continue;
      const cluster = [stayPoints[i]];
      assigned.add(i);
      for (let j = i + 1; j < stayPoints.length; j++) {
        if (assigned.has(j))
          continue;
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
  function effectiveEpsilon(lat, lon, sensitivePlaces, config) {
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
          inCore: false
        };
      }
    }
    return { epsilon: config.baseEpsilon, zone: null, inCore: false };
  }
  var AdaptiveReporter = class {
    constructor(maxMoving = 12, maxStationary = 2) {
      this.lastReportedCell = null;
      this.lastReportTime = 0;
      this.stationaryCount = 0;
      this.reportTimestamps = [];
      this.maxMoving = maxMoving;
      this.maxStationary = maxStationary;
    }
    /**
     * Returns true if a report should be sent.
     */
    shouldReport(currentCellId) {
      const now = Date.now();
      const oneHourAgo = now - 36e5;
      this.reportTimestamps = this.reportTimestamps.filter((t) => t > oneHourAgo);
      const isMoving = currentCellId !== this.lastReportedCell;
      const maxPerHour = isMoving ? this.maxMoving : this.maxStationary;
      if (this.reportTimestamps.length >= maxPerHour)
        return false;
      if (!isMoving) {
        this.stationaryCount++;
        const minInterval = 5 * 60 * 1e3;
        const backoff = minInterval * Math.pow(2, Math.min(this.stationaryCount - 1, 6));
        if (now - this.lastReportTime < backoff)
          return false;
      } else {
        this.stationaryCount = 0;
      }
      return true;
    }
    /** Record a successful report */
    record(cellId) {
      this.lastReportedCell = cellId;
      this.lastReportTime = Date.now();
      this.reportTimestamps.push(Date.now());
    }
    /** Get remaining budget for this hour */
    remaining() {
      const now = Date.now();
      const recent = this.reportTimestamps.filter((t) => t > now - 36e5).length;
      return {
        moving: Math.max(0, this.maxMoving - recent),
        stationary: Math.max(0, this.maxStationary - recent)
      };
    }
  };
  var FixedRateReporter = class {
    constructor(intervalMs = 5 * 60 * 1e3, jitterMs = 30 * 1e3) {
      this.lastReportTime = 0;
      this.intervalMs = intervalMs;
      this.jitterMs = jitterMs;
    }
    shouldReport(_currentCellId) {
      const now = Date.now();
      const jitter = (Math.random() - 0.5) * 2 * this.jitterMs;
      const nextReportTime = this.lastReportTime + this.intervalMs + jitter;
      return now >= nextReportTime;
    }
    record(_cellId) {
      this.lastReportTime = Date.now();
    }
    remaining() {
      const now = Date.now();
      const ready = now - this.lastReportTime >= this.intervalMs - this.jitterMs;
      return { moving: ready ? 1 : 0, stationary: ready ? 1 : 0 };
    }
  };
  function jitterDepartureTime(actualDepartureTime, minJitterMinutes = 5, maxJitterMinutes = 15) {
    const jitter = minJitterMinutes + Math.random() * (maxJitterMinutes - minJitterMinutes);
    return new Date(actualDepartureTime.getTime() + jitter * 6e4);
  }
  function bucketizeDistance(distanceM) {
    if (distanceM < 100)
      return "nearby";
    if (distanceM < 500)
      return "<500m";
    if (distanceM < 1e3)
      return "<1km";
    if (distanceM < 2e3)
      return "1-2km";
    if (distanceM < 5e3)
      return "2-5km";
    if (distanceM < 1e4)
      return "5-10km";
    if (distanceM < 5e4)
      return "10-50km";
    return ">50km";
  }
  function validatePrivacyConfig(config) {
    if (config.baseEpsilon <= 0) {
      throw new RangeError(`baseEpsilon must be positive (got ${config.baseEpsilon}). Recommended: Math.LN2 / 500 \u2248 0.001386 for 500m privacy radius.`);
    }
    if (config.gridSizeM <= 0) {
      throw new RangeError(`gridSizeM must be positive (got ${config.gridSizeM}).`);
    }
    if (!config.gridSeed) {
      throw new RangeError(`gridSeed must be a non-empty string (per-user unique). Without it, all users share the same grid, enabling cross-user correlation attacks.`);
    }
    if (config.defaultZoneRadiusM < 0) {
      throw new RangeError(`defaultZoneRadiusM must be non-negative (got ${config.defaultZoneRadiusM}).`);
    }
    if (config.defaultBufferRadiusM < config.defaultZoneRadiusM) {
      throw new RangeError(`defaultBufferRadiusM (${config.defaultBufferRadiusM}) should be >= defaultZoneRadiusM (${config.defaultZoneRadiusM}).`);
    }
    if (config.maxReportsPerHourMoving <= 0 || config.maxReportsPerHourStationary <= 0) {
      throw new RangeError(`maxReportsPerHour values must be positive.`);
    }
  }
  var MOTION_SPEED_MPS = {
    stationary: 0.5,
    walking: 1.5,
    driving: 15,
    unknown: 1.5
  };
  function createSensingGate(config = DEFAULT_PRIVACY_CONFIG, sensitivePlaces = []) {
    const gateConfig = normalizeSensingGateConfig(config);
    const coarseOnly = config.coarseOnly ?? false;
    return {
      shouldAcquire(input) {
        if (!input.lastFix) {
          return acquire("gnss", "cold-start");
        }
        const elapsedMs = Math.max(0, input.now - input.lastFix.timestamp);
        if (elapsedMs >= gateConfig.maxStalenessMs) {
          return acquire("gnss", "staleness-floor");
        }
        const zoneDwellMs = zoneDwellNextCheckMs(input.lastFix, elapsedMs, input.motion, input.maxDisplacementM, sensitivePlaces, gateConfig);
        if (zoneDwellMs !== null) {
          return skip(zoneDwellMs, "zone-dwell");
        }
        const stationary = input.motion === "stationary";
        const intervalMs = stationary ? gateConfig.stationaryIntervalMs : gateConfig.movingIntervalMs;
        if (elapsedMs < intervalMs) {
          return skip(intervalMs - elapsedMs, "cadence-wait");
        }
        return acquire(coarseOnly ? "network" : "gnss", stationary ? "due-stationary" : "due-moving");
      }
    };
  }
  function processLocation(rawLat, rawLon, sensitivePlaces, config, reporter, viewerLocation) {
    const { epsilon, zone, inCore } = effectiveEpsilon(rawLat, rawLon, sensitivePlaces, config);
    if (inCore && zone) {
      const rule = config.zoneRules[zone.label];
      if (rule?.coreMode === "suppress") {
        return { type: "suppressed", reason: "privacy_zone" };
      }
      return { type: "state", label: rule?.stateLabel ?? "Nearby" };
    }
    const noisy = addPlanarLaplaceNoise(rawLat, rawLon, epsilon);
    const snapped = gridSnap(noisy.lat, noisy.lon, config.gridSizeM, config.gridSeed);
    if (!reporter.shouldReport(snapped.cellId)) {
      return { type: "suppressed", reason: "budget_exhausted" };
    }
    reporter.record(snapped.cellId);
    if (viewerLocation) {
      const dist = haversine(rawLat, rawLon, viewerLocation.lat, viewerLocation.lon);
      if (dist > 5e3) {
        return { type: "proximity", distanceBucket: bucketizeDistance(dist) };
      }
    }
    return {
      type: "coarse",
      lat: snapped.lat,
      lon: snapped.lon,
      cellId: snapped.cellId,
      gridSizeM: config.gridSizeM
    };
  }
  function createPrivacyProcessor(config, sensitivePlaces = []) {
    validatePrivacyConfig(config);
    const reporter = new AdaptiveReporter(config.maxReportsPerHourMoving, config.maxReportsPerHourStationary);
    return {
      /**
       * Process a raw location into a privacy-safe LocationState.
       * Never returns raw coordinates.
       */
      process(rawLat, rawLon, viewerLocation) {
        return processLocation(rawLat, rawLon, sensitivePlaces, config, reporter, viewerLocation);
      },
      /** Update the list of sensitive places (e.g., after auto-detection). */
      updateSensitivePlaces(places) {
        sensitivePlaces = places;
      },
      /** Get remaining reporting budget for this hour. */
      budget() {
        return reporter.remaining();
      }
    };
  }
  var FrequencyBudget = class {
    constructor(maxPerHour = 12) {
      this.reporter = new AdaptiveReporter(maxPerHour, maxPerHour);
    }
    canUpdate() {
      return this.reporter.shouldReport("_");
    }
    record() {
      this.reporter.record("_");
    }
    remaining() {
      return this.reporter.remaining().moving;
    }
  };
  function obfuscateLocation(lat, lon, gridSizeM, gridSeed, sensitivePlaces = []) {
    const snapped = gridSnap(lat, lon, gridSizeM, gridSeed);
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
  function acquire(mode, reason) {
    return { acquire: true, mode, nextCheckMs: 0, reason };
  }
  function skip(nextCheckMs, reason) {
    return { acquire: false, mode: "skip", nextCheckMs, reason };
  }
  function normalizeSensingGateConfig(config) {
    const gate = config.sensingGate ?? {};
    const minNextCheckMs = positiveOrDefault(gate.minNextCheckMs, DEFAULT_GATE_CONFIG.minNextCheckMs);
    const maxNextCheckMs = Math.max(minNextCheckMs, positiveOrDefault(gate.maxNextCheckMs, DEFAULT_GATE_CONFIG.maxNextCheckMs));
    return {
      stationaryIntervalMs: positiveOrDefault(gate.stationaryIntervalMs, intervalFromReportsPerHour(config.maxReportsPerHourStationary, DEFAULT_GATE_CONFIG.stationaryIntervalMs)),
      movingIntervalMs: positiveOrDefault(gate.movingIntervalMs, intervalFromReportsPerHour(config.maxReportsPerHourMoving, DEFAULT_GATE_CONFIG.movingIntervalMs)),
      maxStalenessMs: positiveOrDefault(gate.maxStalenessMs, DEFAULT_GATE_CONFIG.maxStalenessMs),
      minNextCheckMs,
      maxNextCheckMs
    };
  }
  function intervalFromReportsPerHour(maxReportsPerHour, fallbackMs) {
    if (!Number.isFinite(maxReportsPerHour) || maxReportsPerHour === void 0 || maxReportsPerHour <= 0) {
      return fallbackMs;
    }
    return 60 * 60 * 1e3 / maxReportsPerHour;
  }
  function positiveOrDefault(value, fallback) {
    return Number.isFinite(value) && value !== void 0 && value > 0 ? value : fallback;
  }
  function zoneDwellNextCheckMs(lastFix, elapsedMs, motion, maxDisplacementM, sensitivePlaces, gateConfig) {
    const speedMps = MOTION_SPEED_MPS[motion];
    const displacementM = maxDisplacementM ?? elapsedMs / 1e3 * speedMps;
    let earliestExitMs = null;
    for (const place of sensitivePlaces) {
      const dist = haversine(lastFix.lat, lastFix.lon, place.lat, place.lon);
      if (dist > place.radiusM)
        continue;
      const remainingInsideM = place.radiusM - dist - displacementM;
      if (remainingInsideM <= 0)
        continue;
      const exitMs = remainingInsideM / speedMps * 1e3;
      earliestExitMs = earliestExitMs === null ? exitMs : Math.min(earliestExitMs, exitMs);
    }
    return earliestExitMs === null ? null : boundedNextCheck(earliestExitMs, gateConfig);
  }
  function boundedNextCheck(nextCheckMs, gateConfig) {
    return Math.round(Math.min(gateConfig.maxNextCheckMs, Math.max(gateConfig.minNextCheckMs, nextCheckMs)));
  }
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.min(1, Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function fnv1a(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }
  return __toCommonJS(privacy_location_exports);
})();
