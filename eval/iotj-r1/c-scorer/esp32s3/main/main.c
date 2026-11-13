/*
 * The C trust scorer on an ESP32-S3 (M5Stack CoreS3 in a Stack-chan, Xtensa
 * LX7 at 240 MHz, single-precision FPU only, so every double operation is a
 * libgcc soft-float call and libm is newlib).
 *
 * Reads the records that pack-inputs.mjs wrote to the "tsdata" partition and
 *   1. verify: runs the 10 configurations of ts_driver verify and compares
 *      every trust score, signal and signal mask with the JS values;
 *   2. bench:  times single V1, V2 and V2' (full context) calls with the
 *      CCOUNT cycle counter, interrupts masked around each call, over three
 *      passes of all traces. Records are parsed into RAM in batches before a
 *      batch is timed, so flash reads stay outside the timed region.
 * Each run starts when the host sends 'g' and ends with one JSON object
 * between "=== TS-BEGIN" and "=== TS-END" on the USB-Serial/JTAG console
 * (run.py sends the 'g' and collects the object).
 */
#include <inttypes.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp_cpu.h"
#include "esp_partition.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include "trust_scorer.h"

#define NCFG 10
#define HDR_SIZE 32
#define REC_SIZE 696
#define BATCH 64
#define PASSES 3

static const char *CFG_NAMES[NCFG] = {"V1",       "V2/both",   "V2/fixes", "V2/net",   "V2/none",
                                      "V2r/both", "V2r/fixes", "V2r/net",  "V2r/none", "V2r/both/cut2"};
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

static const esp_partition_t *g_part;
static uint32_t g_count, g_split;
static uint8_t g_raw[BATCH * REC_SIZE];
static rec_t g_recs[BATCH];
static uint32_t *g_samples;
static volatile double g_sink;

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

static double rd_f64(const uint8_t *p) {
  double d;
  memcpy(&d, p, sizeof d);
  return d;
}

static int64_t rd_i64(const uint8_t *p) {
  int64_t v;
  memcpy(&v, p, sizeof v);
  return v;
}

static void rd_point(const uint8_t *p, ts_point *pt) {
  pt->lat = rd_f64(p);
  pt->lon = rd_f64(p + 8);
  pt->accuracy = rd_f64(p + 16);
  pt->t_ms = rd_i64(p + 24);
}

static void parse(const uint8_t *b, rec_t *r) {
  uint32_t i;
  int c;
  memset(r, 0, sizeof *r);
  ts_context_init(&r->ctx);
  r->ctx.acc_cutoff = 0.0; /* "not given" -> default, as in ts_driver */
  rd_point(b, &r->cur);
  r->hist.n = b[672] <= TS_MAX_HISTORY ? b[672] : TS_MAX_HISTORY;
  for (i = 0; i < r->hist.n; i++) rd_point(b + 32 + 32 * i, &r->hist.pts[i]);
  r->ctx.n_fixes = b[673] <= TS_MAX_FIXES ? b[673] : TS_MAX_FIXES;
  for (i = 0; i < r->ctx.n_fixes; i++) rd_point(b + 352 + 32 * i, &r->ctx.fixes[i]);
  r->ctx.has_network = b[674];
  if (r->ctx.has_network) {
    r->ctx.network.lat = rd_f64(b + 512);
    r->ctx.network.lon = rd_f64(b + 520);
    r->ctx.network.accuracy = rd_f64(b + 528);
  }
  for (c = 0; c < 7; c++) r->sig[c] = rd_f64(b + 536 + 8 * c);
  r->sig_present = b[675];
  r->split = b[676];
  r->scen = b[677];
  r->label = b[678];
  for (c = 0; c < NCFG; c++) {
    r->score[c] = rd_f64(b + 592 + 8 * c);
    r->mask[c] = b[680 + c];
  }
}

/* Parse records [first, first + n) into g_recs. */
static void load_batch(uint32_t first, uint32_t n) {
  uint32_t j;
  ESP_ERROR_CHECK(esp_partition_read(g_part, HDR_SIZE + (size_t)first * REC_SIZE, g_raw,
                                     (size_t)n * REC_SIZE));
  for (j = 0; j < n; j++) parse(g_raw + (size_t)j * REC_SIZE, &g_recs[j]);
}

/* ------------------------------------------------------------------ */
/* verify (as ts_driver verify, without the counterfactual sums)       */
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

static uint64_t ulps(double a, double b) {
  int64_t x, y;
  memcpy(&x, &a, sizeof x);
  memcpy(&y, &b, sizeof y);
  return x > y ? (uint64_t)(x - y) : (uint64_t)(y - x);
}

