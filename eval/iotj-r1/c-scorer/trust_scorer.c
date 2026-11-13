/*
 * C99 port of paper-scorer.mjs (V1, V2) and revised-scorer.mjs (V2').
 * See trust_scorer.h for the input conventions.
 *
 * Every expression keeps the JS operand order so that, given the same libm
 * results, each signal and score is bit-identical to the JS. Two deliberate
 * differences that do not change any result:
 *   - the JS evaluates Math.sin(d / 2) twice and squares by multiplying the
 *     two calls; here the sine is evaluated once and multiplied by itself;
 *   - V2' in JS first runs the whole submitted V2 (including the submitted S2
 *     and its rounding) and then discards everything but S1, S3 and S5; here
 *     only those three signals are computed.
 *
 * OPS(add, mul, div, cmp, cvt) annotations count the double-precision
 * operations of each block as compiled (x / 2.0 and x / 0.5 become
 * multiplications, x / 1.0 is folded away); they expand to nothing unless the
 * file is built with -DTS_COUNT_OPS.
 */
#include "trust_scorer.h"

#include <math.h>

#ifdef __clang__
#pragma STDC FP_CONTRACT OFF
#endif

#define TS_PI 3.141592653589793      /* Math.PI */
#define TS_EARTH_R 6371000.0         /* calculateDistance R */
#define TS_M_PER_DEG 111320.0        /* S4 / S4' metres per degree */
#define TS_ACC_CUTOFF_SUBMITTED 2.0  /* submitted S2 */

/* ---------------------------------------------------------------------- */
/* Instrumentation                                                         */
/* ---------------------------------------------------------------------- */
#ifdef TS_COUNT_OPS
ts_opcount ts_ops;
void ts_ops_reset(void) {
  static const ts_opcount zero;
  ts_ops = zero;
}
#define OPS(a, m, d, c, v) \
  (ts_ops.add += (a), ts_ops.mul += (m), ts_ops.div += (d), ts_ops.cmp += (c), ts_ops.cvt += (v))
static double c_sqrt(double x) { ts_ops.sqrt_++; return sqrt(x); }
static double c_sin(double x) { ts_ops.sin_++; return sin(x); }
static double c_cos(double x) { ts_ops.cos_++; return cos(x); }
static double c_atan2(double y, double x) { ts_ops.atan2_++; return atan2(y, x); }
static double c_floor(double x) { ts_ops.floor_++; return floor(x); }
#define TS_SQRT(x) c_sqrt(x)
#define TS_SIN(x) c_sin(x)
#define TS_COS(x) c_cos(x)
#define TS_ATAN2(y, x) c_atan2(y, x)
#define TS_FLOOR(x) c_floor(x)
#define COUNT_DISTANCE() (ts_ops.distance++)
#else
#define OPS(a, m, d, c, v) ((void)0)
#define TS_SQRT(x) sqrt(x)
#define TS_SIN(x) sin(x)
#define TS_COS(x) cos(x)
#define TS_ATAN2(y, x) atan2(y, x)
#define TS_FLOOR(x) floor(x)
#define COUNT_DISTANCE() ((void)0)
#endif

/* ---------------------------------------------------------------------- */
/* JS Math helpers (NaN-propagating like Math.min / Math.max / Math.round) */
/* ---------------------------------------------------------------------- */

/* Math.min(1, x) */
static double min1(double x) {
  OPS(0, 0, 0, 1, 0);
  return (1.0 < x) ? 1.0 : x;
}

/* Math.max(0, x) */
static double max0(double x) {
  OPS(0, 0, 0, 1, 0);
  return (0.0 > x) ? 0.0 : x;
}

/* Math.max(a, b) for a, b >= +0 or NaN */
static double js_max(double a, double b) {
  OPS(0, 0, 0, 1, 0);
  if (a > b) return a;
  OPS(0, 0, 0, 1, 0);
  return (a != a) ? a : b;
}

/* Math.round: nearest integer, ties toward +infinity. x - floor(x) is exact. */
static double js_round(double x) {
  double f = TS_FLOOR(x);
  OPS(1, 0, 0, 1, 0);
  if (x - f >= 0.5) {
    OPS(1, 0, 0, 0, 0);
    f += 1.0;
  }
  return f;
}

/* Math.round(Math.max(0, Math.min(1, raw)) * 100) / 100 */
static double round_score(double raw) {
  OPS(0, 1, 1, 0, 0);
  return js_round(max0(min1(raw)) * 100.0) / 100.0;
}

