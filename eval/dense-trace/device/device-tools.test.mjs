import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));

function runNode(script, args) {
  const result = spawnSync(process.execPath, [join(HERE, script), ...args], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'zairn-device-tools-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('parse-run reads the session app artifact and derives acquisition rate', () => {
  withTempDir((dir) => {
    const base = 'gated.test-session';
    writeFileSync(join(dir, base + '.begin.json'), JSON.stringify({
      arm: 'gated',
      t0_ms: 0,
      level0: 90,
      capacity_mAh: 6000,
      screen_policy: 'screen-on-foreground',
    }));
    writeFileSync(join(dir, base + '.end.json'), JSON.stringify({
      t1_ms: 3_600_000,
      level1: 80,
    }));
    copyFileSync(
      join(HERE, 'adb', 'fixtures', 'gated.batterystats.txt'),
      join(dir, base + '.batterystats.txt'),
    );
    writeFileSync(join(dir, base + '.app.json'), JSON.stringify({
      arm: 'gated',
      wallSeconds: 3600,
      gnssAcquisitions: 2,
      gatePolls: 120,
      gateSkips: 118,
      gateReasons: { 'cold-start': 1, 'due-stationary': 1 },
      gateDecisionReasons: { 'cold-start': 1, 'cadence-wait': 118, 'due-stationary': 1 },
    }));

    runNode('parse-run.mjs', ['--session', base, '--results', dir]);

    const summary = JSON.parse(readFileSync(join(dir, base + '.run.json'), 'utf8'));
    assert.equal(summary._raw.app, base + '.app.json');
    assert.equal(summary.app_side.source, base + '.app.json');
    assert.equal(summary.app_side.acqPerHour, 2);
    assert.equal(summary.app_side.gateSkips, 118);
    assert.equal(summary.app_side.gateDecisionReasons['cadence-wait'], 118);
  });
});

test('merge-results retains repeated runs and reports median with IQR', () => {
  withTempDir((dir) => {
    const writeRun = (file, arm, drain, gnss, duty, acquisitions) => {
      writeFileSync(join(dir, file), JSON.stringify({
        arm,
        measurement: {
          run_hours: 2,
          screen_policy: 'screen-on-foreground',
          drain_rate_mAh_per_h: drain,
        },
        gnss: {
          mAh_per_h: gnss,
          duty_pct: duty,
          pct_of_drain: 20,
        },
        app_side: { acqPerHour: acquisitions },
      }));
    };

    writeRun('continuous.a.run.json', 'continuous', 100, 50, 80, 10);
    writeRun('continuous.b.run.json', 'continuous', 200, 70, 100, 20);
    writeRun('naive.a.run.json', 'naive', 180, 65, 95, 18);
    writeRun('gated.a.run.json', 'gated', 50, 1, 1, 1);
    writeRun('gated.b.run.json', 'gated', 70, 3, 3, 3);

    runNode('merge-results.mjs', ['--results', dir]);

    const summary = JSON.parse(readFileSync(join(dir, 'device-summary.json'), 'utf8'));
    const continuous = summary.results.find((row) => row.arm === 'continuous');
    const gated = summary.results.find((row) => row.arm === 'gated');

    assert.equal(summary._schema, 'sensing-gate-arm/device-summary/v2');
    assert.equal(continuous.n_runs, 2);
    assert.equal(continuous.total_run_hours, 4);
    assert.equal(continuous.drain_mAh_per_h, 150);
    assert.deepEqual(continuous.drain_mAh_per_h_iqr, { p25: 125, p75: 175 });
    assert.equal(gated.n_runs, 2);
    assert.equal(gated.drain_mAh_per_h, 60);
    assert.equal(gated.acq_per_h_app, 2);
    assert.equal(gated.total_energy_reduction_vs_continuous_pct, 60);
    assert.equal(gated.gnss_energy_reduction_vs_continuous_pct, 96.7);
    assert.equal(gated.source_files.length, 2);
  });
});

test('device harness parses and uses the stateful sensing gate controller', () => {
  const html = readFileSync(join(HERE, 'harness', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .filter((source) => source.trim());

  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Script(scripts[0]));
  assert.match(scripts[0], /Z\.createSensingGateController\(/);
  assert.doesNotMatch(scripts[0], /Z\.createSensingGate\(/);
});
