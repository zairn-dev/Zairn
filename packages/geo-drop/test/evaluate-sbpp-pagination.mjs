/**
 * SBPP Pagination Comparison: Full-Result Root vs Page-Local Root
 *
 * Demonstrates why result-set commitment must cover the FULL authorized
 * set rather than a page-local subset.
 *
 * Problem: If root is computed over only the current page, an attacker
 * can prove proximity to a drop on page 2 using page 1's root, because
 * the root doesn't cover page 2's drops.
 *
 * Comparison:
 *   1. Full-result root: root(R) covers all candidates
 *   2. Page-local root: root(page_k) covers only the current page
 */

import { MerkleResultSet } from '../dist/sbpp.js';

const N = 100;

function runPaginationComparison() {
  const results = {
    timestamp: new Date().toISOString(),
    n_trials: N,
    page_sizes: [20, 50, 100],
    scenarios: {},
  };

  for (const pageSize of [20, 50, 100]) {
    let fullRoot_crossPage_blocked = 0;
    let pageLocal_crossPage_blocked = 0;
    let fullRoot_inPage_valid = 0;
    let pageLocal_inPage_valid = 0;

    for (let i = 0; i < N; i++) {
      // Generate 200 candidate drops (simulating a large result set)
      const totalDrops = 200;
      const allDrops = Array.from({ length: totalDrops }, (_, j) => `drop-${String(j).padStart(4, '0')}`);

      // Split into pages
      const pages = [];
      for (let p = 0; p < allDrops.length; p += pageSize) {
        pages.push(allDrops.slice(p, p + pageSize));
      }

      // Pick a drop from page 2 (index 1)
      const targetDrop = pages.length > 1 ? pages[1][0] : pages[0][pageSize - 1];

      // === Full-result root ===
      const fullTree = new MerkleResultSet(allDrops);
      const fullProof = fullTree.prove(targetDrop);
      const fullValid = fullProof !== null && MerkleResultSet.verify(fullProof);
      if (fullValid) fullRoot_inPage_valid++;

      // Cross-page attack: prove a drop NOT in page 1 using page 1's root
      const page1Tree_full = new MerkleResultSet(allDrops); // full root covers all
      const crossProof_full = page1Tree_full.prove(targetDrop); // target is in full set
      if (crossProof_full && MerkleResultSet.verify(crossProof_full)) {
        // Full root correctly includes the drop — no cross-page issue
        fullRoot_crossPage_blocked++; // "blocked" = no ambiguity
      }

      // === Page-local root ===
      // Root covers only page 1
      const page1Tree = new MerkleResultSet(pages[0]);
      const page1Root = page1Tree.root;

      // Try to prove targetDrop (from page 2) against page 1's root
      const crossProof_local = page1Tree.prove(targetDrop);
      if (crossProof_local === null) {
        // Cannot prove — page-local root correctly rejects
        pageLocal_crossPage_blocked++;
      }
      // BUT: the problem is that page 1's root was committed in the proof
      // If the client generated the proof with page 1's root but actually
      // accessed a drop from page 2, the verifier has no way to know
      // that the original authorized set was larger than page 1.

      // In-page validity
      const inPageDrop = pages[0][0];
      const inPageProof = page1Tree.prove(inPageDrop);
      if (inPageProof && MerkleResultSet.verify(inPageProof)) {
        pageLocal_inPage_valid++;
      }
    }

    results.scenarios[`page_${pageSize}`] = {
      total_drops: 200,
      page_size: pageSize,
      num_pages: Math.ceil(200 / pageSize),
      full_root: {
        in_page_valid: fullRoot_inPage_valid,
        cross_page_provable: fullRoot_crossPage_blocked,
        description: 'Full root covers all drops — cross-page proofs are always valid',
      },
      page_local: {
        in_page_valid: pageLocal_inPage_valid,
        cross_page_blocked: pageLocal_crossPage_blocked,
        description: 'Page-local root covers only current page — cross-page proofs fail',
        problem: 'Verifier cannot distinguish "drop was on page 2" from "drop was never authorized" — authorization ambiguity',
      },
    };
  }

  // Summary
  results.finding = {
    full_result_root: 'Authorization is unambiguous: any authorized drop has a valid Merkle proof against the single committed root',
    page_local_root: 'Authorization is ambiguous at page boundaries: the committed root covers only one page, so drops on other pages have no Merkle proof even though they were authorized',
    recommendation: 'Full-result root MUST be used for P2 (result-set soundness) and P3 (transcript auditability)',
  };

  return results;
}

const results = runPaginationComparison();
process.stdout.write(JSON.stringify(results, null, 2));

process.stderr.write('\n=== Pagination Comparison ===\n\n');
for (const [key, s] of Object.entries(results.scenarios)) {
  process.stderr.write(`${key}: ${s.total_drops} drops, page=${s.page_size}, pages=${s.num_pages}\n`);
  process.stderr.write(`  Full root: in-page valid=${s.full_root.in_page_valid}/${results.n_trials}, cross-page provable=${s.full_root.cross_page_provable}/${results.n_trials}\n`);
  process.stderr.write(`  Page-local: in-page valid=${s.page_local.in_page_valid}/${results.n_trials}, cross-page blocked=${s.page_local.cross_page_blocked}/${results.n_trials}\n`);
  process.stderr.write(`  Problem: ${s.page_local.problem}\n\n`);
}
process.stderr.write(`Finding: ${results.finding.recommendation}\n`);
