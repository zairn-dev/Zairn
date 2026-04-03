pragma circom 2.1.0;

include "zkls_lib.circom";
include "../node_modules/circomlib/circuits/poseidon.circom";

/**
 * Combined ZKLS Proof: Grid Membership + Departure in one proof
 *
 * Proves simultaneously:
 *   1. "I am in grid cell (cellRow, cellCol)" — presence awareness
 *   2. "I am more than D meters from my home" — departure status
 *
 * Benefits of composition:
 *   - Single proof instead of two → lower verification cost
 *   - Coordinates are shared between statements → enforced consistency
 *     (user cannot claim to be in cell A for grid but use coords from
 *     cell B for departure)
 *   - Home commitment uses Poseidon for production security
 *
 * The combined circuit shares private inputs (userLat, userLon)
 * between both sub-statements, preventing split-identity attacks.
 */
template ZklsCombined() {
    var SCALE = 1000000;
    var LAT_SHIFT = 90000000;
    var LON_SHIFT = 180000000;

    // ══════════════════════════════════════
    // Public inputs — Grid Membership
    // ══════════════════════════════════════
    signal input cellRow;
    signal input cellCol;
    signal input gridSizeFp;
    signal input gridOffsetLatFp;
    signal input gridOffsetLonFp;

    // ══════════════════════════════════════
    // Public inputs — Departure
    // ══════════════════════════════════════
    signal input homeCommitment;
    signal input minDistanceSquared;
    signal input cosLatScaled;

    // ══════════════════════════════════════
    // Public inputs — Shared context
    // ══════════════════════════════════════
    signal input contextDigest;
    signal input epoch;

    // ══════════════════════════════════════
    // Private inputs (SHARED between both statements)
    // ══════════════════════════════════════
    signal input userLat;
    signal input userLon;
    signal input homeLat;
    signal input homeLon;
    signal input homeSalt;

    // ══════════════════════════════════════
    // Step 1: Range check user coordinates (shared)
    // ══════════════════════════════════════
    signal userLatShifted;
    signal userLonShifted;
    userLatShifted <== userLat + LAT_SHIFT;
    userLonShifted <== userLon + LON_SHIFT;

    component uLatBits = Num2BitsBounded(28);
    component uLonBits = Num2BitsBounded(29);
    uLatBits.in <== userLatShifted;
    uLonBits.in <== userLonShifted;

    // ══════════════════════════════════════
    // Part A: Grid Membership
    // ══════════════════════════════════════
    signal adjustedLat;
    signal adjustedLon;
    adjustedLat <== userLatShifted + gridOffsetLatFp;
    adjustedLon <== userLonShifted + gridOffsetLonFp;

    // Verify cell assignment: floor(adjusted / gridSize) == cellRow/cellCol
    // remainder = adjusted - cell * gridSize
    signal remLat;
    signal remLon;
    remLat <== adjustedLat - cellRow * gridSizeFp;
    remLon <== adjustedLon - cellCol * gridSizeFp;

    // remainder must be in [0, gridSize)
    component remLatBits = Num2BitsBounded(28);
    component remLonBits = Num2BitsBounded(29);
    remLatBits.in <== remLat;
    remLonBits.in <== remLon;

    component remLatLt = LessThan(28);
    remLatLt.in[0] <== remLat;
    remLatLt.in[1] <== gridSizeFp;
    remLatLt.out === 1;

    component remLonLt = LessThan(29);
    remLonLt.in[0] <== remLon;
    remLonLt.in[1] <== gridSizeFp;
    remLonLt.out === 1;

    // ══════════════════════════════════════
    // Part B: Departure Proof (Poseidon commitment)
    // ══════════════════════════════════════

    // Verify home commitment
    component commitHash = Poseidon(3);
    commitHash.inputs[0] <== homeLat;
    commitHash.inputs[1] <== homeLon;
    commitHash.inputs[2] <== homeSalt;
    commitHash.out === homeCommitment;

    // Range check home coordinates
    signal homeLatShifted;
    signal homeLonShifted;
    homeLatShifted <== homeLat + LAT_SHIFT;
    homeLonShifted <== homeLon + LON_SHIFT;

    component hLatBits = Num2BitsBounded(28);
    component hLonBits = Num2BitsBounded(29);
    hLatBits.in <== homeLatShifted;
    hLonBits.in <== homeLonShifted;

    // Distance computation
    signal dLat;
    signal dLon;
    dLat <== userLat - homeLat;
    dLon <== userLon - homeLon;

    signal dLonScaled;
    dLonScaled <== dLon * cosLatScaled;

    signal dLatSq;
    signal dLonScaledSq;
    dLatSq <== dLat * dLat;
    dLonScaledSq <== dLonScaled * dLonScaled;

    signal distNumerator;
    distNumerator <== dLatSq * SCALE * SCALE + dLonScaledSq;

    signal thresholdScaled;
    thresholdScaled <== minDistanceSquared * SCALE * SCALE;

    signal diff;
    diff <== distNumerator - thresholdScaled - 1;

    component diffBits = Num2BitsBounded(60);
    diffBits.in <== diff;

    // ══════════════════════════════════════
    // Outputs
    // ══════════════════════════════════════
    signal output gridVerified;
    signal output departed;
    gridVerified <== 1;
    departed <== 1;
}

component main {public [
    cellRow, cellCol, gridSizeFp, gridOffsetLatFp, gridOffsetLonFp,
    homeCommitment, minDistanceSquared, cosLatScaled,
    contextDigest, epoch
]} = ZklsCombined();
