/**
 * Parse ONE bounded per-arm measurement into a run summary that mirrors
 * eval/dense-trace/results/battery-37h-summary.json.
 *
 * Single source of truth for `dumpsys batterystats` parsing — the .ps1/.sh
 * adb helpers only CAPTURE raw dumps + before/after counters; all numeric
 * extraction happens here so it is testable PC-side with no device.
 *
 * Inputs (in eval/dense-trace/device/results/, by session base name):
 *   <base>.begin.json        {arm, t0_ms, level0, capacity_mAh, charge_counter0_uAh, current_now0_uA}
 *   <base>.end.json          {t1_ms, level1, charge_counter1_uAh, current_now1_uA}
 *   <base>.batterystats.txt  `adb shell dumpsys batterystats --charged`
 *   <base>.location.txt      `adb shell dumpsys location`   (optional, best-effort)
 *   <base>.app.json          browser harness export         (optional, GNSS acq count)
 *   <arm>.app.json           legacy browser export fallback
 *
 * Output:
 *   <base>.run.json          summary consumed by merge-results.mjs
 *
 * Usage:
 *   node parse-run.mjs --session continuous.2026-07-04T1200
 *   node parse-run.mjs --session <base> --results <dir>
 */
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// ---- duration parsing: "1d 13h 21m 4s 525ms" -> seconds ------------------
export function durationToSeconds(s) {
  if (!s) return 0;
  let sec = 0;
  const re = /(\d+(?:\.\d+)?)\s*(d|h|m|s|ms)\b/g;
  let m;
  const mult = { d: 86400, h: 3600, m: 60, s: 1, ms: 0.001 };
  while ((m = re.exec(s)) !== null) sec += parseFloat(m[1]) * mult[m[2]];
  return +sec.toFixed(3);
}

// ---- batterystats "Estimated power use" parser ---------------------------
// Returns { capacity_mAh, computed_drain_mAh, actual_drain_mAh, sections }
// sections = { global:{...}, 'on battery, screen on':{...}, 'on battery, screen off/doze':{...}, ... }
// each component = { mAh:Number, seconds:Number|null }
export function parseBatterystats(text) {
  const lines = text.split(/\r?\n/);
  const out = { capacity_mAh: null, computed_drain_mAh: null, actual_drain_mAh: null, sections: {} };

  const capM = text.match(/Estimated battery capacity:\s*([\d.]+)\s*mAh/);
  if (capM) out.capacity_mAh = parseFloat(capM[1]);

  const start = lines.findIndex((l) => /Estimated power use \(mAh\):/.test(l));
  if (start < 0) return out;

  let section = null;                 // null until we hit "Global"
  const COMP = /^\s*(screen|cpu|gnss|gps|wifi|wakelock|bluetooth|sensors|camera|audio|ambient_display):\s*([\d.eE+-]+)/;
  const DUR = /duration:\s*([0-9dhms .]+?)\s*$/;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    // block ends at the next top-level "UID" / blank-dedent region
    if (/^\s{0,2}UID\s/.test(line) || /^\s{0,2}[A-Z][\w ]+ since/.test(line)) break;

    const dm = line.match(/Capacity:\s*([\d.]+),\s*Computed drain:\s*([\d.]+),\s*actual drain:\s*([\d.]+)/);
    if (dm) {
      out.capacity_mAh = out.capacity_mAh ?? parseFloat(dm[1]);
      out.computed_drain_mAh = parseFloat(dm[2]);
      out.actual_drain_mAh = parseFloat(dm[3]);
      continue;
    }
    if (/^\s*Global\s*$/.test(line)) { section = 'global'; out.sections.global = {}; continue; }
    const marker = line.match(/^\s*\((on battery|not on battery)[^)]*\)\s*$/);
    if (marker) {
      section = line.trim().replace(/^\(|\)$/g, '');
      out.sections[section] = {};
      continue;
    }
    if (!section) continue;
    const cm = line.match(COMP);
    if (cm) {
      const comp = cm[1] === 'gps' ? 'gnss' : cm[1];
      const val = parseFloat(cm[2]);
      const durm = line.match(DUR);
      out.sections[section][comp] = {
        mAh: isFinite(val) ? val : 0,
        seconds: durm ? durationToSeconds(durm[1]) : null,
      };
    }
  }
  return out;
}

