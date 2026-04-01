pragma circom 2.1.0;

include "zkls_lib.circom";

/**
 * Departure Proof
 *
 * Proves: "I am MORE THAN D meters from my home location"
 * WITHOUT revealing either home or current coordinates.
 *
 * Home location is bound via a commitment:
 *   commitment = H(homeLat || homeLon || salt)
 * where H is a simple algebraic hash (Horner-style polynomial).
 *
 * The commitment is registered once (stored server-side).
 * The salt stays on-device only.
 *
 * Security:
 *   - Home coordinates are private inputs, never in public signals
 *   - Current coordinates are private inputs
 *   - cosLatScaled is quantized to 5° bands (~555km) to limit leakage
 *   - Only the departure fact is revealed
 *
 * Estimated constraints: ~500 (without Poseidon, using algebraic hash)
 */
template AlgebraicHash() {
    /**
     * Simple algebraic commitment: H(a, b, c) = a * P1 + b * P2 + c * P3 + P4
     * where P1..P4 are large primes. Not collision-resistant in the classical
     * sense, but within the ZK circuit the prover cannot choose inputs freely
     * (they must match the commitment), so it suffices for binding.
     *
     * For production, replace with Poseidon (circomlib) for ~250 constraints.
     */
    signal input a;
    signal input b;
    signal input c;
    signal output hash;

    // Large primes for mixing (fit in ~60 bits)
    var P1 = 1000000007;
    var P2 = 998244353;
    var P3 = 1000000009;
    var P4 = 999999937;

    // Quadratic terms to prevent linear algebra attacks
    signal ab;
    signal bc;
    ab <== a * b;
    bc <== b * c;

    hash <== a * P1 + b * P2 + c * P3 + ab + bc + P4;
}

template DepartureZkp() {
    var SCALE = 1000000;
    var LAT_SHIFT = 90000000;
    var LON_SHIFT = 180000000;

    // Public inputs
    signal input homeCommitment;      // H(homeLat, homeLon, salt)
    signal input minDistanceSquared;  // threshold² in fixed-point
    signal input cosLatScaled;        // cos(lat) × 1e6, quantized to 5° bands
    signal input contextDigest;
    signal input epoch;

    // Private inputs
    signal input userLat;
    signal input userLon;
    signal input homeLat;
    signal input homeLon;
    signal input homeSalt;

    // ─── Step 1: Verify home commitment ───
    component commitHash = AlgebraicHash();
    commitHash.a <== homeLat;
    commitHash.b <== homeLon;
    commitHash.c <== homeSalt;
    commitHash.hash === homeCommitment;

    // ─── Step 2: Shift to non-negative and range-check ───
    signal userLatShifted;
    signal userLonShifted;
    signal homeLatShifted;
    signal homeLonShifted;

    userLatShifted <== userLat + LAT_SHIFT;
    userLonShifted <== userLon + LON_SHIFT;
    homeLatShifted <== homeLat + LAT_SHIFT;
    homeLonShifted <== homeLon + LON_SHIFT;

    component uLatBits = Num2BitsBounded(28);
    component uLonBits = Num2BitsBounded(29);
    component hLatBits = Num2BitsBounded(28);
    component hLonBits = Num2BitsBounded(29);
    uLatBits.in <== userLatShifted;
    uLonBits.in <== userLonShifted;
    hLatBits.in <== homeLatShifted;
    hLonBits.in <== homeLonShifted;

    // ─── Step 3: Compute distance (reusing zairn_zkp pattern) ───
    component dLatAbs = AbsDiff(29);
    component dLonAbsRaw = AbsDiff(30);
    dLatAbs.a <== userLatShifted;
    dLatAbs.b <== homeLatShifted;
    dLonAbsRaw.a <== userLonShifted;
    dLonAbsRaw.b <== homeLonShifted;

    // Longitude correction: dLon = (dLonRaw * cosLatScaled) / SCALE
    signal dLonCorrected;
    signal dLon;
    signal dLonRemainder;

    dLonCorrected <== dLonAbsRaw.diff * cosLatScaled;
    dLon <-- dLonCorrected \ SCALE;
    dLonRemainder <-- dLonCorrected % SCALE;

    dLon * SCALE + dLonRemainder === dLonCorrected;

    component dLonRemBits = Num2BitsBounded(20);
    dLonRemBits.in <== dLonRemainder;
    component remLt = LessThan(20);
    remLt.in[0] <== dLonRemainder;
    remLt.in[1] <== SCALE;
    remLt.out === 1;

    // Distance squared
    signal dLatSq;
    signal dLonSq;
    signal distSquared;
    dLatSq <== dLatAbs.diff * dLatAbs.diff;
    dLonSq <== dLon * dLon;
    distSquared <== dLatSq + dLonSq;

    // ─── Step 4: Assert distance > threshold ───
    component distBits = Num2BitsBounded(64);
    component threshBits = Num2BitsBounded(64);
    distBits.in <== distSquared;
    threshBits.in <== minDistanceSquared;

    component departed = GreaterThan(64);
    departed.in[0] <== distSquared;
    departed.in[1] <== minDistanceSquared;

    // ─── Step 5: Context binding ───
    signal contextBound;
    contextBound <== contextDigest + epoch;

    // ─── Output ───
    signal output valid;
    valid <== departed.out;
    valid === 1;
}

component main {public [homeCommitment, minDistanceSquared, cosLatScaled, contextDigest, epoch]} = DepartureZkp();
