/*
 * Test / benchmark driver for trust_scorer.c.
 *
 *   ts_driver verify <inputs.txt>...          compare C against the JS scores
 *   ts_driver bench  <inputs-dev.txt> [passes] [chunk]
 *                                             per-score latency of V2 / V2'
 *   ts_driver ops    <inputs.txt>...          operation counts (-DTS_COUNT_OPS)
 *   ts_driver sizes                           struct sizes
 *
 * All modes print one JSON object to stdout and a readable summary to stderr.
 * Input files come from export-inputs.mjs. The driver allocates; the scorer
 * does not.
 */
#if !defined(_WIN32) && !defined(_POSIX_C_SOURCE)
#define _POSIX_C_SOURCE 199309L
#endif
#include <inttypes.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "trust_scorer.h"

#ifdef _WIN32
#include <windows.h>
#else
#include <time.h>
#endif
#if defined(_MSC_VER) && defined(_M_X64)
#include <intrin.h>
#define HAVE_RDTSC 1
#elif defined(__x86_64__)
#include <x86intrin.h>
#define HAVE_RDTSC 1
#endif

#define NCFG 10
static const char *CFG_NAMES[NCFG] = {"V1",      "V2/both",  "V2/fixes", "V2/net",  "V2/none",
                                      "V2r/both", "V2r/fixes", "V2r/net", "V2r/none", "V2r/both/cut2"};
static const char *SIG_NAMES[7] = {"S1", "S2", "S2r", "S3", "S4", "S4r", "S5"};
enum { SIG_M, SIG_A2, SIG_A1, SIG_T, SIG_F, SIG_FR, SIG_N };

typedef struct {
  int split, scen, label;
  ts_point cur;
  ts_history hist;
  ts_context ctx; /* full context: fixes + network, default cutoff */
  double sig[7];
  uint32_t sig_present;
  double score[NCFG];
  uint32_t mask[NCFG];
} rec_t;

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

static char *tok_next(char **p) {
  char *s = *p, *e;
  while (*s == ' ' || *s == '\t') s++;
  if (*s == '\0' || *s == '\n' || *s == '\r') {
    fprintf(stderr, "truncated line\n");
    exit(2);
  }
  e = s;
  while (*e && *e != ' ' && *e != '\t' && *e != '\n' && *e != '\r') e++;
  if (*e) *e++ = '\0';
  *p = e;
  return s;
}

static double tok_hex(char **p, int *present) {
  const char *s = tok_next(p);
  uint64_t u;
  double d;
  if (s[0] == '-' && s[1] == '\0') {
    if (present) *present = 0;
    return NAN;
  }
  if (present) *present = 1;
  u = (uint64_t)strtoull(s, 0, 16);
  memcpy(&d, &u, sizeof d);
  return d;
}

static long long tok_int(char **p) { return strtoll(tok_next(p), 0, 10); }

static void read_point(char **p, ts_point *pt) {
  pt->lat = tok_hex(p, 0);
  pt->lon = tok_hex(p, 0);
  pt->accuracy = tok_hex(p, 0);
  pt->t_ms = (int64_t)tok_int(p);
}