/* calculateDistance (haversine, metres) */
static double distance_m(double lat1, double lon1, double lat2, double lon2) {
  const double d_lat = (lat2 - lat1) * TS_PI / 180.0;
  const double d_lon = (lon2 - lon1) * TS_PI / 180.0;
  const double s_lat = TS_SIN(d_lat / 2.0);
  const double s_lon = TS_SIN(d_lon / 2.0);
  const double a = min1(s_lat * s_lat +
                        TS_COS(lat1 * TS_PI / 180.0) * TS_COS(lat2 * TS_PI / 180.0) *
                            s_lon * s_lon);
  const double c = 2.0 * TS_ATAN2(TS_SQRT(a), TS_SQRT(1.0 - a));
  OPS(4, 12, 4, 0, 0);
  COUNT_DISTANCE();
  return TS_EARTH_R * c;
}

static uint32_t history_len(const ts_history *h) {
  if (h == 0) return 0;
  return h->n < TS_MAX_HISTORY ? h->n : TS_MAX_HISTORY;
}

/* ---------------------------------------------------------------------- */
/* Signals                                                                 */
/* ---------------------------------------------------------------------- */

/* S1: movement plausibility */
static double score_movement(const ts_point *cur, const ts_point *hist, uint32_t n_hist) {
  const ts_point *prev;
  double dist, dt_ms, speed;
  if (n_hist == 0) return 0.8;
  prev = &hist[0];
  dist = distance_m(prev->lat, prev->lon, cur->lat, cur->lon);
  dt_ms = (double)(cur->t_ms - prev->t_ms);
  OPS(0, 0, 0, 1, 1);
  if (dt_ms <= 0.0) return 0.0;
  speed = dist / (dt_ms / 1000.0);
  OPS(0, 0, 2, 1, 0);
  if (speed <= 50.0) return 1.0;
  OPS(0, 0, 0, 1, 0);
  if (speed <= 150.0) {
    OPS(2, 1, 1, 0, 0);
    return 1.0 - 0.5 * ((speed - 50.0) / 100.0);
  }
  OPS(0, 0, 0, 1, 0);
  if (speed <= 300.0) {
    OPS(2, 1, 1, 0, 0);
    return 0.5 - 0.4 * ((speed - 150.0) / 150.0);
  }
  return 0.0;
}

/* S2 (cutoff 2) and S2' (cutoff 1): accuracy anomaly */
static double score_accuracy(double acc, double cutoff) {
  OPS(0, 0, 0, 1, 0);
  if (acc != acc) return 0.5; /* null / undefined */
  OPS(0, 0, 0, 1, 0);
  if (acc < cutoff) return 0.3;
  OPS(0, 0, 0, 1, 0);
  if (acc <= 100.0) return 1.0;
  OPS(0, 0, 0, 1, 0);
  if (acc <= 500.0) return 0.7;
  return 0.4;
}

/* S3: temporal consistency over current -> h[0] -> ... -> h[3] */
static double score_temporal(const ts_point *cur, const ts_point *hist, uint32_t n_hist) {
  uint32_t i, n_pairs;
  int violations = 0;
  if (n_hist < 2) return 0.7;
  n_pairs = n_hist < 4 ? n_hist : 4;
  for (i = 0; i < n_pairs; i++) {
    const ts_point *a = (i == 0) ? cur : &hist[i - 1];
    const ts_point *b = &hist[i];
    const double dist = distance_m(a->lat, a->lon, b->lat, b->lon);
    const double dt = (double)(a->t_ms - b->t_ms);
    OPS(0, 0, 0, 1, 1);
    if (dt <= 0.0) {
      violations++;
      continue;
    }
    OPS(0, 0, 2, 1, 0);
    if (dist / (dt / 1000.0) > 100.0) violations++;
  }
  if (violations == 0) return 1.0;
  if (violations == 1) return 0.6;
  if (violations == 2) return 0.3;
  return 0.0;
}

/* Shared piecewise map of S4 and S4' */
static double fix_ratio_map(double ratio) {
  OPS(0, 0, 0, 1, 0);
  if (ratio <= 0.5) return 1.0;
  OPS(0, 0, 0, 1, 0);
  if (ratio <= 1.0) {
    OPS(2, 2, 0, 0, 0);
    return 1.0 - 0.3 * ((ratio - 0.5) / 0.5);
  }
  OPS(0, 0, 0, 1, 0);
  if (ratio <= 2.0) {
    OPS(2, 1, 0, 0, 0);
    return 0.7 - 0.3 * ((ratio - 1.0) / 1.0);
  }
  return 0.2;
}

