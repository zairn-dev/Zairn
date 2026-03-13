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
import {
  buildZkStatementBinding,
  verifyProximityProof,
  validatePublicSignals,
} from './zkp';
import type {
  Groth16Proof,
  VerificationKey,
  ZkContextBinding,
  ZkStatementBinding,
} from './zkp';

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
    // Constant-time comparison to prevent timing attacks
    const enc = new TextEncoder();
    const a = enc.encode(expected ?? '');
    const b = enc.encode(submitted ?? '');
    let matched = a.length === b.length;
    const len = Math.max(a.length, b.length);
    let xor = 0;
    for (let i = 0; i < len; i++) {
      xor |= (a[i] ?? 0) ^ (b[i] ?? 0);
    }
    matched = matched && xor === 0;
    return {
      method: 'secret',
      verified: matched,
      details: { matched, label: req.params.label ?? null },
    };
  };

  // =====================
  // AR helper: cosine similarity (client-side, no server call)
  // =====================
  function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
  }

  const verifyAr: ProofVerifier = async (req, sub, drop) => {
    const image = sub.data.image as string;
    if (!image) {
      return {
        method: 'ar',
        verified: false,
        details: { error: 'No image provided in AR proof submission' },
      };
    }

    // --- Client-side pre-checks (no server call) ---

    // 1. Freshness check: reject stale captures
    const maxAge = (req.params.max_age_seconds as number) ?? 300; // default 5 min
    const capturedAt = sub.data.captured_at as string | undefined;
    if (capturedAt) {
      const age = (Date.now() - new Date(capturedAt).getTime()) / 1000;
      if (age > maxAge || age < -30) { // allow 30s clock skew
        return {
          method: 'ar',
          verified: false,
          details: { error: 'Image too old or invalid timestamp', age_seconds: age, max_age_seconds: maxAge },
        };
      }
    }

    // 2. Screenshot detection: flag suspicious dimensions
    const imgW = sub.data.image_width as number | undefined;
    const imgH = sub.data.image_height as number | undefined;
    let screenshotWarning = false;
    if (imgW && imgH) {
      const ratio = imgW / imgH;
      // Phone cameras are typically 4:3 or 16:9. Exact 16:9/9:16 screen ratios with
      // very high resolution are suspicious. Exact square crops are also unusual for photos.
      if (Math.abs(ratio - 1.0) < 0.01) {
        screenshotWarning = true; // exact square crop
      }
    }

    // --- Collect reference embeddings ---
    const singleRef = req.params.reference_embedding as number[] | undefined;
    const multiRef = req.params.reference_embeddings as number[][] | undefined;
    const refEmbeddings: number[][] = multiRef
      ? multiRef
      : singleRef
        ? [singleRef]
        : [];

    const threshold = (req.params.similarity_threshold as number) ?? opts.similarityThreshold;

    try {
      // Single server call: extract embedding only
      const { embedding } = await callEdgeFunction<{ embedding: number[]; dimensions: number }>(
        'extract',
        { image }
      );

      if (refEmbeddings.length > 0) {
        // Client-side similarity comparison against all reference embeddings
        let maxSim = 0;
        for (const ref of refEmbeddings) {
          const sim = cosineSimilarity(embedding, ref);
          if (sim > maxSim) maxSim = sim;
        }

        return {
          method: 'ar',
          verified: maxSim >= threshold,
          details: {
            similarity: maxSim,
            threshold,
            reference_count: refEmbeddings.length,
            screenshot_warning: screenshotWarning,
          },
        };
      } else {
        // No local refs — fall back to server-side verify (legacy / drop_id lookup)
        const result = await callEdgeFunction<{ verified: boolean; similarity: number; threshold: number; model: string }>(
          'verify',
          { image, drop_id: drop.id, threshold }
        );

        return {
          method: 'ar',
          verified: result.verified,
          details: {
            similarity: result.similarity,
            threshold: result.threshold,
            model: result.model,
            screenshot_warning: screenshotWarning,
          },
        };
      }
    } catch (e) {
      return {
        method: 'ar',
        verified: false,
        details: { error: e instanceof Error ? e.message : 'Unknown error' },
      };
    }
  };

  // =====================
  // ZKP verifier: Zero-Knowledge Proof of Location
  // =====================

  const verifyZkp: ProofVerifier = async (req, sub, drop) => {
    const proof = sub.data.proof as Groth16Proof | undefined;
    const publicSignals = sub.data.publicSignals as string[] | undefined;
    const vkey = req.params.verification_key as VerificationKey | undefined;
    const statement = await resolveZkStatement(req.params, sub.data, drop);

    if (!proof || !publicSignals) {
      return {
        method: 'zkp',
        verified: false,
        details: { error: 'Missing proof or publicSignals in ZKP submission' },
      };
    }
    if (!vkey) {
      return {
        method: 'zkp',
        verified: false,
        details: { error: 'No verification_key configured in proof requirement' },
      };
    }

    // 1. Validate public signals match this drop's parameters (prevents proof reuse)
    if (!validatePublicSignals(
      publicSignals,
      drop.lat,
      drop.lon,
      drop.unlock_radius_meters,
      statement
    )) {
      return {
        method: 'zkp',
        verified: false,
        details: {
          error: statement
            ? 'Public signals do not match drop parameters or active statement context'
            : 'Public signals do not match drop parameters (possible proof reuse)',
        },
      };
    }

    // 2. Verify the Groth16 proof cryptographically
    try {
      const valid = await verifyProximityProof(proof, publicSignals, vkey);
      return {
        method: 'zkp',
        verified: valid,
        details: {
          proof_valid: valid,
          protocol: 'groth16',
          curve: 'bn128',
          context_bound: !!statement,
        },
      };
    } catch (e) {
      return {
        method: 'zkp',
        verified: false,
        details: { error: e instanceof Error ? e.message : 'ZKP verification failed' },
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

  async function resolveZkStatement(
    params: Record<string, unknown>,
    data: Record<string, unknown>,
    drop: GeoDrop
  ): Promise<ZkStatementBinding | undefined> {
    const explicit = data.statement as ZkStatementBinding | undefined;
    if (explicit) return explicit;

    const serverNonce = params.server_nonce as string | undefined;
    const epoch = params.epoch as string | number | undefined;
    if (!serverNonce || epoch == null) return undefined;

    const dropId = (params.drop_id as string | undefined) ?? drop.id;
    const policyVersion = params.policy_version as string | undefined;
    const context: ZkContextBinding = {
      dropId,
      policyVersion,
      epoch,
      serverNonce,
    };
    return buildZkStatementBinding(context);
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
      case 'zkp': return verifyZkp;
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