static rec_t *load(int nfiles, char **files, size_t *n_out) {
  size_t cap = 0, n = 0;
  rec_t *recs = 0;
  static char line[1 << 16];
  int fi;
  for (fi = 0; fi < nfiles; fi++) {
    FILE *f = fopen(files[fi], "rb");
    if (!f) {
      fprintf(stderr, "cannot open %s\n", files[fi]);
      exit(2);
    }
    while (fgets(line, sizeof line, f)) {
      char *p = line;
      rec_t *r;
      long long k, i;
      int c, present;
      if (line[0] == '#' || line[0] == '\n' || line[0] == '\r') continue;
      if (n == cap) {
        cap = cap ? cap * 2 : 1024;
        recs = (rec_t *)realloc(recs, cap * sizeof *recs);
        if (!recs) {
          fprintf(stderr, "out of memory\n");
          exit(2);
        }
      }
      r = &recs[n++];
      memset(r, 0, sizeof *r);
      ts_context_init(&r->ctx);
      r->ctx.acc_cutoff = 0.0; /* "not given" -> default */
      r->split = (int)tok_int(&p);
      r->scen = (int)tok_int(&p);
      r->label = (int)tok_int(&p);
      read_point(&p, &r->cur);
      k = tok_int(&p);
      if (k < 0 || k > TS_MAX_HISTORY) {
        fprintf(stderr, "history length %lld exceeds capacity\n", k);
        exit(2);
      }
      r->hist.n = (uint32_t)k;
      for (i = 0; i < k; i++) read_point(&p, &r->hist.pts[i]);
      k = tok_int(&p);
      if (k < 0 || k > TS_MAX_FIXES) {
        fprintf(stderr, "fix count %lld exceeds capacity\n", k);
        exit(2);
      }
      r->ctx.n_fixes = (uint32_t)k;
      for (i = 0; i < k; i++) read_point(&p, &r->ctx.fixes[i]);
      r->ctx.has_network = (uint32_t)tok_int(&p);
      if (r->ctx.has_network) {
        r->ctx.network.lat = tok_hex(&p, 0);
        r->ctx.network.lon = tok_hex(&p, 0);
        r->ctx.network.accuracy = tok_hex(&p, 0);
      }
      for (c = 0; c < 7; c++) {
        r->sig[c] = tok_hex(&p, &present);
        if (present) r->sig_present |= 1u << c;
      }
      for (c = 0; c < NCFG; c++) {
        r->score[c] = tok_hex(&p, 0);
        r->mask[c] = (uint32_t)tok_int(&p);
      }
    }
    fclose(f);
  }
  *n_out = n;
  return recs;
}

/* ------------------------------------------------------------------ */
/* Configurations                                                      */
/* ------------------------------------------------------------------ */

static void run_cfg(int cfg, const rec_t *r, ts_result *out) {
  ts_context c = r->ctx;
  switch (cfg) {
    case 0: ts_score_v1(&r->cur, &r->hist, out); return;
    case 1: ts_score_v2(&r->cur, &r->hist, &c, out); return;
    case 2: c.has_network = 0; ts_score_v2(&r->cur, &r->hist, &c, out); return;
    case 3: c.n_fixes = 0; ts_score_v2(&r->cur, &r->hist, &c, out); return;
    case 4: c.n_fixes = 0; c.has_network = 0; ts_score_v2(&r->cur, &r->hist, &c, out); return;
    case 5: ts_score_v2r(&r->cur, &r->hist, &c, out); return;
    case 6: c.has_network = 0; ts_score_v2r(&r->cur, &r->hist, &c, out); return;
    case 7: c.n_fixes = 0; ts_score_v2r(&r->cur, &r->hist, &c, out); return;
    case 8: c.n_fixes = 0; c.has_network = 0; ts_score_v2r(&r->cur, &r->hist, &c, out); return;
    default: c.acc_cutoff = 2.0; ts_score_v2r(&r->cur, &r->hist, &c, out); return;
  }
}

static int same_bits(double a, double b) { return memcmp(&a, &b, sizeof a) == 0; }

/* distance in units in the last place (same-sign finite doubles) */
static uint64_t ulps(double a, double b) {
  int64_t x, y;
  memcpy(&x, &a, sizeof x);
  memcpy(&y, &b, sizeof y);
  return x > y ? (uint64_t)(x - y) : (uint64_t)(y - x);
}

/* |raw * 100 - (k + 0.5)|: distance of the scaled raw score from the nearest
 * rounding tie of Math.round(raw * 100) */
static double tie_distance(double raw) {
  const double x = raw * 100.0;
  return fabs(x - (floor(x) + 0.5));
}

/* Sensitivity of the rounded score to implementation choices a port might
 * make differently. Recomputes the weighted sum from the C signals with the
 * Table I profile selected by the present mask. */
enum { ALT_REVERSE, ALT_FMA, ALT_RINT, ALT_F32, NALT };
static const char *ALT_NAMES[NALT] = {"reverseSumOrder", "fmaChain", "roundHalfEven",
                                      "float32Sum"};

static double js_round_score(double raw) {
  double x = (raw < 1.0 ? raw : 1.0);
  double f;
  x = (x > 0.0 ? x : 0.0) * 100.0;
  f = floor(x);
  if (x - f >= 0.5) f += 1.0;
  return f / 100.0;
}

