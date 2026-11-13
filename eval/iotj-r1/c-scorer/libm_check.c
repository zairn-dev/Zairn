/*
 * libm_check <libm-calls.txt>: recompute the libm calls exported by
 * libm-check.mjs with this platform's libm and count results that differ from
 * V8's, per function. Prints JSON to stdout, a summary to stderr.
 */
#include <inttypes.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static double hexd(const char *s) {
  uint64_t u = (uint64_t)strtoull(s, 0, 16);
  double d;
  memcpy(&d, &u, sizeof d);
  return d;
}

static uint64_t ulps(double a, double b) {
  int64_t x, y;
  memcpy(&x, &a, sizeof x);
  memcpy(&y, &b, sizeof y);
  return x > y ? (uint64_t)(x - y) : (uint64_t)(y - x);
}

int main(int argc, char **argv) {
  static const char *names[4] = {"sin", "cos", "sqrt", "atan2"};
  long total[4] = {0}, diff[4] = {0};
  uint64_t max_ulp[4] = {0};
  char line[256], fn[16], a1[32], a2[32], a3[32];
  FILE *f;
  int k;
  if (argc < 2 || !(f = fopen(argv[1], "r"))) {
    fprintf(stderr, "usage: %s libm-calls.txt\n", argv[0]);
    return 2;
  }
  while (fgets(line, sizeof line, f)) {
    int n = sscanf(line, "%15s %31s %31s %31s", fn, a1, a2, a3);
    double expect, got;
    for (k = 0; k < 4; k++)
      if (strcmp(fn, names[k]) == 0) break;
    if (k == 4) continue;
    if (k == 3) {
      if (n != 4) continue;
      got = atan2(hexd(a1), hexd(a2));
      expect = hexd(a3);
    } else {
      if (n != 3) continue;
      got = k == 0 ? sin(hexd(a1)) : k == 1 ? cos(hexd(a1)) : sqrt(hexd(a1));
      expect = hexd(a2);
    }
    total[k]++;
    if (memcmp(&got, &expect, sizeof got) != 0) {
      const uint64_t u = ulps(got, expect);
      diff[k]++;
      if (u > max_ulp[k]) max_ulp[k] = u;
    }
  }
  fclose(f);
  printf("{");
  for (k = 0; k < 4; k++) {
    printf("%s\"%s\":{\"calls\":%ld,\"differFromV8\":%ld,\"maxUlp\":%" PRIu64 "}", k ? "," : "",
           names[k], total[k], diff[k], max_ulp[k]);
    fprintf(stderr, "%-5s %8ld distinct calls, %6ld differ from V8 (max %" PRIu64 " ulp)\n",
            names[k], total[k], diff[k], max_ulp[k]);
  }
  printf("}\n");
  return 0;
}
