pragma circom 2.1.0;

/**
 * Zairn-ZKP circuit.
 *
 * This circuit hardens the original proximity statement by:
 *   1. turning signed lat/lon deltas into bounded non-negative differences,
 *   2. constraining division witnesses used for longitude correction, and
 *   3. using explicit less-than / less-than-or-equal checks for the final
 *      distance comparison.
 *
 * Public statement binding inputs (`contextDigest`, `epoch`,
 * `challengeDigest`) keep the proof bound to a specific drop/session.
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

template ZairnZkp() {
    var SCALE = 1000000;
    var LAT_SHIFT = 90000000;
    var LON_SHIFT = 180000000;

    // Public inputs
    signal input targetLat;
    signal input targetLon;
    signal input radiusSquared;
    signal input cosLatScaled;
    signal input contextDigest;
    signal input epoch;
    signal input challengeDigest;

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

    // Constrain quotient + remainder and bound the remainder.
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

    // Bound the final comparison explicitly.
    component distBits = Num2BitsBounded(64);
    component radiusBits = Num2BitsBounded(64);
    distBits.in <== distSquared;
    radiusBits.in <== radiusSquared;

    component within = LessEqThan(64);
    within.in[0] <== distSquared;
    within.in[1] <== radiusSquared;

    // Bind context signals into the constraint system.
    // Public inputs are already part of the Groth16 verification equation,
    // but adding an explicit constraint prevents any compiler from
    // optimising them away and makes the binding auditable in the R1CS.
    signal contextBound;
    contextBound <== contextDigest + epoch + challengeDigest;

    signal output valid;
    valid <== within.out;
    valid === 1;
}

component main {public [targetLat, targetLon, radiusSquared, cosLatScaled, contextDigest, epoch, challengeDigest]} = ZairnZkp();
