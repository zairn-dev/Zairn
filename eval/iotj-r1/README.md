# IoT-J revision evaluation (IoT-63543-2026.R1)

Evaluation code for the revised "Graduated Trust Gating for IoT Location
Verification" manuscript.

- `paper-scorer.mjs` — frozen weighted-sum V1/V2 scorer of the submitted
  manuscript (commit `663860f`). The live SDK scorer now fuses signals in
  log-odds space and is evaluated only as a comparison.
- `data.mjs` — synthetic splits. `dev` is the manuscript's 10,000 traces;
  `val` and `test` use disjoint generator seeds and were not used to choose
  weights or thresholds.
- `revised-scorer.mjs` — candidate fix for S4: fixes from the last 15 s only,
  scatter measured after removing a constant-velocity trend. Otherwise the
  submitted V2.
- `fusion.mjs` — per-trace signal matrices (submitted S1..S5 and revised
  S2'/S4'), weighted-mean scoring of any weight vector or signal subset as
  in the submitted ablation (Table I reproduces V2 exactly), histogram
  metrics, Dirichlet draws and a non-negative logistic regression.
- `metrics.mjs` — tie-aware AUC-ROC, average precision, EER, threshold
  metrics, the three-action gate under an imperfect step-up verifier
  (alpha = legitimate failure, beta = spoofer success), and stratified
  bootstrap CIs. Positive class = spoofed throughout.

## Scripts

```sh
node eval/iotj-r1/run-baseline.mjs           # Tables II, III, V with 95% CIs
node eval/iotj-r1/run-stepup.mjs             # imperfect step-up: break-even alpha/beta, FAR at matched FDR
node eval/iotj-r1/run-dense-trace.mjs [trace] # legitimate-side tail on a 22-day 60 s Android trace
node eval/iotj-r1/run-s4.mjs [trace]         # submitted S4 vs time-windowed, detrended S4'
node eval/iotj-r1/run-shl.mjs [root]         # false alarms by transport mode on SHL Preview (1 Hz)
node eval/iotj-r1/run-weights.mjs            # Table I vs random (Dirichlet) and learned weights; leave-one-attack-out
node eval/iotj-r1/run-shapley.mjs            # exact Shapley values, S3+S5 vs all-five dilution, attack x signal AUC, SDK log-odds
node eval/iotj-r1/run-field.mjs [root]       # field recordings: honest tails by environment, session windows, mock stages, Chrome check
node eval/iotj-r1/run-stepup-trials.mjs [dir] # step-up trials on four phones: alpha with exact CIs, rejected forged/expired tokens, timings
node eval/iotj-r1/run-proof-size.mjs         # proof size and Node-side proving/verification cost
node eval/iotj-r1/run-tradeoff.mjs [shl] [trace] # binary vs graduated gate per honest source (needs results/field.json, stepup-trials.json)
node eval/iotj-r1/run-latch.mjs [shl] [trace] # latch policies on 10-minute SHL / long-term sessions and spliced mock sessions
node eval/iotj-r1/make-numbers.mjs [outDir]  # writes numbers.tex: every number the manuscript quotes, with its JSON source
```

`make-numbers.mjs` reads only `results/` and `../iotj-r1-equal/results/`, so the
manuscript's numbers can be regenerated from the committed aggregates without
the raw data.

`run-shapley.mjs` imports the SDK scorer from `packages/sdk/dist`; run
`pnpm build` first.

Equal-weight check (the Table I weights were set by hand):

```sh
node eval/iotj-r1/make-equal-weights.mjs     # copy to eval/iotj-r1-equal with equal weights in every profile
cd eval/iotj-r1-equal && for s in baseline stepup s4 dense-trace shl field tradeoff latch; do node run-$s.mjs; done
node eval/iotj-r1/make-numbers.mjs           # adds the \nEq* macros from iotj-r1-equal/results
```

The dense trace contains private coordinates and is not in the repository;
`run-dense-trace.mjs` writes aggregates only. The field recordings (GnssLogger
logs, browser traces and step-up trial exports) are not in the repository for
the same reason; `run-field.mjs` and `run-stepup-trials.mjs` write aggregates
only. The SHL dataset (non-profit research licence) is likewise kept outside
the repository; download it from http://www.shl-dataset.org/download/ and pass
the extracted folder. The synthetic traces are generated deterministically by
`packages/geo-drop/test/generate-synthetic-traces.mjs`, so every synthetic
result can be rerun from the repository alone.

Results are written to `eval/iotj-r1/results/`.

## Corrections relative to the submitted manuscript

- AUC-PR and EER (Table II) were computed on a threshold grid that never
  classified scores of exactly 1.0, truncating the curves. Tie-aware values:
  V1 AP 0.883 / EER 0.244, V2 AP 0.972 / EER 0.080 (dev split).
- Table III's minimum scores were taken from the real-device traces instead
  of the synthetic set.
- `packages/geo-drop/test/evaluate-missing-signal.mjs` prints F1 with the
  legitimate class as positive; the manuscript's Table VI uses the spoofed
  class, as here.

## Step-up prototype (`stepup-proto/`)

On-site presence token bound into a Zairn-ZKP proof, for measuring the
step-up failure rate (alpha) and bypass rate (beta) on real phones.

```sh
eval/iotj-r1/stepup-proto/build-artifacts.sh path/to/pot10_final.ptau   # once
node eval/iotj-r1/stepup-proto/smoke-test.mjs                            # accept/reject paths
node eval/iotj-r1/stepup-proto/server.mjs --lifetime 30 --radius 50
cloudflared tunnel --url http://localhost:8787                           # HTTPS for phones
```

- `/venue` (open on the server machine): rotating QR, `ZT1.<venue>.<slot>.<HMAC>`.
- `/` (phone): session nonce, QR scan, one GPS fix, Groth16 proof with the
  challenge digest bound to (nonce, token), server verification.
- `/collect` (phone): the 1 Hz trace collector from `packages/geo-drop/test/`.
- Trial logs (`stepup-proto/logs/`) hold outcomes and timings only; the venue
  centre is set at run time and never written to disk.

## C port of the scorer (`c-scorer/`)

C99 port of V1, V2 and V2' (no heap, fixed-capacity inputs) for the scoring
overhead outside JavaScript (R1-9, scorer side of R3-5): bit comparison with
the JS trust scores on dev/val/test, latency on x86-64 (and on an attached
Android phone), footprint, stack and operation counts for ESP32, ESP32-C3 and
Cortex-M4F, and an MCU cycle estimate.

```sh
bash eval/iotj-r1/c-scorer/build.sh    # writes results/c-scorer.json
```

Details and result tables: `c-scorer/README.md`. The same port also runs on an
ESP32-S3 board (`c-scorer/esp32s3/`: firmware, input packer, serial collector),
which writes `results/c-scorer-esp32s3.json`.
