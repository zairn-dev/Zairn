/*
 * C99 port of the IoT-J trust scorers (eval/iotj-r1):
 *
 *   ts_score_v1   computeTrustScore    (paper-scorer.mjs, S1-S3)
 *   ts_score_v2   computeTrustScoreV2  (paper-scorer.mjs, Table I profiles)
 *   ts_score_v2r  computeTrustScoreRevised (revised-scorer.mjs, V2': S2', S4')
 *
 * Same piecewise maps, same operation order, same rounding
 * (Math.round(x * 100) / 100, ties toward +infinity) as the JS. No dynamic
 * allocation, no global state, fixed-capacity inputs, double precision.
 * Build with floating-point contraction disabled (-ffp-contract=off): fusing
 * a*b+c into an FMA changes the last bit and can move a score across a
 * rounding boundary.
 *
 * Input conventions (JS -> C):
 *   timestamp (ISO string)      -> t_ms = Date.parse(timestamp), int64 epoch ms
 *   accuracy null / undefined   -> NAN (current point only; fix and network
 *                                  accuracies must be finite)
 *   history (newest first)      -> ts_history, at most TS_MAX_HISTORY points
 *                                  (the scorers read only the first four)
 *   context.recentFixes         -> ctx->fixes / ctx->n_fixes (order as given)
 *   context.networkHint         -> ctx->has_network / ctx->network
 *   context.accCutoff           -> ctx->acc_cutoff; 0 means "not given" and
 *                                  selects TS_ACC_CUTOFF_M (V2' only)
 *   context undefined           -> ctx == NULL
 */
#ifndef TRUST_SCORER_H
#define TRUST_SCORER_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define TS_MAX_HISTORY 10
#define TS_MAX_FIXES 5
#define TS_WINDOW_S 15.0     /* S4' fix window (revised-scorer.mjs WINDOW_S) */
#define TS_ACC_CUTOFF_M 1.0  /* S2' cutoff (revised-scorer.mjs ACC_CUTOFF_M) */

typedef struct {
  double lat;      /* degrees */
  double lon;      /* degrees */
  double accuracy; /* metres; NAN = unknown */
  int64_t t_ms;    /* epoch milliseconds */
} ts_point;

typedef struct {
  ts_point pts[TS_MAX_HISTORY]; /* newest first */
  uint32_t n;
} ts_history;

typedef struct {
  double lat, lon, accuracy;
} ts_network_hint;

typedef struct {
  ts_point fixes[TS_MAX_FIXES]; /* recentFixes */
  uint32_t n_fixes;             /* 0 = no fixes */
  uint32_t has_network;         /* 0 = no network hint */
  ts_network_hint network;
  double acc_cutoff;            /* V2' S2' cutoff; 0 = default (1 m) */
} ts_context;

enum {
  TS_SIG_MOVEMENT = 1u << 0, /* S1 */
  TS_SIG_ACCURACY = 1u << 1, /* S2 / S2' */
  TS_SIG_TEMPORAL = 1u << 2, /* S3 */
  TS_SIG_FIX = 1u << 3,      /* S4 / S4' */
  TS_SIG_NETWORK = 1u << 4   /* S5 */
};

typedef struct {
  double trust_score;   /* clamped to [0,1], rounded to 0.01 */
  double raw;           /* weighted sum before clamping and rounding */
  double movement;      /* signals; NAN when absent (see present) */
  double accuracy;
  double temporal;
  double fix;
  double network;
  uint32_t present;     /* TS_SIG_* bitmask */
  uint32_t spoofing_suspected; /* trust_score < 0.3 */
} ts_result;

typedef enum { TS_PROCEED = 0, TS_STEP_UP = 1, TS_DENY = 2 } ts_decision;

void ts_context_init(ts_context *ctx);

void ts_score_v1(const ts_point *current, const ts_history *history, ts_result *out);
void ts_score_v2(const ts_point *current, const ts_history *history,
                 const ts_context *ctx, ts_result *out);
void ts_score_v2r(const ts_point *current, const ts_history *history,
                  const ts_context *ctx, ts_result *out);

/* gateTrustScore: >= proceed -> PROCEED, >= step_up -> STEP_UP, else DENY.
 * The paper's defaults are proceed = 0.7, step_up = 0.3. */
ts_decision ts_gate(double trust_score, double proceed, double step_up);

#ifdef TS_COUNT_OPS
/* Instrumentation build only: dynamic operation counts, accumulated over all
 * calls since the last ts_ops_reset(). Arithmetic is counted as compiled
 * (x / 2 and x / 0.5 become multiplications, x / 1 disappears). */
typedef struct {
  uint64_t add, mul, div, cmp, cvt;       /* double add/sub, mul, div, compare, int64->double */
  uint64_t sqrt_, sin_, cos_, atan2_, floor_;
  uint64_t distance;                      /* haversine evaluations */
} ts_opcount;
extern ts_opcount ts_ops;
void ts_ops_reset(void);
#endif

#ifdef __cplusplus
}
#endif

#endif /* TRUST_SCORER_H */