static double tie_distance(double raw) {
  const double x = raw * 100.0;
  return fabs(x - (floor(x) + 0.5));
}

static void expected_sig(int cfg, int *ia, int *i_f) {
  const int revised = cfg >= 5;
  *ia = (revised && cfg != 9) ? SIG_A1 : SIG_A2;
  *i_f = revised ? SIG_FR : SIG_F;
}

static long score_ok[NCFG], sig_ok[NCFG], mask_ok[NCFG], near_tie[NCFG];
static double min_tie_mis[NCFG];
static long sig_field_bad[7], null_ctx_bad, mismatches_shown;
static uint64_t sig_max_ulp[7];
static double sig_max_abs[7];
static char mismatch_text[2048];

static void verify_one(const rec_t *r, uint32_t index) {
  int c;
#define CHECK_SIG(val, idx)                                \
  do {                                                     \
    if (!same_bits((val), r->sig[(idx)])) {                \
      const uint64_t u = ulps((val), r->sig[(idx)]);       \
      const double d = fabs((val) - r->sig[(idx)]);        \
      sig_good = 0;                                        \
      sig_field_bad[(idx)]++;                              \
      if (u > sig_max_ulp[(idx)]) sig_max_ulp[(idx)] = u;  \
      if (d > sig_max_abs[(idx)]) sig_max_abs[(idx)] = d;  \
    }                                                      \
  } while (0)
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
    if (!sig_good && tie_distance(o.raw) < min_tie_mis[c]) min_tie_mis[c] = tie_distance(o.raw);
    if (same_bits(o.trust_score, r->score[c])) {
      score_ok[c]++;
    } else if (mismatches_shown < 10) {
      const size_t len = strlen(mismatch_text);
      mismatches_shown++;
      snprintf(mismatch_text + len, sizeof mismatch_text - len,
               "%s{\"config\":\"%s\",\"record\":%" PRIu32 ",\"js\":%.17g,\"c\":%.17g,\"raw\":%.17g}",
               len ? "," : "", CFG_NAMES[c], index, r->score[c], o.trust_score, o.raw);
    }
  }
#undef CHECK_SIG
  {
    ts_result a, b;
    ts_score_v2(&r->cur, &r->hist, 0, &a);
    ts_score_v2r(&r->cur, &r->hist, 0, &b);
    if (!same_bits(a.trust_score, r->score[4]) || !same_bits(b.trust_score, r->score[8])) null_ctx_bad++;
  }
}

static int64_t verify_all(void) {
  const int64_t t0 = esp_timer_get_time();
  uint32_t first, j;
  int c;
  memset(score_ok, 0, sizeof score_ok);
  memset(sig_ok, 0, sizeof sig_ok);
  memset(mask_ok, 0, sizeof mask_ok);
  memset(near_tie, 0, sizeof near_tie);
  memset(sig_field_bad, 0, sizeof sig_field_bad);
  memset(sig_max_ulp, 0, sizeof sig_max_ulp);
  memset(sig_max_abs, 0, sizeof sig_max_abs);
  null_ctx_bad = 0;
  mismatches_shown = 0;
  mismatch_text[0] = '\0';
  for (c = 0; c < NCFG; c++) min_tie_mis[c] = INFINITY;
  for (first = 0; first < g_count; first += BATCH) {
    const uint32_t n = g_count - first < BATCH ? g_count - first : BATCH;
    load_batch(first, n);
    for (j = 0; j < n; j++) verify_one(&g_recs[j], first + j);
    if ((first / BATCH) % 32 == 31)
      printf("ts-bench: verify %" PRIu32 "/%" PRIu32 ", %.1f s\n", first + n, g_count,
             (esp_timer_get_time() - t0) * 1e-6);
    vTaskDelay(1);
  }
  return esp_timer_get_time() - t0;
}

/* ------------------------------------------------------------------ */
/* bench                                                               */
/* ------------------------------------------------------------------ */

enum { B_V1, B_V2, B_V2R, NBENCH };
static const char *BENCH_NAMES[NBENCH] = {"V1", "V2", "V2r"};

static int cmp_u32(const void *a, const void *b) {
  const uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b;
  return (x > y) - (x < y);
}

static uint32_t nearest_rank(const uint32_t *s, uint32_t n, double p) {
  uint32_t k = (uint32_t)ceil(p / 100.0 * (double)n);
  if (k < 1) k = 1;
  if (k > n) k = n;
  return s[k - 1];
}