/* S4 (submitted): raw scatter of the recent fixes vs their mean accuracy */
static double score_fix_consistency(const ts_point *fx, uint32_t n) {
  uint32_t i;
  double nd, sum_lat = 0.0, sum_lon = 0.0, sum_acc = 0.0, v_lat = 0.0, v_lon = 0.0;
  double mean_lat, mean_lon, mean_acc, std_lat_m, std_lon_m, max_std;
  if (n < 3) return 0.8;
  nd = (double)n;
  OPS(0, 0, 0, 0, 1);
  for (i = 0; i < n; i++) {
    sum_lat += fx[i].lat;
    sum_lon += fx[i].lon;
    sum_acc += fx[i].accuracy;
    OPS(3, 0, 0, 0, 0);
  }
  mean_lat = sum_lat / nd;
  mean_lon = sum_lon / nd;
  mean_acc = sum_acc / nd;
  for (i = 0; i < n; i++) {
    const double d_lat = fx[i].lat - mean_lat;
    const double d_lon = fx[i].lon - mean_lon;
    v_lat += d_lat * d_lat;
    v_lon += d_lon * d_lon;
    OPS(4, 2, 0, 0, 0);
  }
  std_lat_m = TS_SQRT(v_lat / nd) * TS_M_PER_DEG;
  std_lon_m = TS_SQRT(v_lon / nd) * TS_M_PER_DEG * TS_COS((mean_lat * TS_PI) / 180.0);
  OPS(0, 4, 6, 1, 0);
  max_std = js_max(std_lat_m, std_lon_m);
  if (mean_acc <= 0.0) return 0.5;
  OPS(0, 0, 1, 0, 0);
  return fix_ratio_map(max_std / mean_acc);
}

/* S5: network position cross-check */
static double score_network(const ts_point *cur, const ts_network_hint *h) {
  const double dist = distance_m(cur->lat, cur->lon, h->lat, h->lon);
  OPS(0, 0, 0, 1, 0);
  if (dist < h->accuracy) return 1.0;
  OPS(0, 1, 0, 1, 0);
  if (dist < 2.0 * h->accuracy) return 0.7;
  OPS(0, 1, 0, 1, 0);
  if (dist < 5.0 * h->accuracy) return 0.5;
  return 0.3;
}

/* Residual standard deviation of one axis after a least-squares line in t */
static double axis_std(const double *t, const double *p, uint32_t n, double nd, double tm,
                       double stt, int has_slope) {
  uint32_t i;
  double sum = 0.0, m, slope = 0.0, sse = 0.0;
  for (i = 0; i < n; i++) {
    sum += p[i];
    OPS(1, 0, 0, 0, 0);
  }
  m = sum / nd;
  OPS(0, 0, 1, 0, 0);
  if (has_slope) {
    double s = 0.0;
    for (i = 0; i < n; i++) {
      s += (t[i] - tm) * (p[i] - m);
      OPS(3, 1, 0, 0, 0);
    }
    slope = s / stt;
    OPS(0, 0, 1, 0, 0);
  }
  for (i = 0; i < n; i++) {
    const double r = p[i] - m - slope * (t[i] - tm);
    sse += r * r;
    OPS(4, 2, 0, 0, 0);
  }
  {
    const int64_t dof_i = (int64_t)n - (has_slope ? 2 : 1);
    const double dof = (double)(dof_i > 1 ? dof_i : 1); /* Math.max(1, ...) */
    OPS(0, 0, 1, 0, 1);
    return TS_SQRT(sse / dof);
  }
}

