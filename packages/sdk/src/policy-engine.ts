/**
 * SecureCheck-inspired Sharing Policy Engine
 *
 * Evaluates context-dependent sharing policies to determine effective
 * location visibility level per viewer. Policies are matched by priority
 * (highest wins). Fallback is the static share_rules.level.
 */

import { calculateDistance } from './core';
import type {
  PolicyCondition,
  SharingEffectLevel,
  SharingPolicy,
  LocationCurrentRow,
  FilteredLocation,
  ShareLevel,
} from './types';

/**
 * Context passed to the policy engine for evaluation
 */
export interface EvaluationContext {
  /** Owner's current location */
  ownerLat: number;
  ownerLon: number;
  /** Viewer's current location */
  viewerLat: number;
  viewerLon: number;
  /** Current time */
  now: Date;
  /** Owner's trust score (0.0–1.0), if available */
  trustScore?: number;
}

/**
 * Check if a single condition is satisfied
 */
function evaluateCondition(
  condition: PolicyCondition,
  ctx: EvaluationContext,
): boolean {
  switch (condition.type) {
    case 'time_range': {
      const tz = condition.timezone ?? 'UTC';
      // Format current time as HH:MM in the specified timezone
      const timeStr = ctx.now.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: tz,
      });
      const { start, end } = condition;
      // Handle overnight ranges (e.g., 22:00 – 06:00)
      if (start <= end) {
        return timeStr >= start && timeStr <= end;
      }
      return timeStr >= start || timeStr <= end;
    }

    case 'geofence': {
      const dist = calculateDistance(
        ctx.ownerLat,
        ctx.ownerLon,
        condition.lat,
        condition.lon,
      );
      return condition.inside ? dist <= condition.radius_m : dist > condition.radius_m;
    }

    case 'proximity': {
      const dist = calculateDistance(
        ctx.ownerLat,
        ctx.ownerLon,
        ctx.viewerLat,
        ctx.viewerLon,
      );
      return dist <= condition.max_distance_m;
    }

    case 'trust_score': {
      if (ctx.trustScore === undefined) return false;
      return ctx.trustScore >= condition.min;
    }

    default:
      return false;
  }
}

/**
 * Evaluate all policies for a specific viewer against the owner's location.
 * Returns the effective sharing level (highest-priority matching policy wins).
 * Falls back to the static share_rules level if no policy matches.
 */
export function evaluatePolicies(
  policies: SharingPolicy[],
  viewerId: string,
  ctx: EvaluationContext,
  fallbackLevel: ShareLevel,
): { level: SharingEffectLevel; coarseRadiusM?: number } {
  // Filter applicable policies: enabled, matching viewer (specific or null = all friends)
  const applicable = policies
    .filter(
      (p) =>
        p.enabled &&
        (p.viewer_id === null || p.viewer_id === viewerId),
    )
    .sort((a, b) => b.priority - a.priority); // highest priority first

  for (const policy of applicable) {
    // All conditions must match (AND logic)
    const allMatch = policy.conditions.every((c) =>
      evaluateCondition(c, ctx),
    );
    if (allMatch) {
      // Clamp: policy cannot escalate beyond the static share level.
      // Level hierarchy: none < coarse < current < history
      const hierarchy: Record<string, number> = { none: 0, coarse: 1, current: 2, history: 3 };
      const effectRank = hierarchy[policy.effect_level] ?? 0;
      const fallbackRank = hierarchy[fallbackLevel] ?? 0;
      const clampedLevel = effectRank > fallbackRank ? fallbackLevel : policy.effect_level;
      return {
        level: clampedLevel as SharingEffectLevel,
        coarseRadiusM: policy.coarse_radius_m ?? undefined,
      };
    }
  }

  // No policy matched — use static share_rules level
  return { level: fallbackLevel };
}

/**
 * Coarsen a location by snapping to a grid of the given radius
 */
export function coarsenLocation(
  lat: number,
  lon: number,
  radiusM: number,
): { lat: number; lon: number } {
  // Convert radius to approximate degrees
  const latDeg = radiusM / 111_320;
  const lonDeg = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));

  return {
    lat: Math.round(lat / latDeg) * latDeg,
    lon: Math.round(lon / lonDeg) * lonDeg,
  };
}

/**
 * Apply policy filtering to a list of friend locations.
 * Returns locations with effective levels applied and coordinates potentially coarsened.
 */
export function applyPolicies(
  friends: LocationCurrentRow[],
  policies: SharingPolicy[],
  shareLevels: Map<string, ShareLevel>,
  viewerId: string,
  ctx: Omit<EvaluationContext, 'ownerLat' | 'ownerLon'>,
): FilteredLocation[] {
  const results: FilteredLocation[] = [];

  for (const friend of friends) {
    const shareLevel = shareLevels.get(friend.user_id) ?? 'none';
    if (shareLevel === 'none') continue;

    const fullCtx: EvaluationContext = {
      ...ctx,
      ownerLat: friend.lat,
      ownerLon: friend.lon,
    };

    const { level, coarseRadiusM } = evaluatePolicies(
      policies,
      viewerId,
      fullCtx,
      shareLevel,
    );

    if (level === 'none') continue;

    let { lat, lon } = friend;
    let coarsened = false;

    if (level === 'coarse' && coarseRadiusM) {
      const snapped = coarsenLocation(lat, lon, coarseRadiusM);
      lat = snapped.lat;
      lon = snapped.lon;
      coarsened = true;
    }

    results.push({
      ...friend,
      lat,
      lon,
      share_level: shareLevel,
      effective_level: level,
      coarsened,
    });
  }

  return results;
}
