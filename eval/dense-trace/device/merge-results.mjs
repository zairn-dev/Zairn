/**
 * Merge per-arm run summaries (results/*.run.json) into one device summary
 * with the head-to-head comparison the paper needs:
 *   continuous  vs  naive (continuous + post-acquisition privacy compute)  vs  gated.
 *
 * Emits results/device-summary.json and prints a table. If more than one
 * run.json exists for the same arm, the LATEST by wall-clock start wins
 * (override by deleting stale files).
 *
 * Usage: node merge-results.mjs [--results <dir>]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ARM_ORDER = ['continuous', 'naive', 'gated'];

function main() {
  const dir = resolve(arg('results', join(HERE, 'results')));
  if (!existsSync(dir)) { console.error(`[merge] results dir not found: ${dir}`); process.exit(1); }
  const files = readdirSync(dir).filter((f) => f.endsWith('.run.json'));
  if (files.length === 0) { console.error(`[merge] no *.run.json in ${dir}. Run parse-run.mjs first.`); process.exit(1); }

  const byArm = new Map();
  for (const f of files) {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const key = r.arm;
    const prev = byArm.get(key);
    // keep the run with the most run_hours (longest / most trustworthy) if dup
    if (!prev || (r.measurement?.run_hours ?? 0) > (prev.measurement?.run_hours ?? 0)) byArm.set(key, r);
  }

  const arms = [...byArm.keys()].sort((a, b) => {
    const ia = ARM_ORDER.indexOf(a), ib = ARM_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const cont = byArm.get('continuous');
  const rows = arms.map((arm) => {
    const r = byArm.get(arm);
    const m = r.measurement, g = r.gnss;
    const drain = m.drain_rate_mAh_per_h;
    const gnssRate = g.mAh_per_h;
    const contDrain = cont?.measurement?.drain_rate_mAh_per_h;
    const contGnss = cont?.gnss?.mAh_per_h;
    return {
      arm,
      run_hours: m.run_hours,
      screen_policy: m.screen_policy,
      drain_mAh_per_h: drain,
      gnss_mAh_per_h: gnssRate,
      gnss_duty_pct: g.duty_pct,
      gnss_pct_of_drain: g.pct_of_drain,
      acq_per_h_app: r.app_side?.acqPerHour ?? null,
      total_energy_reduction_vs_continuous_pct:
        contDrain && drain != null ? +(100 * (1 - drain / contDrain)).toFixed(1) : null,
      gnss_energy_reduction_vs_continuous_pct:
        contGnss && gnssRate != null ? +(100 * (1 - gnssRate / contGnss)).toFixed(1) : null,
      gnss_duty_pct_of_continuous:
        cont?.gnss?.duty_pct && g.duty_pct != null ? +(100 * g.duty_pct / cont.gnss.duty_pct).toFixed(1) : null,
    };
  });

  const out = {
    _description: 'Bounded on-device energy comparison of continuous vs naive vs gated GNSS acquisition. ' +
      'Companion to the 37.6h always-on baseline (battery-37h-summary.json) and the PC replay (energy-ablation.json).',
    _schema: 'sensing-gate-arm/device-summary/v1',
    _generated: new Date().toISOString(),
    _method: 'adb dumpsys batterystats --charged, reset per arm; GNSS attribution from Estimated power use Global block; ' +
      'each arm a bounded 2-4h run, screen-ON foreground, same physical placement. ' +
      'Total drain includes screen (constant across arms); the GNSS-attributed rows isolate the acquisition lever.',
    arms_measured: arms,
    results: rows,
  };
  writeFileSync(join(dir, 'device-summary.json'), JSON.stringify(out, null, 2));

  const missing = ARM_ORDER.filter((a) => !byArm.has(a));
  console.log('\narm         run(h)  drain mAh/h   GNSS mAh/h   duty%   GNSS%drain   totΔ%   gnssΔ%');
  for (const r of rows) {
    console.log(
      r.arm.padEnd(11),
      String(r.run_hours ?? '-').padStart(6),
      String(r.drain_mAh_per_h ?? '-').padStart(11),
      String(r.gnss_mAh_per_h ?? '-').padStart(12),
      String(r.gnss_duty_pct ?? '-').padStart(7),
      String(r.gnss_pct_of_drain ?? '-').padStart(11),
      String(r.total_energy_reduction_vs_continuous_pct ?? '-').padStart(7),
      String(r.gnss_energy_reduction_vs_continuous_pct ?? '-').padStart(8),
    );
  }
  if (missing.length) console.log(`\n[merge] NOTE: missing arms: ${missing.join(', ')} (run them for a complete comparison)`);
  console.log(`\n[merge] wrote ${join(dir, 'device-summary.json')}`);
}

main();