static void alt_scores(const ts_result *o, double out[NALT]) {
  double w[5], s[5], raw;
  float rf;
  int k = 0, j;
  const uint32_t fx = o->present & TS_SIG_FIX, nw = o->present & TS_SIG_NETWORK;
  const double wm = fx && nw ? 0.30 : fx ? 0.35 : nw ? 0.40 : 0.50;
  const double wa = fx && nw ? 0.10 : (fx || nw) ? 0.15 : 0.20;
  const double wt = fx && nw ? 0.15 : (fx || nw) ? 0.20 : 0.30;
  w[k] = wm; s[k++] = o->movement;
  w[k] = wa; s[k++] = o->accuracy;
  w[k] = wt; s[k++] = o->temporal;
  if (fx) { w[k] = nw ? 0.25 : 0.30; s[k++] = o->fix; }
  if (nw) { w[k] = nw && fx ? 0.20 : 0.25; s[k++] = o->network; }
  raw = 0.0;
  for (j = k - 1; j >= 0; j--) raw += w[j] * s[j];
  out[ALT_REVERSE] = js_round_score(raw);
  raw = w[0] * s[0];
  for (j = 1; j < k; j++) raw = fma(w[j], s[j], raw);
  out[ALT_FMA] = js_round_score(raw);
  {
    double x = o->raw < 1.0 ? o->raw : 1.0;
    x = x > 0.0 ? x : 0.0;
    out[ALT_RINT] = rint(x * 100.0) / 100.0;
  }
  rf = 0.0f;
  for (j = 0; j < k; j++) rf += (float)w[j] * (float)s[j];
  out[ALT_F32] = js_round_score((double)rf);
}

/* Expected JS signal index for each result field in a configuration */
static void expected_sig(int cfg, int *ia, int *i_f) {
  const int revised = cfg >= 5;
  *ia = (revised && cfg != 9) ? SIG_A1 : SIG_A2;
  *i_f = revised ? SIG_FR : SIG_F;
}

static void print_platform_json(void) {
  printf("\"platform\":{");
#if defined(__clang__)
  printf("\"compiler\":\"clang %s\",", __clang_version__);
#elif defined(__GNUC__)
  printf("\"compiler\":\"gcc %s\",", __VERSION__);
#elif defined(_MSC_VER)
  printf("\"compiler\":\"msvc %d\",", _MSC_VER);
#endif
#if defined(__x86_64__) || defined(_M_X64)
  printf("\"arch\":\"x86_64\",");
#elif defined(__aarch64__)
  printf("\"arch\":\"aarch64\",");
#else
  printf("\"arch\":\"other\",");
#endif
#if defined(__FP_FAST_FMA)
  printf("\"fma_available\":true,");
#else
  printf("\"fma_available\":false,");
#endif
  printf("\"ptr_bits\":%d}", (int)(8 * sizeof(void *)));
}

/* ------------------------------------------------------------------ */
/* verify                                                              */
/* ------------------------------------------------------------------ */

