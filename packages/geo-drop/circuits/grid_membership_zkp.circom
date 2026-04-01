pragma circom 2.1.0;

include "zkls_lib.circom";

/**
 * Grid Membership Proof
 *
 * Proves: "My coordinates (userLat, userLon) fall within grid cell
 *          (cellRow, cellCol) under the given grid parameters"
 *
 * WITHOUT revealing the exact position within the cell.
 *
 * The grid is defined by:
 *   - gridSizeFp: cell size in fixed-point latitude degrees (×1e6)
 *   - gridOffsetLatFp, gridOffsetLonFp: per-user offset (from gridSeed)
 *
 * Cell assignment:
 *   row = floor((userLat + LAT_SHIFT + gridOffsetLatFp) / gridSizeFp)
 *   col = floor((userLon + LON_SHIFT + gridOffsetLonFp) / gridSizeFp)
 *
 * Security:
 *   - Per-user grid offset prevents cross-user cell correlation
 *   - Context binding prevents proof replay
 *   - Within-cell position is information-theoretically hidden
 *     (any point in the cell produces the same public signals)
 *
 * Estimated constraints: ~350
 */
template GridMembershipZkp() {
    var LAT_SHIFT = 90000000;   // shift to non-negative (×1e6)
    var LON_SHIFT = 180000000;

    // Public inputs
    signal input cellRow;           // expected grid row
    signal input cellCol;           // expected grid column
    signal input gridSizeFp;        // cell size in fixed-point lat degrees
    signal input gridOffsetLatFp;   // per-user lat offset
    signal input gridOffsetLonFp;   // per-user lon offset
    signal input contextDigest;     // context binding (session/drop)
    signal input epoch;

    // Private inputs
    signal input userLat;           // user latitude (×1e6, signed)
    signal input userLon;           // user longitude (×1e6, signed)

    // ─── Step 1: Shift to non-negative and range-check ───
    signal userLatShifted;
    signal userLonShifted;
    userLatShifted <== userLat + LAT_SHIFT;
    userLonShifted <== userLon + LON_SHIFT;

    component latBits = Num2BitsBounded(28);
    component lonBits = Num2BitsBounded(29);
    latBits.in <== userLatShifted;
    lonBits.in <== userLonShifted;

    // ─── Step 2: Apply per-user grid offset ───
    signal adjustedLat;
    signal adjustedLon;
    adjustedLat <== userLatShifted + gridOffsetLatFp;
    adjustedLon <== userLonShifted + gridOffsetLonFp;

    // ─── Step 3: Integer division to compute cell indices ───
    // computedRow = adjustedLat \ gridSizeFp
    signal computedRow;
    signal latRemainder;
    computedRow <-- adjustedLat \ gridSizeFp;
    latRemainder <-- adjustedLat % gridSizeFp;

    // Constrain: computedRow * gridSizeFp + latRemainder === adjustedLat
    computedRow * gridSizeFp + latRemainder === adjustedLat;

    // Bound remainder: 0 <= latRemainder < gridSizeFp
    component latRemBits = Num2BitsBounded(28);
    latRemBits.in <== latRemainder;
    component latRemLt = LessThan(28);
    latRemLt.in[0] <== latRemainder;
    latRemLt.in[1] <== gridSizeFp;
    latRemLt.out === 1;

    // computedCol = adjustedLon \ gridSizeFp
    signal computedCol;
    signal lonRemainder;
    computedCol <-- adjustedLon \ gridSizeFp;
    lonRemainder <-- adjustedLon % gridSizeFp;

    computedCol * gridSizeFp + lonRemainder === adjustedLon;

    component lonRemBits = Num2BitsBounded(29);
    lonRemBits.in <== lonRemainder;
    component lonRemLt = LessThan(29);
    lonRemLt.in[0] <== lonRemainder;
    lonRemLt.in[1] <== gridSizeFp;
    lonRemLt.out === 1;

    // ─── Step 4: Assert computed indices match public claim ───
    computedRow === cellRow;
    computedCol === cellCol;

    // ─── Step 5: Context binding ───
    signal contextBound;
    contextBound <== contextDigest + epoch;

    // ─── Output ───
    signal output valid;
    valid <== 1;
}

component main {public [cellRow, cellCol, gridSizeFp, gridOffsetLatFp, gridOffsetLonFp, contextDigest, epoch]} = GridMembershipZkp();