/* Median cycles of an empty CCOUNT pair, subtracted from every sample. */
static uint32_t ccount_overhead(void) {
  uint32_t s[101], i;
  for (i = 0; i < 101; i++) {
    uint32_t t0, t1;
    portDISABLE_INTERRUPTS();
    t0 = esp_cpu_get_cycle_count();
    t1 = esp_cpu_get_cycle_count();
    portENABLE_INTERRUPTS();
    s[i] = t1 - t0;
  }
  qsort(s, 101, sizeof s[0], cmp_u32);
  return s[50];
}

/* Measured CPU clock in Hz: CCOUNT against the 1 MHz esp_timer over 200 ms. */
static double cpu_hz(void) {
  const int64_t t0 = esp_timer_get_time();
  const uint32_t c0 = esp_cpu_get_cycle_count();
  while (esp_timer_get_time() - t0 < 200000) {
  }
  {
    const uint32_t c1 = esp_cpu_get_cycle_count();
    const int64_t t1 = esp_timer_get_time();
    return (double)(uint32_t)(c1 - c0) / ((double)(t1 - t0) * 1e-6);
  }
}

static void bench_pass(int which, uint32_t overhead) {
  uint32_t first, j;
  for (first = 0; first < g_count; first += BATCH) {
    const uint32_t n = g_count - first < BATCH ? g_count - first : BATCH;
    load_batch(first, n);
    for (j = 0; j < n; j++) {
      const rec_t *r = &g_recs[j];
      ts_result o;
      uint32_t t0, t1;
      portDISABLE_INTERRUPTS();
      t0 = esp_cpu_get_cycle_count();
      switch (which) {
        case B_V1: ts_score_v1(&r->cur, &r->hist, &o); break;
        case B_V2: ts_score_v2(&r->cur, &r->hist, &r->ctx, &o); break;
        default: ts_score_v2r(&r->cur, &r->hist, &r->ctx, &o); break;
      }
      t1 = esp_cpu_get_cycle_count();
      portENABLE_INTERRUPTS();
      g_samples[first + j] = (t1 - t0) - overhead;
      g_sink = o.trust_score;
    }
    vTaskDelay(1);
  }
}

typedef struct {
  uint32_t median, p99, p999, min, max;
  double mean;
} pass_stats;

static pass_stats g_stats[NBENCH][PASSES];

static void pass_summary(uint32_t *s, uint32_t n, pass_stats *out) {
  uint64_t sum = 0;
  uint32_t i;
  qsort(s, n, sizeof s[0], cmp_u32);
  for (i = 0; i < n; i++) sum += s[i];
  out->median = nearest_rank(s, n, 50);
  out->p99 = nearest_rank(s, n, 99);
  out->p999 = nearest_rank(s, n, 99.9);
  out->min = s[0];
  out->max = s[n - 1];
  out->mean = (double)sum / n;
}

static void print_pass_stats(const pass_stats *p, uint32_t n, double hz, int last) {
  printf("{\"samples\":%" PRIu32 ",\"median_cycles\":%" PRIu32 ",\"p99_cycles\":%" PRIu32
         ",\"p999_cycles\":%" PRIu32 ",\"mean_cycles\":%.1f,\"min_cycles\":%" PRIu32
         ",\"max_cycles\":%" PRIu32 ",\"median_us\":%.2f,\"p99_us\":%.2f,\"mean_us\":%.2f}%s",
         n, p->median, p->p99, p->p999, p->mean, p->min, p->max, p->median / hz * 1e6,
         p->p99 / hz * 1e6, p->mean / hz * 1e6, last ? "" : ",");
}

/* ------------------------------------------------------------------ */

