/**
 * Merge per-arm run summaries into a repeated-measures device summary.
 *
 * Every *.run.json is retained. Per-arm headline values are medians, with IQR
 * fields alongside them, so repeated runs are not silently discarded.
 *
 * Usage: node merge-results.mjs [--results <dir>]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARM_ORDER = ['continuous', 'naive', 'gated'];

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function round(value, digits = 2) {
  return value == null ? null : +value.toFixed(digits);
}

function quantile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function metric(entries, select, digits = 2) {
  const values = entries
    .map(({ run }) => select(run))
    .filter((value) => Number.isFinite(value));
  return {
    median: round(quantile(values, 0.5), digits),
    p25: round(quantile(values, 0.25), digits),
    p75: round(quantile(values, 0.75), digits),
  };
}

function percentReduction(value, baseline) {
  return value != null && baseline != null && baseline !== 0
    ? round(100 * (1 - value / baseline), 1)
    : null;
}

function summarizeArm(arm, entries) {
  const runHours = metric(entries, (run) => run.measurement?.run_hours, 3);
  const drain = metric(entries, (run) => run.measurement?.drain_rate_mAh_per_h);
  const gnssRate = metric(entries, (run) => run.gnss?.mAh_per_h);
  const gnssDuty = metric(entries, (run) => run.gnss?.duty_pct);
  const gnssPctDrain = metric(entries, (run) => run.gnss?.pct_of_drain, 1);
  const appAcq = metric(entries, (run) => run.app_side?.acqPerHour, 3);
  const policies = [...new Set(entries
    .map(({ run }) => run.measurement?.screen_policy)
    .filter(Boolean))];

  return {
    arm,
    n_runs: entries.length,
    run_hours: runHours.median,
    total_run_hours: round(entries.reduce(
      (sum, { run }) => sum + (run.measurement?.run_hours ?? 0),
      0,
    ), 3),
    screen_policy: policies.length === 1 ? policies[0] : 'mixed',
    drain_mAh_per_h: drain.median,
    drain_mAh_per_h_iqr: { p25: drain.p25, p75: drain.p75 },
    gnss_mAh_per_h: gnssRate.median,
    gnss_mAh_per_h_iqr: { p25: gnssRate.p25, p75: gnssRate.p75 },
    gnss_duty_pct: gnssDuty.median,
    gnss_duty_pct_iqr: { p25: gnssDuty.p25, p75: gnssDuty.p75 },
    gnss_pct_of_drain: gnssPctDrain.median,
    acq_per_h_app: appAcq.median,
    acq_per_h_app_iqr: { p25: appAcq.p25, p75: appAcq.p75 },
    source_files: entries.map(({ file }) => file).sort(),
  };
}

function main() {
  const dir = resolve(arg('results', join(HERE, 'results')));
  if (!existsSync(dir)) {
    console.error(`[merge] results dir not found: ${dir}`);
    process.exit(1);
  }

  const files = readdirSync(dir).filter((file) => file.endsWith('.run.json'));
  if (files.length === 0) {
    console.error(`[merge] no *.run.json in ${dir}. Run parse-run.mjs first.`);
    process.exit(1);
  }

  const byArm = new Map();
  for (const file of files) {
    const run = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const entries = byArm.get(run.arm) ?? [];
    entries.push({ file, run });
    byArm.set(run.arm, entries);
  }

  const arms = [...byArm.keys()].sort((a, b) => {
    const ia = ARM_ORDER.indexOf(a);
    const ib = ARM_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const baseRows = arms.map((arm) => summarizeArm(arm, byArm.get(arm)));
  const continuous = baseRows.find((row) => row.arm === 'continuous');
  const rows = baseRows.map((row) => ({
    ...row,
    total_energy_reduction_vs_continuous_pct: percentReduction(
      row.drain_mAh_per_h,
      continuous?.drain_mAh_per_h,
    ),
    gnss_energy_reduction_vs_continuous_pct: percentReduction(
      row.gnss_mAh_per_h,
      continuous?.gnss_mAh_per_h,
    ),
    gnss_duty_pct_of_continuous:
      row.gnss_duty_pct != null && continuous?.gnss_duty_pct
        ? round(100 * row.gnss_duty_pct / continuous.gnss_duty_pct, 1)
        : null,
  }));

  const out = {
    _description: 'Repeated-run on-device comparison of continuous, naive, and gated GNSS acquisition.',
    _schema: 'sensing-gate-arm/device-summary/v2',
    _generated: new Date().toISOString(),
    _method: 'adb dumpsys batterystats --charged, reset per arm; all run summaries retained; ' +
      'headline values are per-arm medians with IQR; GNSS attribution uses Estimated power use Global.',
    arms_measured: arms,
    results: rows,
  };
  writeFileSync(join(dir, 'device-summary.json'), JSON.stringify(out, null, 2));

  const missing = ARM_ORDER.filter((arm) => !byArm.has(arm));
  console.log('\narm          n  run(h)  drain mAh/h   GNSS mAh/h   duty%   acq/h   tot%   gnss%');
  for (const row of rows) {
    console.log(
      row.arm.padEnd(11),
      String(row.n_runs).padStart(2),
      String(row.run_hours ?? '-').padStart(7),
      String(row.drain_mAh_per_h ?? '-').padStart(11),
      String(row.gnss_mAh_per_h ?? '-').padStart(12),
      String(row.gnss_duty_pct ?? '-').padStart(7),
      String(row.acq_per_h_app ?? '-').padStart(7),
      String(row.total_energy_reduction_vs_continuous_pct ?? '-').padStart(6),
      String(row.gnss_energy_reduction_vs_continuous_pct ?? '-').padStart(7),
    );
  }
  if (missing.length) {
    console.log(`\n[merge] NOTE: missing arms: ${missing.join(', ')} (run them for a complete comparison)`);
  }
  console.log(`\n[merge] wrote ${join(dir, 'device-summary.json')}`);
}

main();