// ---- optional dumpsys location (best-effort provider snapshot) ------------
export function parseLocation(text) {
  if (!text) return null;
  const providers = [];
  for (const p of ['gps', 'network', 'fused']) {
    const re = new RegExp('^\\s*' + p + ' provider:', 'im');
    if (re.test(text)) providers.push(p);
  }
  const ttff = text.match(/Time to first fix:\s*([\d]+)\s*ms/i);
  return {
    providers_present: providers,
    last_ttff_ms: ttff ? parseInt(ttff[1], 10) : null,
  };
}

function readJSON(p) { return JSON.parse(readFileSync(p, 'utf8')); }

function pickSection(bs) {
  // Prefer whole-run Global attribution; fall back to on-battery screen-on
  // (our arms run screen-ON in the foreground) then screen-off/doze.
  const s = bs.sections;
  return {
    global: s.global || {},
    screen_on: s['on battery, screen on'] || {},
    screen_off: s['on battery, screen off/doze'] || {},
  };
}

function comp(section, name) {
  const c = section[name];
  return { mAh: c ? c.mAh : 0, seconds: c ? c.seconds : null };
}

function main() {
  const base = arg('session');
  const resultsDir = resolve(arg('results', join(HERE, 'results')));
  if (!base) { console.error('usage: node parse-run.mjs --session <base> [--results <dir>]'); process.exit(2); }

  const path = (suffix) => join(resultsDir, base + suffix);
  for (const req of ['.begin.json', '.end.json', '.batterystats.txt']) {
    if (!existsSync(path(req))) { console.error(`[parse-run] missing ${base + req} in ${resultsDir}`); process.exit(1); }
  }

  const begin = readJSON(path('.begin.json'));
  const end = readJSON(path('.end.json'));
  const bs = parseBatterystats(readFileSync(path('.batterystats.txt'), 'utf8'));
  const loc = existsSync(path('.location.txt')) ? parseLocation(readFileSync(path('.location.txt'), 'utf8')) : null;

  const arm = begin.arm || base.split('.')[0];
  const wallSeconds = Math.max(0, Math.round((end.t1_ms - begin.t0_ms) / 1000));
  const runHours = wallSeconds / 3600;

  const sec = pickSection(bs);
  const gnssG = comp(sec.global, 'gnss');
  const cpuG = comp(sec.global, 'cpu');
  const wlG = comp(sec.global, 'wakelock');
  const wifiG = comp(sec.global, 'wifi');

  const computedDrain = bs.computed_drain_mAh;
  const drainRate = computedDrain != null && runHours > 0 ? computedDrain / runHours : null;
  const gnssRate = runHours > 0 ? gnssG.mAh / runHours : null;
  const gnssDuty = gnssG.seconds != null && wallSeconds > 0 ? (100 * gnssG.seconds) / wallSeconds : null;
  const gnssPctDrain = computedDrain ? (100 * gnssG.mAh) / computedDrain : null;

  // level-based cross-check
  const capacity = begin.capacity_mAh ?? bs.capacity_mAh ?? null;
  const levelDrop = begin.level0 != null && end.level1 != null ? begin.level0 - end.level1 : null;
  const levelDrainMah = capacity != null && levelDrop != null ? (capacity * levelDrop) / 100 : null;

  // charge_counter cross-check (units vary by device: usually uAh; store raw + heuristic)
  let ccDeltaMah = null, ccUnitsGuess = null;
  if (begin.charge_counter0_uAh != null && end.charge_counter1_uAh != null) {
    const raw = begin.charge_counter0_uAh - end.charge_counter1_uAh; // positive on discharge
    // heuristic: if |raw| is implausibly small for a battery (< ~500), it is probably already mAh
    ccUnitsGuess = Math.abs(raw) > 5000 ? 'uAh' : 'mAh(likely)';
    ccDeltaMah = ccUnitsGuess === 'uAh' ? raw / 1000 : raw;
  }

  // optional app-side GNSS acquisition signal
  let appSide = null;
  const appPath = [path('.app.json'), join(resultsDir, arm + '.app.json')]
    .find((candidate) => existsSync(candidate));
  if (appPath) {
    const a = readJSON(appPath);
    const appHours = Number.isFinite(a.wallSeconds) && a.wallSeconds > 0
      ? a.wallSeconds / 3600
      : runHours;
    const acqPerHour = Number.isFinite(a.acqPerHour)
      ? a.acqPerHour
      : Number.isFinite(a.gnssAcquisitions) && appHours > 0
        ? a.gnssAcquisitions / appHours
        : null;
    appSide = {
      source: basename(appPath),
      gnssAcquisitions: a.gnssAcquisitions ?? null,
      acqPerHour: acqPerHour == null ? null : +acqPerHour.toFixed(3),
      watchFixes: a.watchFixes ?? null,
      gatePolls: a.gatePolls ?? null,
      gateSkips: a.gateSkips ?? null,
      processed: a.processed ?? null,
      gateReasons: a.gateReasons ?? undefined,
      gateDecisionReasons: a.gateDecisionReasons ?? undefined,
    };
  }

  const round = (x, n = 1) => (x == null ? null : +x.toFixed(n));
  const summary = {
    _description: `Bounded on-device energy arm "${arm}", parsed from adb dumpsys. Companion to the 37.6h always-on baseline (battery-37h-summary.json).`,
    _schema: 'sensing-gate-arm/device/v1',
    _raw: {
      batterystats: base + '.batterystats.txt',
      location: loc ? base + '.location.txt' : null,
      app: appSide?.source ?? null,
    },
    arm,
    measurement: {
      started_at: begin.started_at ?? null,
      stopped_at: end.stopped_at ?? null,
      wall_seconds: wallSeconds,
      run_hours: round(runHours, 3),
      screen_policy: begin.screen_policy ?? 'screen-on-foreground',
      battery_capacity_mAh: capacity,
      level_start_pct: begin.level0 ?? null,
      level_end_pct: end.level1 ?? null,
      level_drop_pct: levelDrop,
      computed_drain_mAh: computedDrain,
      actual_drain_mAh: bs.actual_drain_mAh,
      drain_rate_mAh_per_h: round(drainRate, 2),
      level_drain_mAh: round(levelDrainMah, 1),
      charge_counter_delta_mAh: round(ccDeltaMah, 2),
      charge_counter_units_guess: ccUnitsGuess,
    },
    gnss: {
      mAh: round(gnssG.mAh, 2),
      mAh_per_h: round(gnssRate, 2),
      pct_of_drain: round(gnssPctDrain, 1),
      on_seconds: gnssG.seconds,
      duty_pct: round(gnssDuty, 2),
    },
    components_mAh_global: {
      gnss: round(gnssG.mAh, 2),
      cpu: round(cpuG.mAh, 2),
      wakelock: round(wlG.mAh, 2),
      wifi: round(wifiG.mAh, 2),
    },
    app_side: appSide,
    location_providers: loc,
  };

  writeFileSync(path('.run.json'), JSON.stringify(summary, null, 2));
  console.log(`[parse-run] ${arm}: ${runHours.toFixed(2)}h  drain=${round(drainRate,1)} mAh/h  ` +
    `gnss=${round(gnssRate,1)} mAh/h (${round(gnssDuty,1)}% duty, ${round(gnssPctDrain,0)}% of drain)`);
  console.log(`[parse-run] wrote ${path('.run.json')}`);
}

// only run main when invoked directly (keeps functions importable for tests)
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