static int cmd_verify(int nfiles, char **files) {
  size_t n, i;
  rec_t *recs = load(nfiles, files, &n);
  long score_ok[NCFG] = {0}, sig_ok[NCFG] = {0}, mask_ok[NCFG] = {0};
  long sig_field_bad[7] = {0}, null_ctx_bad = 0, shown = 0;
  uint64_t sig_max_ulp[7] = {0};
  double sig_max_abs[7] = {0};
  long per_split_ok[3][NCFG] = {{0}}, per_split_n[3] = {0};
  long near_tie[NCFG] = {0};
  long alt_diff[NCFG][NALT] = {{0}}, alt_gate07[NCFG][NALT] = {{0}}, alt_gate09[NCFG][NALT] = {{0}};
  double min_tie_mis[NCFG];
  int c, fail = 0;
  for (c = 0; c < NCFG; c++) min_tie_mis[c] = INFINITY;
#define CHECK_SIG(val, idx)                                                       \
  do {                                                                            \
    if (!same_bits((val), r->sig[(idx)])) {                                       \
      const uint64_t u = ulps((val), r->sig[(idx)]);                              \
      const double d = fabs((val) - r->sig[(idx)]);                               \
      sig_good = 0;                                                               \
      sig_field_bad[(idx)]++;                                                     \
      if (u > sig_max_ulp[(idx)]) sig_max_ulp[(idx)] = u;                         \
      if (d > sig_max_abs[(idx)]) sig_max_abs[(idx)] = d;                         \
    }                                                                             \
  } while (0)
  for (i = 0; i < n; i++) {
    const rec_t *r = &recs[i];
    if (r->split >= 0 && r->split < 3) per_split_n[r->split]++;
    for (c = 0; c < NCFG; c++) {
      ts_result o;
      int ia, i_f, sig_good = 1;
      run_cfg(c, r, &o);
      expected_sig(c, &ia, &i_f);
      CHECK_SIG(o.movement, SIG_M);
      CHECK_SIG(o.accuracy, ia);
      CHECK_SIG(o.temporal, SIG_T);
      if (o.present & TS_SIG_FIX) {
        if (!((r->sig_present >> i_f) & 1u)) {
          sig_good = 0;
          sig_field_bad[i_f]++;
        } else {
          CHECK_SIG(o.fix, i_f);
        }
      }
      if (o.present & TS_SIG_NETWORK) CHECK_SIG(o.network, SIG_N);
      if (o.present == r->mask[c]) mask_ok[c]++;
      if (sig_good) sig_ok[c]++;
      if (tie_distance(o.raw) < 1e-9) near_tie[c]++;
      {
        double alt[NALT];
        int a;
        alt_scores(&o, alt);
        for (a = 0; a < NALT; a++) {
          if (alt[a] != r->score[c]) alt_diff[c][a]++;
          if (ts_gate(alt[a], 0.7, 0.3) != ts_gate(r->score[c], 0.7, 0.3)) alt_gate07[c][a]++;
          if (ts_gate(alt[a], 0.9, 0.3) != ts_gate(r->score[c], 0.9, 0.3)) alt_gate09[c][a]++;
        }
      }
      if (!sig_good && tie_distance(o.raw) < min_tie_mis[c]) min_tie_mis[c] = tie_distance(o.raw);
      if (same_bits(o.trust_score, r->score[c])) {
        score_ok[c]++;
        if (r->split >= 0 && r->split < 3) per_split_ok[r->split][c]++;
      } else if (shown < 20) {
        shown++;
        fprintf(stderr,
                "MISMATCH %s split=%d scen=%d rec=%zu js=%.17g c=%.17g raw=%.17g "
                "m=%.17g a=%.17g t=%.17g f=%.17g n=%.17g\n",
                CFG_NAMES[c], r->split, r->scen, i, r->score[c], o.trust_score, o.raw, o.movement,
                o.accuracy, o.temporal, o.fix, o.network);
      }
    }
    {
      /* JS {} context == undefined context == C NULL context */
      ts_result a, b;
      ts_score_v2(&r->cur, &r->hist, 0, &a);
      ts_score_v2r(&r->cur, &r->hist, 0, &b);
      if (!same_bits(a.trust_score, r->score[4]) || !same_bits(b.trust_score, r->score[8]))
        null_ctx_bad++;
    }
  }
  printf("{\"mode\":\"verify\",");
  print_platform_json();
  printf(",\"traces\":%zu,\"perSplitTraces\":{\"dev\":%ld,\"val\":%ld,\"test\":%ld},\"configs\":{",
         n, per_split_n[0], per_split_n[1], per_split_n[2]);
  for (c = 0; c < NCFG; c++) {
    printf("%s\"%s\":{\"n\":%zu,\"scoreExact\":%ld,\"signalsBitExact\":%ld,\"maskEqual\":%ld,"
           "\"perSplitScoreExact\":{\"dev\":%ld,\"val\":%ld,\"test\":%ld},"
           "\"rawWithin1e-9OfRoundingTie\":%ld,\"minTieDistanceWhereSignalsDiffer\":%.3e,"
           "\"scoresChangedIf\":{",
           c ? "," : "", CFG_NAMES[c], n, score_ok[c], sig_ok[c], mask_ok[c], per_split_ok[0][c],
           per_split_ok[1][c], per_split_ok[2][c], near_tie[c],
           isinf(min_tie_mis[c]) ? -1.0 : min_tie_mis[c]);
    {
      int a;
      for (a = 0; a < NALT; a++)
        printf("%s\"%s\":{\"scores\":%ld,\"gate0.7/0.3\":%ld,\"gate0.9/0.3\":%ld}", a ? "," : "",
               ALT_NAMES[a], alt_diff[c][a], alt_gate07[c][a], alt_gate09[c][a]);
      printf("}}");
      fprintf(stderr, "%-14s   scores changed by: reverse order %ld, fma %ld, half-even %ld, float32 %ld\n",
              CFG_NAMES[c], alt_diff[c][0], alt_diff[c][1], alt_diff[c][2], alt_diff[c][3]);
    }
    fprintf(stderr,
            "%-14s scores %zu/%zu exact, signals %ld/%zu bit-exact, masks %ld/%zu, "
            "raw on a rounding tie: %ld\n",
            CFG_NAMES[c], (size_t)score_ok[c], n, sig_ok[c], n, mask_ok[c], n, near_tie[c]);
    if ((size_t)score_ok[c] != n || (size_t)mask_ok[c] != n) fail = 1;
  }
  printf("},\"signalFieldMismatches\":{");
  for (c = 0; c < 7; c++)
    printf("%s\"%s\":{\"count\":%ld,\"maxUlp\":%" PRIu64 ",\"maxAbs\":%.3e}", c ? "," : "",
           SIG_NAMES[c], sig_field_bad[c], sig_max_ulp[c], sig_max_abs[c]);
  printf("},\"nullContextMismatches\":%ld}\n", null_ctx_bad);
  for (c = 0; c < 7; c++)
    if (sig_field_bad[c])
      fprintf(stderr, "  signal %-3s differs in %ld evaluations, max %" PRIu64 " ulp (%.3e)\n",
              SIG_NAMES[c], sig_field_bad[c], sig_max_ulp[c], sig_max_abs[c]);
  if (null_ctx_bad) fail = 1;
  fprintf(stderr, "%s\n",
          fail ? "VERIFY: SCORE MISMATCHES (see above)" : "VERIFY: all trust scores exact");
  free(recs);
  return fail;
}

