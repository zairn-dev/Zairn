# Dense-Trace Real-Device Pipeline

Scripts that drive the always-on Android trace evaluation reported in
the IMWUT paper (`§Real-Device`, `§Cadence Sweep`, `§Always-On
Vignette`).

## What is in this directory

| File | Role | Public? |
|---|---|---|
| `analyze-gaps.mjs` | Trace gap / coverage analyser | yes |
| `build-clean-segABC.mjs` | Concatenate gap-separated segments into `clean-segABC.json` | yes |
| `systems-eval.mjs` | Real-device systems metrics (cadence, accuracy, yield, staleness, per-fix cost) | yes |
| `coverage-sweep.mjs` | Resample to 1/5/15/30/60-min cadences and re-run task-answerability + centroid attack | yes |
| `analyze-deployment.mjs` | Vignette attack-side summary (home/work auto-detection, centroid) | yes |
| `work-attack.mjs` | Standalone work-cluster centroid attack on the trace | yes |
| `raw-*.json`, `clean-seg*.json`, `hybrid-trace.json` | Personal device GPS logs from the corresponding author. **Withheld**: contains private coordinates including the author's home and work locations. | no |
| `results/` | Generated outputs of the above scripts on the personal trace. **Withheld**: contains auto-detected home/work coordinates. | no |

## Reproducing the paper's real-device results

The pipeline scripts are released as is. To reproduce the table values
on a different device, supply your own dense GPS trace in the same
schema (`{meta: {...}, trace: [{ts, lat, lon, accuracy, ...}, ...]}`)
and run:

```sh
TRACE=clean-segABC.json node systems-eval.mjs
TRACE=clean-segABC.json node coverage-sweep.mjs
TRACE=segABC node analyze-deployment.mjs
```

Numerical outputs will differ; the paper reports figures from the
authors' single-device trace, which is itself a single-user case
study (n=1, see §Limitations).