static void run_once(void) {
  const double hz = cpu_hz();
  const uint32_t overhead = ccount_overhead();
  int64_t verify_us;
  int c, b, p;
  printf("ts-bench: verify, %" PRIu32 " traces x %d configs\n", g_count, NCFG);
  verify_us = verify_all();
  printf("ts-bench: verify done in %.1f s\n", verify_us * 1e-6);
  for (b = 0; b < NBENCH; b++)
    for (p = 0; p < PASSES; p++) {
      const int64_t t0 = esp_timer_get_time();
      bench_pass(b, overhead);
      pass_summary(g_samples, g_count, &g_stats[b][p]);
      printf("ts-bench: bench %s pass %d, median %" PRIu32 " cycles, %.1f s\n", BENCH_NAMES[b], p + 1,
             g_stats[b][p].median, (esp_timer_get_time() - t0) * 1e-6);
    }
  printf("=== TS-BEGIN\n");
  printf("{\"mode\":\"esp32s3\",\"platform\":{\"chip\":\"ESP32-S3\",\"board\":\"M5Stack CoreS3 (Stack-chan)\","
         "\"compiler\":\"gcc %s\",\"idf\":\"%s\",\"cpu_mhz_config\":%d,\"cpu_hz_measured\":%.0f,"
         "\"icache_kb\":%d,\"optimization\":\"%s\",\"ccount_overhead_cycles\":%" PRIu32 "},",
         __VERSION__, IDF_VER, CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ, hz,
         CONFIG_ESP32S3_INSTRUCTION_CACHE_SIZE / 1024,
#if defined(CONFIG_COMPILER_OPTIMIZATION_PERF)
         "-O2",
#elif defined(CONFIG_COMPILER_OPTIMIZATION_SIZE)
         "-Os",
#else
         "other",
#endif
         overhead);
  printf("\"split\":%" PRIu32 ",\"traces\":%" PRIu32 ",\"verifySeconds\":%.1f,\"configs\":{", g_split,
         g_count, verify_us * 1e-6);
  for (c = 0; c < NCFG; c++)
    printf("%s\"%s\":{\"n\":%" PRIu32 ",\"scoreExact\":%ld,\"signalsBitExact\":%ld,\"maskEqual\":%ld,"
           "\"rawWithin1e-9OfRoundingTie\":%ld,\"minTieDistanceWhereSignalsDiffer\":%.3e}",
           c ? "," : "", CFG_NAMES[c], g_count, score_ok[c], sig_ok[c], mask_ok[c], near_tie[c],
           isinf(min_tie_mis[c]) ? -1.0 : min_tie_mis[c]);
  printf("},\"signalFieldMismatches\":{");
  for (c = 0; c < 7; c++)
    printf("%s\"%s\":{\"count\":%ld,\"maxUlp\":%" PRIu64 ",\"maxAbs\":%.3e}", c ? "," : "", SIG_NAMES[c],
           sig_field_bad[c], sig_max_ulp[c], sig_max_abs[c]);
  printf("},\"nullContextMismatches\":%ld,\"mismatches\":[%s],\"bench\":{", null_ctx_bad, mismatch_text);
  for (b = 0; b < NBENCH; b++) {
    printf("%s\"%s\":[", b ? "," : "", BENCH_NAMES[b]);
    for (p = 0; p < PASSES; p++) print_pass_stats(&g_stats[b][p], g_count, hz, p == PASSES - 1);
    printf("]");
  }
  printf("}}\n=== TS-END\n");
  fflush(stdout);
}

/* Waits for 'g' from the host before each run, so the host can open the port
 * first: a chip reset re-enumerates the USB device, and output written while
 * no host is attached is lost. */
void app_main(void) {
  uint8_t hdr[HDR_SIZE];
  usb_serial_jtag_driver_config_t ucfg = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&ucfg));
  usb_serial_jtag_vfs_use_driver();
  g_part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, 0x40, "tsdata");
  ESP_ERROR_CHECK(g_part ? ESP_OK : ESP_ERR_NOT_FOUND);
  ESP_ERROR_CHECK(esp_partition_read(g_part, 0, hdr, sizeof hdr));
  memcpy(&g_count, hdr + 8, 4);
  memcpy(&g_split, hdr + 16, 4);
  {
    uint32_t rec_size;
    memcpy(&rec_size, hdr + 12, 4);
    if (memcmp(hdr, "TSR1", 4) != 0 || rec_size != REC_SIZE ||
        HDR_SIZE + (size_t)g_count * REC_SIZE > g_part->size) {
      for (;;) {
        printf("ts-bench: tsdata partition holds no valid TSR1 records\n");
        vTaskDelay(pdMS_TO_TICKS(2000));
      }
    }
  }
  g_samples = (uint32_t *)malloc((size_t)g_count * sizeof *g_samples);
  ESP_ERROR_CHECK(g_samples ? ESP_OK : ESP_ERR_NO_MEM);
  for (;;) {
    uint8_t ch = 0;
    if (usb_serial_jtag_read_bytes(&ch, 1, pdMS_TO_TICKS(1000)) == 1 && ch == 'g') {
      run_once();
    } else if (usb_serial_jtag_is_connected()) {
      printf("ts-bench ready: split %" PRIu32 ", %" PRIu32 " traces; send 'g'\n", g_split, g_count);
    }
  }
}
