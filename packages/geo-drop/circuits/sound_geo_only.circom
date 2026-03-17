pragma circom 2.1.0;

/**
 * Sound Geo-Only Circuit (V2-fixed baseline without context binding).
 *
 * This circuit has the same hardened arithmetic as Zairn-ZKP
 * (bounded comparisons, AbsDiff, constrained division) but does NOT
 * include context-binding public inputs (contextDigest, epoch,
 * challengeDigest). It serves as an evaluation baseline to isolate
 * the overhead of V2 fixes from the overhead of context binding.
 */

template Num2BitsBounded(n) {
    signal input in;
    signal output out[n];

    var lc = 0;
    var i;
    for (i = 0; i < n; i++) {
        out[i] <-- (in >> i) & 1;
        out[i] * (out[i] - 1) === 0;
        lc += out[i] * (1 << i);
    }
    lc === in;
}

template LessThan(n) {
    signal input in[2];
    signal output out;

    component bits = Num2BitsBounded(n + 1);
    bits.in <== in[0] + (1 << n) - in[1];
    out <== 1 - bits.out[n];
}

template LessEqThan(n) {
    signal input in[2];
    signal output out;

    component lt = LessThan(n + 1);
    lt.in[0] <== in[0];
    lt.in[1] <== in[1] + 1;
    out <== lt.out;
}

template AbsDiff(n) {
    signal input a;
    signal input b;
    signal output diff;

    component lt = LessThan(n);
    lt.in[0] <== a;
    lt.in[1] <== b;

    signal deltaAB;
    signal deltaBA;
    signal chooseAB;
    signal chooseBA;

    deltaAB <== a - b;
    deltaBA <== b - a;
    chooseBA <== lt.out * deltaBA;
    chooseAB <== (1 - lt.out) * deltaAB;
    diff <== chooseBA + chooseAB;
}

template SoundGeoOnly() {
    var SCALE = 1000000;
    var LAT_SHIFT = 90000000;
    var LON_SHIFT = 180000000;

    // Public inputs (geometry only — no context binding)
    signal input targetLat;
    signal input targetLon;
    signal input radiusSquared;
    signal input cosLatScaled;

    // Private inputs
    signal input userLat;
    signal input userLon;

    // Shift into bounded non-negative domains.
    signal targetLatShifted;
    signal targetLonShifted;
    signal userLatShifted;
    signal userLonShifted;

    targetLatShifted <== targetLat + LAT_SHIFT;
    targetLonShifted <== targetLon + LON_SHIFT;
    userLatShifted <== userLat + LAT_SHIFT;
    userLonShifted <== userLon + LON_SHIFT;

    component latBitsTarget = Num2BitsBounded(28);
    component latBitsUser = Num2BitsBounded(28);
    component lonBitsTarget = Num2BitsBounded(29);
    component lonBitsUser = Num2BitsBounded(29);

    latBitsTarget.in <== targetLatShifted;
    latBitsUser.in <== userLatShifted;
    lonBitsTarget.in <== targetLonShifted;
    lonBitsUser.in <== userLonShifted;

    component dLatAbs = AbsDiff(29);
    component dLonAbsRaw = AbsDiff(30);
    dLatAbs.a <== userLatShifted;
    dLatAbs.b <== targetLatShifted;
    dLonAbsRaw.a <== userLonShifted;
    dLonAbsRaw.b <== targetLonShifted;

    signal dLonCorrected;
    signal dLon;
    signal dLonRemainder;
    signal dLatSq;
    signal dLonSq;
    signal distSquared;

    dLonCorrected <== dLonAbsRaw.diff * cosLatScaled;
    dLon <-- dLonCorrected \ SCALE;
    dLonRemainder <-- dLonCorrected % SCALE;

    dLon * SCALE + dLonRemainder === dLonCorrected;

    component dLonRemainderBits = Num2BitsBounded(20);
    dLonRemainderBits.in <== dLonRemainder;

    component remLt = LessThan(20);
    remLt.in[0] <== dLonRemainder;
    remLt.in[1] <== SCALE;
    remLt.out === 1;

    dLatSq <== dLatAbs.diff * dLatAbs.diff;
    dLonSq <== dLon * dLon;
    distSquared <== dLatSq + dLonSq;

    component distBits = Num2BitsBounded(64);
    component radiusBits = Num2BitsBounded(64);
    distBits.in <== distSquared;
    radiusBits.in <== radiusSquared;

    component within = LessEqThan(64);
    within.in[0] <== distSquared;
    within.in[1] <== radiusSquared;

    signal output valid;
    valid <== within.out;
    valid === 1;
}

component main {public [targetLat, targetLon, radiusSquared, cosLatScaled]} = SoundGeoOnly();