/* detrendedScatter: residual scatter (m) after a constant-velocity fit */
static double detrended_scatter(const ts_point *fx, const uint32_t *idx, uint32_t n) {
  double t[TS_MAX_FIXES], x[TS_MAX_FIXES], y[TS_MAX_FIXES];
  double nd, sum_lat = 0.0, sum_lon = 0.0, lat0, lon0, k_lon, sum_t = 0.0, tm, stt = 0.0;
  int64_t t0;
  int has_slope;
  uint32_t i;
  nd = (double)n;
  OPS(0, 0, 0, 0, 1);
  for (i = 0; i < n; i++) {
    sum_lat += fx[idx[i]].lat;
    OPS(1, 0, 0, 0, 0);
  }
  for (i = 0; i < n; i++) {
    sum_lon += fx[idx[i]].lon;
    OPS(1, 0, 0, 0, 0);
  }
  lat0 = sum_lat / nd;
  lon0 = sum_lon / nd;
  k_lon = TS_M_PER_DEG * TS_COS((lat0 * TS_PI) / 180.0);
  OPS(0, 2, 3, 0, 0);
  t0 = fx[idx[0]].t_ms;
  for (i = 0; i < n; i++) {
    const ts_point *f = &fx[idx[i]];
    t[i] = (double)(f->t_ms - t0) / 1000.0;
    x[i] = (f->lon - lon0) * k_lon;
    y[i] = (f->lat - lat0) * TS_M_PER_DEG;
    OPS(2, 2, 1, 0, 1);
  }
  for (i = 0; i < n; i++) {
    sum_t += t[i];
    OPS(1, 0, 0, 0, 0);
  }
  tm = sum_t / nd;
  OPS(0, 0, 1, 0, 0);
  for (i = 0; i < n; i++) {
    const double d = t[i] - tm;
    stt += d * d;
    OPS(2, 1, 0, 0, 0);
  }
  has_slope = stt > 0.0;
  OPS(0, 0, 0, 1, 0);
  {
    const double sx = axis_std(t, x, n, nd, tm, stt, has_slope);
    const double sy = axis_std(t, y, n, nd, tm, stt, has_slope);
    return js_max(sx, sy);
  }
}

/* S4': fixes from the last TS_WINDOW_S seconds, detrended scatter.
 * Returns 0 when unavailable (fewer than three fixes in the window). */
static int score_fix_consistency_revised(const ts_point *cur, const ts_point *fx, uint32_t n_in,
                                         double *out) {
  uint32_t idx[TS_MAX_FIXES], k = 0, i;
  double sum_acc = 0.0, mean_acc;
  if (n_in > TS_MAX_FIXES) n_in = TS_MAX_FIXES;
  for (i = 0; i < n_in; i++) {
    const double dt = (double)(cur->t_ms - fx[i].t_ms) / 1000.0;
    OPS(0, 0, 1, 1, 1);
    if (dt >= 0.0) {
      OPS(0, 0, 0, 1, 0);
      if (dt <= TS_WINDOW_S) idx[k++] = i;
    }
  }
  if (k < 3) return 0;
  for (i = 0; i < k; i++) {
    sum_acc += fx[idx[i]].accuracy;
    OPS(1, 0, 0, 0, 0);
  }
  mean_acc = sum_acc / (double)k;
  OPS(0, 0, 1, 1, 1);
  if (mean_acc <= 0.0) {
    *out = 0.5;
    return 1;
  }
  {
    const double scatter = detrended_scatter(fx, idx, k);
    OPS(0, 0, 1, 0, 0);
    *out = fix_ratio_map(scatter / mean_acc);
  }
  return 1;
}

/* ---------------------------------------------------------------------- */
/* Public API                                                              */
/* ---------------------------------------------------------------------- */

void ts_context_init(ts_context *ctx) {
  static const ts_context zero;
  *ctx = zero;
  ctx->acc_cutoff = TS_ACC_CUTOFF_M;
}

static void finish(ts_result *out, double raw, double m, double a, double t, double f, double n,
                   uint32_t present) {
  out->raw = raw;
  out->trust_score = round_score(raw);
  OPS(0, 0, 0, 1, 0);
  out->spoofing_suspected = out->trust_score < 0.3;
  out->movement = m;
  out->accuracy = a;
  out->temporal = t;
  out->fix = (present & TS_SIG_FIX) ? f : NAN;
  out->network = (present & TS_SIG_NETWORK) ? n : NAN;
  out->present = present;
}

#define BASE_SIGNALS (TS_SIG_MOVEMENT | TS_SIG_ACCURACY | TS_SIG_TEMPORAL)

void ts_score_v1(const ts_point *cur, const ts_history *history, ts_result *out) {
  const uint32_t nh = history_len(history);
  const ts_point *h = history ? history->pts : 0;
  const double m = score_movement(cur, h, nh);
  const double a = score_accuracy(cur->accuracy, TS_ACC_CUTOFF_SUBMITTED);
  const double t = score_temporal(cur, h, nh);
  const double raw = 0.5 * m + 0.2 * a + 0.3 * t;
  OPS(2, 3, 0, 0, 0);
  finish(out, raw, m, a, t, 0.0, 0.0, BASE_SIGNALS);
}