/* ------------------------------------------------------------------ */
/* bench                                                               */
/* ------------------------------------------------------------------ */

#ifdef _WIN32
static int64_t ticks(void) {
  LARGE_INTEGER c;
  QueryPerformanceCounter(&c);
  return (int64_t)c.QuadPart;
}
static double tick_ns(void) {
  LARGE_INTEGER f;
  QueryPerformanceFrequency(&f);
  return 1e9 / (double)f.QuadPart;
}
#else
static int64_t ticks(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (int64_t)ts.tv_sec * 1000000000 + ts.tv_nsec;
}
static double tick_ns(void) { return 1.0; }
#endif

static int cmp_double(const void *a, const void *b) {
  const double x = *(const double *)a, y = *(const double *)b;
  return (x > y) - (x < y);
}

static double pct(const double *sorted, size_t n, double p) {
  /* nearest-rank percentile */
  size_t k = (size_t)ceil(p / 100.0 * (double)n);
  if (k < 1) k = 1;
  if (k > n) k = n;
  return sorted[k - 1];
}

typedef void (*scorer_fn)(const ts_point *, const ts_history *, const ts_context *, ts_result *);

static volatile double g_sink;

static void print_stats(const char *name, double *s, size_t n, int last) {
  double sum = 0;
  size_t i;
  qsort(s, n, sizeof *s, cmp_double);
  for (i = 0; i < n; i++) sum += s[i];
  printf("\"%s\":{\"samples\":%zu,\"median_ns\":%.2f,\"p99_ns\":%.2f,\"p999_ns\":%.2f,"
         "\"mean_ns\":%.2f,\"min_ns\":%.2f,\"max_ns\":%.2f}%s",
         name, n, pct(s, n, 50), pct(s, n, 99), pct(s, n, 99.9), sum / (double)n, s[0], s[n - 1],
         last ? "" : ",");
  fprintf(stderr, "  %-22s median %8.2f ns  p99 %8.2f ns  mean %8.2f ns  (n=%zu)\n", name,
          pct(s, n, 50), pct(s, n, 99), sum / (double)n, n);
}

#ifdef HAVE_RDTSC
static double tsc_ns_per_tick(void) {
  const double qns = tick_ns();
  int64_t q0 = ticks(), q1;
  uint64_t t0 = __rdtsc(), t1;
  do {
    q1 = ticks();
  } while ((double)(q1 - q0) * qns < 2e8); /* 200 ms */
  t1 = __rdtsc();
  return (double)(q1 - q0) * qns / (double)(t1 - t0);
}
#endif

