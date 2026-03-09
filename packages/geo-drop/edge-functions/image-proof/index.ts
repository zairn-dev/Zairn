/**
 * Supabase Edge Function: image-proof
 * Server-side verification endpoint for image feature vector extraction and comparison using DINOv2
 *
 * Deploy:
 *   supabase functions deploy image-proof
 *
 * Environment variables (auto-configured):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Environment variables (optional):
 *   IMAGE_PROOF_MODEL     — ONNX model name (default: onnx-community/dinov2-small-imagenet1k-1-layer)
 *   IMAGE_PROOF_THRESHOLD — Similarity threshold (default: 0.70)
 */

// @ts-nocheck — Deno + Transformers.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { pipeline, env } from 'https://esm.sh/@huggingface/transformers@3';

env.cacheDir = '/tmp/transformers-cache';
env.allowLocalModels = false;

const MODEL_ID = Deno.env.get('IMAGE_PROOF_MODEL') || 'onnx-community/dinov2-small-imagenet1k-1-layer';
const DEFAULT_THRESHOLD = parseFloat(Deno.env.get('IMAGE_PROOF_THRESHOLD') || '0.70');

// Model singleton (reduces cold start overhead)
let extractor: any = null;

async function getExtractor() {
  if (!extractor) {
    extractor = await pipeline('image-feature-extraction', MODEL_ID, { device: 'cpu' });
  }
  return extractor;
}

/** Extract a normalized feature vector from an image (base64) */
async function extractEmbedding(imageBase64: string): Promise<number[]> {
  const ext = await getExtractor();
  const dataUrl = imageBase64.startsWith('data:')
    ? imageBase64
    : `data:image/jpeg;base64,${imageBase64}`;

  const output = await ext(dataUrl, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
}

/** Cosine similarity of normalized vectors (= dot product) */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** CORS-enabled response */
function jsonResponse(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Access-Control-Allow-Origin': '*' },
  });
}

// =====================
// Main handler
// =====================
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
      },
    });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const { action, ...payload } = await req.json();

    // action: 'extract' — Extract feature vector from a reference image
    if (action === 'extract') {
      if (!payload.image) return jsonResponse({ error: 'image (base64) is required' }, 400);

      const embedding = await extractEmbedding(payload.image);
      return jsonResponse({ embedding, dimensions: embedding.length, model: MODEL_ID });
    }

    // action: 'verify' — Compare a captured image against a drop's reference
    if (action === 'verify') {
      if (!payload.image) return jsonResponse({ error: 'image (base64) is required' }, 400);

      const threshold = payload.threshold ?? DEFAULT_THRESHOLD;
      let refEmbedding: number[];

      if (payload.reference_embedding?.length) {
        refEmbedding = payload.reference_embedding;
      } else if (payload.drop_id) {
        // Retrieve reference vector from DB
        const supabase = createClient(
          Deno.env.get('SUPABASE_URL')!,
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        );
        const { data: drop, error } = await supabase
          .from('geo_drops')
          .select('proof_config')
          .eq('id', payload.drop_id)
          .single();

        if (error || !drop) return jsonResponse({ error: 'Drop not found' }, 404);

        const arReq = drop.proof_config?.requirements?.find((r: any) => r.method === 'ar');
        if (!arReq?.params?.reference_embedding) {
          return jsonResponse({ error: 'Drop has no AR proof with reference_embedding' }, 400);
        }
        refEmbedding = arReq.params.reference_embedding;
      } else {
        return jsonResponse({ error: 'Either drop_id or reference_embedding is required' }, 400);
      }

      const capturedEmbedding = await extractEmbedding(payload.image);
      const similarity = Math.round(cosineSimilarity(refEmbedding, capturedEmbedding) * 10000) / 10000;

      return jsonResponse({
        verified: similarity >= threshold,
        similarity,
        threshold,
        model: MODEL_ID,
      });
    }

    return jsonResponse({ error: `Unknown action: ${action}` }, 400);
  } catch (err: any) {
    console.error('image-proof error:', err);
    return jsonResponse({ error: err.message || 'Internal server error' }, 500);
  }
});
