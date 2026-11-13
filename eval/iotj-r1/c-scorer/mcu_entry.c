/*
 * Minimal bare-metal entry used only to link the scorer for footprint
 * measurement on MCU toolchains (build.sh). It pulls in V2 and V2' with
 * --gc-sections so the linked image holds the scorer plus exactly the libm
 * and soft-float helpers it needs. Not meant to run.
 */
#include "trust_scorer.h"

ts_point g_cur;
ts_history g_hist;
ts_context g_ctx;
volatile double g_sink;

void app_entry(void) {
  ts_result r;
  ts_score_v2(&g_cur, &g_hist, &g_ctx, &r);
  g_sink = r.trust_score;
  ts_score_v2r(&g_cur, &g_hist, &g_ctx, &r);
  g_sink = r.trust_score;
  for (;;) {
  }
}
