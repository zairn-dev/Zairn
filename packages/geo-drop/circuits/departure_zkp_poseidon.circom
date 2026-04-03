pragma circom 2.1.0;

include "zkls_lib.circom";
include "../node_modules/circomlib/circuits/poseidon.circom";

/**
 * Departure Proof (Poseidon variant)
 *
 * Same semantics as departure_zkp.circom but uses Poseidon hash
 * for home commitment instead of the custom algebraic hash.
 *
 * Poseidon is a standard ZK-friendly hash function with:
 *   - Collision resistance in the ZK setting
 *   - Well-analyzed security (MiMC/Poseidon family)
 *   - Widely adopted in production ZK systems (Zcash, Tornado Cash)
 *
 * Tradeoff: ~240 constraints for Poseidon vs ~4 for algebraic hash,
 * but the departure circuit's total only increases from ~418 to ~650.
 *
 * Home commitment: Poseidon(homeLat, homeLon, salt)
 * The commitment is registered once (stored server-side).
 */
template DepartureZkpPoseidon() {
    var SCALE = 1000000;
    var LAT_SHIFT = 90000000;
    var LON_SHIFT = 180000000;

    // Public inputs
    signal input homeCommitment;      // Poseidon(homeLat, homeLon, salt)
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

    // ─── Step 1: Verify home commitment with Poseidon ───
    component commitHash = Poseidon(3);
    commitHash.inputs[0] <== homeLat;
    commitHash.inputs[1] <== homeLon;
    commitHash.inputs[2] <== homeSalt;
    commitHash.out === homeCommitment;

    // ─── Step 2: Range check all coordinates ───
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

    // ─── Step 3: Compute distance² with cos(lat) correction ───
    signal dLat;
    signal dLon;
    dLat <== userLat - homeLat;
    dLon <== userLon - homeLon;

    // cos(lat) correction for longitude
    signal dLonScaled;
    dLonScaled <== dLon * cosLatScaled;
    // dLonAdj = dLon * cosLat / SCALE (integer division approximation)
    // We compare dLat² + (dLon*cosLat/SCALE)² > minDistanceSquared
    // To avoid division: dLat²*SCALE² + dLon²*cosLat² > minDistanceSquared*SCALE²

    signal dLatSq;
    signal dLonScaledSq;
    dLatSq <== dLat * dLat;
    dLonScaledSq <== dLonScaled * dLonScaled;

    signal distNumerator;
    distNumerator <== dLatSq * SCALE * SCALE + dLonScaledSq;

    signal thresholdScaled;
    thresholdScaled <== minDistanceSquared * SCALE * SCALE;

    // ─── Step 4: Assert distance > threshold ───
    // distNumerator > thresholdScaled
    // Equivalent: distNumerator - thresholdScaled - 1 >= 0
    signal diff;
    diff <== distNumerator - thresholdScaled - 1;

    // Range check: diff must be non-negative (fits in 60 bits)
    component diffBits = Num2BitsBounded(60);
    diffBits.in <== diff;

    // Output: 1 (departed)
    signal output departed;
    departed <== 1;
}

component main {public [homeCommitment, minDistanceSquared, cosLatScaled, contextDigest, epoch]} = DepartureZkpPoseidon();