static int cmd_bench(const char *file, int passes, int chunk) {
  size_t n, i, k;
  rec_t *recs = load(1, (char **)&file, &n);
  const double qns = tick_ns();
  scorer_fn fns[2] = {ts_score_v2, ts_score_v2r};
  const char *names[2] = {"V2_full", "V2r_full"};
  const size_t nchunks = n / (size_t)chunk;
  double *chunk_s[2], *call_s[2];
  size_t nch[2] = {0, 0}, ncall[2] = {0, 0};
  double total_ns[2] = {0, 0}, calls[2] = {0, 0};
  int p, f;
#ifdef HAVE_RDTSC
  double tsc_ns, overhead_ticks;
#endif
#ifdef _WIN32
  /* fewer migrations and preemptions: one core, high (not realtime) priority */
  SetPriorityClass(GetCurrentProcess(), HIGH_PRIORITY_CLASS);
  SetThreadAffinityMask(GetCurrentThread(), (DWORD_PTR)1 << 2);
#endif
#ifdef HAVE_RDTSC
  tsc_ns = tsc_ns_per_tick();
#endif
  for (f = 0; f < 2; f++) {
    chunk_s[f] = (double *)malloc(sizeof(double) * nchunks * (size_t)passes);
    call_s[f] = (double *)malloc(sizeof(double) * n * (size_t)passes);
  }
  /* warm-up: two passes of each scorer */
  for (p = 0; p < 2; p++)
    for (f = 0; f < 2; f++)
      for (i = 0; i < n; i++) {
        ts_result o;
        fns[f](&recs[i].cur, &recs[i].hist, &recs[i].ctx, &o);
        g_sink += o.trust_score;
      }
  /* chunked timing: per-score latency = chunk time / chunk, over the dev
   * traces in order, alternating scorers pass by pass */
  for (p = 0; p < passes; p++) {
    for (f = 0; f < 2; f++) {
      for (k = 0; k < nchunks; k++) {
        double acc = 0;
        const int64_t t0 = ticks();
        int64_t t1;
        for (i = k * (size_t)chunk; i < (k + 1) * (size_t)chunk; i++) {
          ts_result o;
          fns[f](&recs[i].cur, &recs[i].hist, &recs[i].ctx, &o);
          acc += o.trust_score;
        }
        t1 = ticks();
        g_sink += acc;
        chunk_s[f][nch[f]++] = (double)(t1 - t0) * qns / (double)chunk;
        total_ns[f] += (double)(t1 - t0) * qns;
        calls[f] += chunk;
      }
    }
  }
#ifdef HAVE_RDTSC
  /* single-call timing with serialized rdtsc, minus the empty-pair median */
  {
    double *emp = (double *)malloc(sizeof(double) * 100000);
    for (i = 0; i < 100000; i++) {
      uint64_t a, b;
      _mm_lfence();
      a = __rdtsc();
      _mm_lfence();
      _mm_lfence();
      b = __rdtsc();
      _mm_lfence();
      emp[i] = (double)(b - a);
    }
    qsort(emp, 100000, sizeof *emp, cmp_double);
    overhead_ticks = emp[50000];
    free(emp);
  }
  for (p = 0; p < passes; p++) {
    for (f = 0; f < 2; f++) {
      for (i = 0; i < n; i++) {
        ts_result o;
        uint64_t a, b;
        _mm_lfence();
        a = __rdtsc();
        _mm_lfence();
        fns[f](&recs[i].cur, &recs[i].hist, &recs[i].ctx, &o);
        _mm_lfence();
        b = __rdtsc();
        _mm_lfence();
        g_sink += o.trust_score;
        call_s[f][ncall[f]++] = ((double)(b - a) - overhead_ticks) * tsc_ns;
      }
    }
  }
#endif
  printf("{\"mode\":\"bench\",");
  print_platform_json();
  printf(",\"traces\":%zu,\"passes\":%d,\"chunk\":%d,\"timer_ns_per_tick\":%.4f,", n, passes, chunk,
         qns);
  fprintf(stderr, "bench: %zu dev traces, %d passes, chunk %d, timer tick %.2f ns\n", n, passes,
          chunk, qns);
  printf("\"chunked\":{");
  for (f = 0; f < 2; f++) print_stats(names[f], chunk_s[f], nch[f], f == 1);
  printf("},\"throughput_mean_ns\":{\"V2_full\":%.2f,\"V2r_full\":%.2f}", total_ns[0] / calls[0],
         total_ns[1] / calls[1]);
#ifdef HAVE_RDTSC
  printf(",\"tsc_ns_per_tick\":%.5f,\"rdtsc_overhead_ticks\":%.1f,\"single_call_rdtsc\":{", tsc_ns,
         overhead_ticks);
  fprintf(stderr, "single-call (rdtsc, overhead %.0f ticks subtracted):\n", overhead_ticks);
  for (f = 0; f < 2; f++) print_stats(names[f], call_s[f], ncall[f], f == 1);
  printf("}");
#endif
  printf(",\"checksum\":%.6f}\n", (double)g_sink);
  for (f = 0; f < 2; f++) {
    free(chunk_s[f]);
    free(call_s[f]);
  }
  free(recs);
  return 0;
}