void ts_score_v2(const ts_point *cur, const ts_history *history, const ts_context *ctx,
                 ts_result *out) {
  const int has_fixes = ctx != 0 && ctx->n_fixes > 0;
  const int has_net = ctx != 0 && ctx->has_network != 0;
  const uint32_t nh = history_len(history);
  const ts_point *h = history ? history->pts : 0;
  double m, a, t, f = 0.0, n = 0.0, w_m, w_a, w_t, w_f, w_n, raw;
  uint32_t present = BASE_SIGNALS;
  if (!has_fixes && !has_net) {
    ts_score_v1(cur, history, out);
    return;
  }
  m = score_movement(cur, h, nh);
  a = score_accuracy(cur->accuracy, TS_ACC_CUTOFF_SUBMITTED);
  t = score_temporal(cur, h, nh);
  if (has_fixes && has_net) {
    w_m = 0.30; w_a = 0.10; w_t = 0.15; w_f = 0.25; w_n = 0.20;
    f = score_fix_consistency(ctx->fixes, ctx->n_fixes < TS_MAX_FIXES ? ctx->n_fixes : TS_MAX_FIXES);
    n = score_network(cur, &ctx->network);
    present |= TS_SIG_FIX | TS_SIG_NETWORK;
  } else if (has_fixes) {
    w_m = 0.35; w_a = 0.15; w_t = 0.20; w_f = 0.30; w_n = 0;
    f = score_fix_consistency(ctx->fixes, ctx->n_fixes < TS_MAX_FIXES ? ctx->n_fixes : TS_MAX_FIXES);
    present |= TS_SIG_FIX;
  } else {
    w_m = 0.40; w_a = 0.15; w_t = 0.20; w_f = 0; w_n = 0.25;
    n = score_network(cur, &ctx->network);
    present |= TS_SIG_NETWORK;
  }
  /* wF * (fixConsistency ?? 0) + wN * (networkConsistency ?? 0) */
  raw = w_m * m + w_a * a + w_t * t + w_f * f + w_n * n;
  OPS(4, 5, 0, 0, 0);
  finish(out, raw, m, a, t, f, n, present);
}

void ts_score_v2r(const ts_point *cur, const ts_history *history, const ts_context *ctx,
                  ts_result *out) {
  const uint32_t nh = history_len(history);
  const ts_point *h = history ? history->pts : 0;
  const int has_net = ctx != 0 && ctx->has_network != 0;
  const double cutoff = (ctx != 0 && ctx->acc_cutoff != 0.0) ? ctx->acc_cutoff : TS_ACC_CUTOFF_M;
  double m, a, t, f = 0.0, n = 0.0, raw;
  int has_s4 = 0;
  uint32_t present = BASE_SIGNALS;
  if (ctx != 0 && ctx->n_fixes > 0)
    has_s4 = score_fix_consistency_revised(cur, ctx->fixes, ctx->n_fixes, &f);
  m = score_movement(cur, h, nh);
  t = score_temporal(cur, h, nh);
  if (has_net) n = score_network(cur, &ctx->network);
  a = score_accuracy(cur->accuracy, cutoff);
  /* Object.entries(w).reduce((s, [k, wk]) => s + wk * signals[k], 0) */
  raw = 0.0;
  if (has_s4 && has_net) {
    raw += 0.30 * m; raw += 0.10 * a; raw += 0.15 * t; raw += 0.25 * f; raw += 0.20 * n;
    present |= TS_SIG_FIX | TS_SIG_NETWORK;
    OPS(5, 5, 0, 0, 0);
  } else if (has_s4) {
    raw += 0.35 * m; raw += 0.15 * a; raw += 0.20 * t; raw += 0.30 * f;
    present |= TS_SIG_FIX;
    OPS(4, 4, 0, 0, 0);
  } else if (has_net) {
    raw += 0.40 * m; raw += 0.15 * a; raw += 0.20 * t; raw += 0.25 * n;
    present |= TS_SIG_NETWORK;
    OPS(4, 4, 0, 0, 0);
  } else {
    raw += 0.50 * m; raw += 0.20 * a; raw += 0.30 * t;
    OPS(3, 3, 0, 0, 0);
  }
  finish(out, raw, m, a, t, f, n, present);
}

ts_decision ts_gate(double trust_score, double proceed, double step_up) {
  if (trust_score >= proceed) return TS_PROCEED;
  if (trust_score >= step_up) return TS_STEP_UP;
  return TS_DENY;
}
