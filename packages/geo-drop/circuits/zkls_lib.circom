pragma circom 2.1.0;

/**
 * ZKLS shared library
 * Reusable templates for Zero-Knowledge Location State circuits.
 * Extracted from zairn_zkp.circom to avoid duplication.
 */

template Num2BitsBounded(n) {
    signal input in;
    signal output out[n];
    var lc = 0;
    for (var i = 0; i < n; i++) {
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

template GreaterThan(n) {
    signal input in[2];
    signal output out;
    component lt = LessThan(n);
    lt.in[0] <== in[1];
    lt.in[1] <== in[0];
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