/* ------------------------------------------------------------------ */
/* ops                                                                 */
/* ------------------------------------------------------------------ */

#ifdef TS_COUNT_OPS
#define NOPS 11
static uint64_t op_get(const ts_opcount *o, int j) {
  const uint64_t v[NOPS] = {o->add, o->mul, o->div, o->cmp, o->cvt, o->sqrt_,
                            o->sin_, o->cos_, o->atan2_, o->floor_, o->distance};
  return v[j];
}
static const char *OP_NAMES[NOPS] = {"add", "mul", "div", "cmp", "cvt", "sqrt",
                                     "sin", "cos", "atan2", "floor", "distance"};

static int cmd_ops(int nfiles, char **files) {
  size_t n, i;
  rec_t *recs = load(nfiles, files, &n);
  int c, j;
  printf("{\"mode\":\"ops\",\"traces\":%zu,\"configs\":{", n);
  for (c = 0; c < NCFG; c++) {
    uint64_t mn[NOPS], mx[NOPS], sum[NOPS];
    for (j = 0; j < NOPS; j++) {
      mn[j] = UINT64_MAX;
      mx[j] = 0;
      sum[j] = 0;
    }
    for (i = 0; i < n; i++) {
      ts_result o;
      ts_ops_reset();
      run_cfg(c, &recs[i], &o);
      for (j = 0; j < NOPS; j++) {
        const uint64_t v = op_get(&ts_ops, j);
        if (v < mn[j]) mn[j] = v;
        if (v > mx[j]) mx[j] = v;
        sum[j] += v;
      }
    }
    printf("%s\"%s\":{", c ? "," : "", CFG_NAMES[c]);
    fprintf(stderr, "%-14s", CFG_NAMES[c]);
    for (j = 0; j < NOPS; j++) {
      printf("%s\"%s\":{\"mean\":%.3f,\"min\":%" PRIu64 ",\"max\":%" PRIu64 "}", j ? "," : "",
             OP_NAMES[j], (double)sum[j] / (double)n, mn[j], mx[j]);
      fprintf(stderr, " %s=%.1f[%" PRIu64 "-%" PRIu64 "]", OP_NAMES[j], (double)sum[j] / (double)n,
              mn[j], mx[j]);
    }
    printf("}");
    fprintf(stderr, "\n");
  }
  printf("}}\n");
  free(recs);
  return 0;
}
#endif

/* ------------------------------------------------------------------ */

static int cmd_sizes(void) {
  printf("{\"mode\":\"sizes\",");
  print_platform_json();
  printf(",\"sizeof\":{\"ts_point\":%zu,\"ts_history\":%zu,\"ts_network_hint\":%zu,"
         "\"ts_context\":%zu,\"ts_result\":%zu}}\n",
         sizeof(ts_point), sizeof(ts_history), sizeof(ts_network_hint), sizeof(ts_context),
         sizeof(ts_result));
  fprintf(stderr, "ts_point %zu, ts_history %zu, ts_context %zu, ts_result %zu bytes\n",
          sizeof(ts_point), sizeof(ts_history), sizeof(ts_context), sizeof(ts_result));
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 3 && strcmp(argv[1], "verify") == 0) return cmd_verify(argc - 2, argv + 2);
  if (argc >= 3 && strcmp(argv[1], "bench") == 0)
    return cmd_bench(argv[2], argc > 3 ? atoi(argv[3]) : 30, argc > 4 ? atoi(argv[4]) : 32);
#ifdef TS_COUNT_OPS
  if (argc >= 3 && strcmp(argv[1], "ops") == 0) return cmd_ops(argc - 2, argv + 2);
#endif
  if (argc >= 2 && strcmp(argv[1], "sizes") == 0) return cmd_sizes();
  fprintf(stderr,
          "usage: %s verify <inputs.txt>... | bench <inputs-dev.txt> [passes] [chunk] | "
          "ops <inputs.txt>... | sizes\n",
          argv[0]);
  return 2;
}
