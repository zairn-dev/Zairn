// Frozen copy of the trust scorer used for the submitted IoT-J manuscript
// (weighted-sum V1/V2, Table I weight profiles). Compiled from
// packages/geo-drop/src/trust-scorer.ts and geofence.ts at commit 663860f
// (2026-03-19). The live SDK scorer has since moved to log-odds fusion, so the
// revision evaluates this copy; do not edit it.

/**
 * Location Trust Scorer
 *
 * Pure functions that compute a trust score (0.0–1.0) from a current
 * location point and a short history of recent points. Used to gate
 * location-dependent actions (sendLocation, unlockDrop, findNearbyFriends).
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.min(1, Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2));
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// =====================
// Signal weights
// =====================
const WEIGHT_MOVEMENT = 0.5;
const WEIGHT_ACCURACY = 0.2;
const WEIGHT_TEMPORAL = 0.3;
// =====================
// Signal 1: Movement plausibility
// =====================
function scoreMovement(current, history) {
    if (history.length === 0)
        return 0.8; // no history, slightly penalized
    const prev = history[0]; // newest-first
    const dist = calculateDistance(prev.lat, prev.lon, current.lat, current.lon);
    const timeDiffMs = new Date(current.timestamp).getTime() - new Date(prev.timestamp).getTime();
    if (timeDiffMs <= 0)
        return 0.0; // impossible or replayed timestamp
    const speedMs = dist / (timeDiffMs / 1000);
    if (speedMs <= 50)
        return 1.0; // <= ~180 km/h
    if (speedMs <= 150)
        return 1.0 - 0.5 * ((speedMs - 50) / 100); // linear 1.0 → 0.5
    if (speedMs <= 300)
        return 0.5 - 0.4 * ((speedMs - 150) / 150); // linear 0.5 → 0.1
    return 0.0; // > 300 m/s
}
// =====================
// Signal 2: Accuracy anomaly
// =====================
function scoreAccuracy(current) {
    const acc = current.accuracy;
    if (acc === null || acc === undefined)
        return 0.5; // unknown
    if (acc < 2)
        return 0.3; // suspiciously precise (common in spoofing)
    if (acc <= 100)
        return 1.0; // normal GPS range
    if (acc <= 500)
        return 0.7; // degraded but plausible (indoors)
    return 0.4; // very poor
}
// =====================
// Signal 3: Temporal consistency
// =====================
function scoreTemporalConsistency(current, history) {
    if (history.length < 2)
        return 0.7; // insufficient data
    // Check consecutive pairs: current→h[0], h[0]→h[1], h[1]→h[2], ...
    const points = [current, ...history.slice(0, 4)];
    let violations = 0;
    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        const dist = calculateDistance(a.lat, a.lon, b.lat, b.lon);
        const dt = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
        if (dt <= 0) {
            violations++;
            continue;
        }
        const speed = dist / (dt / 1000);
        if (speed > 100)
            violations++; // 360 km/h threshold for "teleportation"
    }
    if (violations === 0)
        return 1.0;
    if (violations === 1)
        return 0.6;
    if (violations === 2)
        return 0.3;
    return 0.0;
}
// =====================
// Signal 4: RAIM-style fix consistency (V2)
// =====================
function scoreFixConsistency(recentFixes) {
    if (recentFixes.length < 3)
        return 0.8; // insufficient data
    const n = recentFixes.length;
    const meanLat = recentFixes.reduce((s, f) => s + f.lat, 0) / n;
    const meanLon = recentFixes.reduce((s, f) => s + f.lon, 0) / n;
    const meanAcc = recentFixes.reduce((s, f) => s + f.accuracy, 0) / n;
    const varLat = recentFixes.reduce((s, f) => s + (f.lat - meanLat) ** 2, 0) / n;
    const varLon = recentFixes.reduce((s, f) => s + (f.lon - meanLon) ** 2, 0) / n;
    // Convert stddev degrees → meters (lat: 111320 m/deg, lon: adjusted by cos(lat))
    const stdLatM = Math.sqrt(varLat) * 111320;
    const stdLonM = Math.sqrt(varLon) * 111320 * Math.cos((meanLat * Math.PI) / 180);
    const maxStd = Math.max(stdLatM, stdLonM);
    // Compare scatter against reported accuracy
    if (meanAcc <= 0)
        return 0.5; // avoid division by zero
    const ratio = maxStd / meanAcc;
    if (ratio <= 0.5)
        return 1.0;
    if (ratio <= 1.0)
        return 1.0 - 0.3 * ((ratio - 0.5) / 0.5); // 1.0 → 0.7
    if (ratio <= 2.0)
        return 0.7 - 0.3 * ((ratio - 1.0) / 1.0); // 0.7 → 0.4
    return 0.2;
}
// =====================
// Signal 5: Network position cross-check (V2)
// =====================
function scoreNetworkConsistency(current, hint) {
    const dist = calculateDistance(current.lat, current.lon, hint.lat, hint.lon);
    if (dist < hint.accuracy)
        return 1.0;
    if (dist < 2 * hint.accuracy)
        return 0.7;
    if (dist < 5 * hint.accuracy)
        return 0.5;
    return 0.3;
}
// =====================
// Public API
// =====================
/**
 * Compute a location trust score from a current point and recent history.
 *
 * @param current  The location being evaluated
 * @param history  Recent location points, ordered newest-first
 * @returns        Trust score result with breakdown
 */
