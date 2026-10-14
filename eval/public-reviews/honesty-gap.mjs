/**
 * Paper ① — RQ4: the HONESTY GAP. Overlay what users actually care about
 * (prevalence in 1,631 coded reviews of 5 location-sharing apps) onto what a
 * trace can VALIDLY deliver (measurability verdict from Pillars A/B).
 *
 * The mapping (code -> construct -> measurability tier) is the authors'
 * transparent analytical linkage; tiers are grounded in the empirical pillars:
 *   Pillar A: place labeling is non-monotone / flat (detection != understanding)
 *   Pillar B: social-presence proxies have WEAK convergent validity (r=0.10-0.34)
 *             vs the StudentLife EMA human criterion (clean discriminant ~0).
 */
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
const D = import.meta.dirname;

const MAP = {
  safety_need:         { constructs: ['K4 reachable', 'K1 place', 'K3 co-presence'], tier: 'WEAK',       bucket: 'gap',        why: '"is my loved one safe / where expected" needs reliable reachability/place/being-with-people — Pillar B r=0.10-0.34, Pillar A labeling flat/degrades' },
  battery_performance: { constructs: ['— (systems quality)'],                        tier: 'OUT',        bucket: 'orthogonal', why: 'battery/crash/perf = systems-quality concern, orthogonal to presence-construct validity' },
  control_visibility:  { constructs: ['K5 ghost / visibility control'],              tier: 'DESIGN',     bucket: 'design',     why: 'who-can-see / hide / per-contact = UX/policy controls, not a construct the trace must infer' },
  freshness_complaint: { constructs: ['K4 freshness'],                               tier: 'MEASURABLE', bucket: 'measurable', why: 'staleness = exact (last-fix timestamp); the system CAN honestly know and show it' },
  coordination_need:   { constructs: ['K2 nearby (geom)', 'K4 reachable'],           tier: 'MIXED',      bucket: 'gap',        why: 'geometric proximity/ETA is exact, but "arrived / en route / reachable" social inference is weak (K4)' },
  monitoring_coercion: { constructs: ['K5 ghost / surveillance'],                    tier: 'DESIGN',     bucket: 'design',     why: 'surveillance/coercion = policy/UX/ethics concern; no trace inference satisfies it' },
  accuracy_complaint:  { constructs: ['K1/K2 geometric accuracy'],                   tier: 'MEASURABLE', bucket: 'measurable', why: 'positional error is quantifiable; only the K1 role-labeling is weak' },
  precision_concern:   { constructs: ['K1/K2 precision (coarse<->exact)'],           tier: 'DESIGN',     bucket: 'design',     why: 'a privacy/utility design choice (how coarse to show), not an inference-validity question' },
  trust_integrity:     { constructs: ['integrity/provenance', 'K5'],                 tier: 'OUT',        bucket: 'companion',  why: 'spoof/pause/"is it real" = integrity/provenance — companion (ZKLS) territory, cited not claimed' },
};

async function main() {
  const d = JSON.parse(await readFile(join(D, 'coded-reviews.json'), 'utf-8'));
  const recs = d.records;
  const cnt = {}; for (const k in MAP) cnt[k] = 0;
  let nSub = 0;
  for (const r of recs) {
    const sub = (r.codes || []).filter(c => c !== 'other');
    if (sub.length) nSub++;
    for (const c of sub) if (c in cnt) cnt[c]++;
  }
  const totalCoded = Object.values(cnt).reduce((s, v) => s + v, 0);
  const bucketN = {};
  for (const k in MAP) bucketN[MAP[k].bucket] = (bucketN[MAP[k].bucket] || 0) + cnt[k];

  const rows = Object.entries(MAP).map(([code, m]) => ({
    code, n: cnt[code], pctOfSubstantive: +(100 * cnt[code] / nSub).toFixed(1),
    tier: m.tier, bucket: m.bucket, constructs: m.constructs, why: m.why,
  })).sort((a, b) => b.n - a.n);

  const out = {
    _note: 'RQ4 honesty gap: user-concern prevalence (coded reviews) x trace measurability (Pillar A/B). base = reviews with >=1 substantive (non-other) code.',
    nReviews: recs.length, nSubstantive: nSub,
    rows,
    bucketShareOfCodedInstances: Object.fromEntries(Object.entries(bucketN).map(([b, v]) => [b, +(100 * v / totalCoded).toFixed(1)])),
  };
  await writeFile(join(D, 'honesty-gap.json'), JSON.stringify(out, null, 2));

  console.log(`reviews ${recs.length}, with >=1 substantive code: ${nSub}`);
  console.log('\nconcern               n   %subst  measurability  bucket');
  for (const r of rows) console.log(r.code.padEnd(20), String(r.n).padStart(4), String(r.pctOfSubstantive + '%').padStart(7), r.tier.padStart(12), '  ' + r.bucket);
  console.log('\nbucket share of coded concern-instances (%):', out.bucketShareOfCodedInstances);
}
main().catch(e => { console.error(e); process.exit(1); });
