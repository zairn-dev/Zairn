/**
 * Pluggable location verification engine
 * Unified verification for GPS / secret / image (AR) / custom proofs
 */
import type {
  GeoDrop,
  ProofConfig,
  ProofMethodType,
  ProofRequirement,
  ProofSubmission,
  ProofResult,
  ProofVerifier,
  VerificationResult,
  LocationProof,
} from './types';
import { verifyProximity } from './geofence';

export interface VerificationEngineOptions {
  /** Edge Function URL for image-based AR verification */
  imageProofUrl: string;
  /** Default cosine similarity threshold for AR */
  similarityThreshold: number;
  /** Function to get auth headers for Edge Function calls */
  getAuthHeaders: () => Promise<Record<string, string>>;
}

export interface VerificationEngine {
  /** Run full verification against a drop's proof config */
  verify: (drop: GeoDrop, config: ProofConfig, submissions: ProofSubmission[]) => Promise<VerificationResult>;
  /** Register or override a verifier */
  register: (methodOrId: string, verifier: ProofVerifier) => void;
  /** Extract image embedding via Edge Function */
  extractEmbedding: (imageBase64: string) => Promise<{ embedding: number[]; dimensions: number }>;
  /** Verify image against a drop's reference via Edge Function */
  verifyImage: (imageBase64: string, dropId: string, threshold?: number) => Promise<{ verified: boolean; similarity: number }>;
}

/**
 * Create a verification engine
 */
export function createVerificationEngine(opts: VerificationEngineOptions): VerificationEngine {
  const customVerifiers = new Map<string, ProofVerifier>();

  // =====================
  // Built-in verifiers
  // =====================

  const verifyGps: ProofVerifier = (_req, sub, drop) => {
    const proof = verifyProximity({
      targetLat: drop.lat,
      targetLon: drop.lon,
      unlockRadius: drop.unlock_radius_meters,
      userLat: sub.data.lat as number,
      userLon: sub.data.lon as number,
      accuracy: (sub.data.accuracy as number) ?? 50,
      userId: (sub.data.user_id as string) ?? '',
    });

    return {
      method: 'gps',
      verified: proof.verified,
      details: {
        distance_meters: proof.distance_to_target,
        required_radius: drop.unlock_radius_meters,
        accuracy: proof.accuracy,
        location_proof: proof,
      },
    };
  };

  const verifySecret: ProofVerifier = (req, sub) => {
    const expected = req.params.secret as string;
    const submitted = sub.data.secret as string;
    const matched = expected === submitted;
    return {
      method: 'secret',
      verified: matched,
      details: { matched, label: req.params.label ?? null },
    };
  };

  const verifyAr: ProofVerifier = async (req, sub, drop) => {
    const image = sub.data.image as string;
    if (!image) {
      return {
        method: 'ar',
        verified: false,
        details: { error: 'No image provided in AR proof submission' },
      };
    }

    const refEmbedding = req.params.reference_embedding as number[] | undefined;
    const threshold = (req.params.similarity_threshold as number) ?? opts.similarityThreshold;

    try {
      const result = await callEdgeFunction<{ verified: boolean; similarity: number; threshold: number; model: string }>(
        'verify',
        {
          image,
          ...(refEmbedding
            ? { reference_embedding: refEmbedding, threshold }
            : { drop_id: drop.id, threshold }),
        }
      );

      return {
        method: 'ar',
        verified: result.verified,
        details: {
          similarity: result.similarity,
          threshold: result.threshold,
          model: result.model,
        },
      };
    } catch (e) {
      return {
        method: 'ar',
        verified: false,
        details: { error: e instanceof Error ? e.message : 'Unknown error' },
      };
    }
  };

  // =====================
  // Edge Function call
  // =====================

  async function callEdgeFunction<T>(action: string, payload: Record<string, unknown>): Promise<T> {
    const headers = await opts.getAuthHeaders();
    const res = await fetch(opts.imageProofUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action, ...payload }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error: string };
      throw new Error(err.error);
    }
    return res.json() as Promise<T>;
  }

  // =====================
  // Verifier resolution
  // =====================

  function resolveVerifier(method: ProofMethodType, verifierId?: string): ProofVerifier {
    // Registered with a custom ID
    if (method === 'custom' && verifierId && customVerifiers.has(verifierId)) {
      return customVerifiers.get(verifierId)!;
    }
    // Overridden by method name
    if (customVerifiers.has(method)) {
      return customVerifiers.get(method)!;
    }
    // Built-in
    switch (method) {
      case 'gps': return verifyGps;
      case 'secret': return verifySecret;
      case 'ar': return verifyAr;
      default:
        throw new Error(`No verifier registered for method: ${method}`);
    }
  }

  // =====================
  // Combined verification
  // =====================

  async function verify(
    drop: GeoDrop,
    config: ProofConfig,
    submissions: ProofSubmission[]
  ): Promise<VerificationResult> {
    const results: { result: ProofResult; required: boolean }[] = [];
    let locationProof: LocationProof | undefined;

    for (const req of config.requirements) {
      const sub = submissions.find(s => s.method === req.method);
      const isRequired = req.required !== false;

      if (!sub) {
        if (isRequired) {
          results.push({
            result: {
              method: req.method,
              verified: false,
              details: { error: 'No proof submitted for required method' },
            },
            required: true,
          });
        }
        continue;
      }

      const verifier = resolveVerifier(req.method, req.params.verifier_id as string | undefined);
      const result = await verifier(req, sub, drop);
      results.push({ result, required: isRequired });

      // Extract locationProof from GPS verification (already generated by verifyGps)
      if (req.method === 'gps' && result.verified && result.details.location_proof) {
        locationProof = result.details.location_proof as LocationProof;
      }
    }

    // Determine result based on mode
    const allProofs = results.map(r => r.result);
    const requiredResults = results.filter(r => r.required).map(r => r.result);

    let verified: boolean;
    if (config.mode === 'any') {
      verified = requiredResults.some(r => r.verified);
    } else {
      verified = requiredResults.length > 0 && requiredResults.every(r => r.verified);
    }

    return { verified, proofs: allProofs, location_proof: locationProof, timestamp: new Date().toISOString() };
  }

  // =====================
  // Public API
  // =====================

  return {
    verify,

    register(methodOrId: string, verifier: ProofVerifier) {
      customVerifiers.set(methodOrId, verifier);
    },

    async extractEmbedding(imageBase64: string) {
      return callEdgeFunction<{ embedding: number[]; dimensions: number }>('extract', { image: imageBase64 });
    },

    async verifyImage(imageBase64: string, dropId: string, threshold?: number) {
      return callEdgeFunction<{ verified: boolean; similarity: number }>('verify', {
        image: imageBase64,
        drop_id: dropId,
        threshold,
      });
    },
  };
}