export function computeTrustScore(current, history) {
    const movementPlausibility = scoreMovement(current, history);
    const accuracyAnomaly = scoreAccuracy(current);
    const temporalConsistency = scoreTemporalConsistency(current, history);
    const raw = WEIGHT_MOVEMENT * movementPlausibility +
        WEIGHT_ACCURACY * accuracyAnomaly +
        WEIGHT_TEMPORAL * temporalConsistency;
    const trustScore = Math.round(Math.max(0, Math.min(1, raw)) * 100) / 100;
    return {
        trustScore,
        spoofingSuspected: trustScore < 0.3,
        signals: { movementPlausibility, accuracyAnomaly, temporalConsistency },
    };
}
/**
 * Gate an action based on a trust score.
 *
 * - 'proceed': trustScore >= proceed threshold (default 0.7)
 * - 'step-up': trustScore >= stepUp threshold (default 0.3)
 * - 'deny':    trustScore < stepUp threshold
 */
/**
 * Compute a V2 trust score with optional RAIM fix consistency and network cross-check.
 *
 * When no context signals are provided, delegates to V1 (identical result).
 * Dynamic weight allocation based on available signals:
 * - Both fixes + network: movement 0.30, accuracy 0.10, temporal 0.15, fix 0.25, network 0.20
 * - Fixes only:           movement 0.35, accuracy 0.15, temporal 0.20, fix 0.30
 * - Network only:         movement 0.40, accuracy 0.15, temporal 0.20, network 0.25
 */
export function computeTrustScoreV2(current, history, context) {
    const hasFixes = context?.recentFixes && context.recentFixes.length > 0;
    const hasNetwork = context?.networkHint != null;
    // No extra signals → delegate to V1 for exact backward compatibility
    if (!hasFixes && !hasNetwork) {
        return computeTrustScore(current, history);
    }
    const movementPlausibility = scoreMovement(current, history);
    const accuracyAnomaly = scoreAccuracy(current);
    const temporalConsistency = scoreTemporalConsistency(current, history);
    let fixConsistency;
    let networkConsistency;
    let wM, wA, wT, wF, wN;
    if (hasFixes && hasNetwork) {
        wM = 0.30;
        wA = 0.10;
        wT = 0.15;
        wF = 0.25;
        wN = 0.20;
        fixConsistency = scoreFixConsistency(context.recentFixes);
        networkConsistency = scoreNetworkConsistency(current, context.networkHint);
    }
    else if (hasFixes) {
        wM = 0.35;
        wA = 0.15;
        wT = 0.20;
        wF = 0.30;
        wN = 0;
        fixConsistency = scoreFixConsistency(context.recentFixes);
    }
    else {
        // hasNetwork only
        wM = 0.40;
        wA = 0.15;
        wT = 0.20;
        wF = 0;
        wN = 0.25;
        networkConsistency = scoreNetworkConsistency(current, context.networkHint);
    }
    const raw = wM * movementPlausibility +
        wA * accuracyAnomaly +
        wT * temporalConsistency +
        wF * (fixConsistency ?? 0) +
        wN * (networkConsistency ?? 0);
    const trustScore = Math.round(Math.max(0, Math.min(1, raw)) * 100) / 100;
    return {
        trustScore,
        spoofingSuspected: trustScore < 0.3,
        signals: {
            movementPlausibility,
            accuracyAnomaly,
            temporalConsistency,
            ...(fixConsistency !== undefined && { fixConsistency }),
            ...(networkConsistency !== undefined && { networkConsistency }),
        },
    };
}
export function gateTrustScore(result, thresholds) {
    const t = { proceed: 0.7, stepUp: 0.3, ...thresholds };
    if (result.trustScore >= t.proceed)
        return 'proceed';
    if (result.trustScore >= t.stepUp)
        return 'step-up';
    return 'deny';
}
/**
 * Create a session-aware trust gate with latch semantics.
 */
export function createTrustSession() {
    let _latched = null;
    let _fixCount = 0;
    return {
        gate(result, thresholds) {
            _fixCount++;
            if (_latched !== null)
                return _latched;
            const decision = gateTrustScore(result, thresholds);
            if (decision !== 'proceed') {
                _latched = decision;
            }
            return decision;
        },
        get latched() { return _latched !== null; },
        get latchedState() { return _latched; },
        get fixCount() { return _fixCount; },
        reset() { _latched = null; _fixCount = 0; },
    };
}
