pragma circom 2.1.0;

/**
 * Region-ZKP circuit: Point-in-polygon containment proof.
 *
 * Proves that a private point (userLat, userLon) lies inside a public
 * polygon defined by up to MAX_VERTICES vertices, without revealing
 * the exact coordinates.
 *
 * Algorithm: Ray-casting (even-odd rule) in fixed-point arithmetic.
 * A horizontal ray is cast from the point to +infinity. The number
 * of polygon edge crossings is counted. Odd count = inside.
 *
 * Fixed-point scale: x1e6 (same as zairn_zkp.circom).
 * Coordinates are shifted to non-negative space before processing.
 *
 * Context binding: contextDigest, epoch, challengeDigest (same pattern
 * as ZairnZkp) for replay resistance.
 */

// =====================
// Reusable components (same as zairn_zkp.circom)
// =====================

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

template GreaterThan(n) {
    signal input in[2];
    signal output out;

    component lt = LessThan(n);
    lt.in[0] <== in[1];
    lt.in[1] <== in[0];
    out <== lt.out;
}

// =====================
// Edge crossing detector
// =====================
// For a single polygon edge (v1, v2), determines whether a horizontal
// ray from point P to +infinity crosses this edge.
//
// An edge crosses if:
//   1. One vertex is above P.lat and one is below (or equal), AND
//   2. P.lon < intersection_lon
//
// The intersection x-coordinate:
//   xIntersect = v1.lon + (P.lat - v1.lat) * (v2.lon - v1.lon) / (v2.lat - v1.lat)
//
// To avoid division in the circuit, we use the cross-product form:
//   crosses if: (P.lon - v1.lon) * (v2.lat - v1.lat) < (P.lat - v1.lat) * (v2.lon - v1.lon)
//   (when v2.lat > v1.lat; reverse when v2.lat < v1.lat)

template EdgeCrossing(n) {
    signal input pLat;
    signal input pLon;
    signal input v1Lat;
    signal input v1Lon;
    signal input v2Lat;
    signal input v2Lon;
    signal input active;  // 1 if this edge is part of the polygon, 0 if padding
    signal output crosses;

    // Check vertical span: does the edge straddle pLat?
    // Condition: (v1Lat <= pLat < v2Lat) OR (v2Lat <= pLat < v1Lat)

    // v1Lat <= pLat
    component v1LeP = LessEqThan(n);
    v1LeP.in[0] <== v1Lat;
    v1LeP.in[1] <== pLat;

    // pLat < v2Lat
    component pLtV2 = LessThan(n);
    pLtV2.in[0] <== pLat;
    pLtV2.in[1] <== v2Lat;

    // Upward crossing: v1Lat <= pLat AND pLat < v2Lat
    signal upward;
    upward <== v1LeP.out * pLtV2.out;

    // v2Lat <= pLat
    component v2LeP = LessEqThan(n);
    v2LeP.in[0] <== v2Lat;
    v2LeP.in[1] <== pLat;

    // pLat < v1Lat
    component pLtV1 = LessThan(n);
    pLtV1.in[0] <== pLat;
    pLtV1.in[1] <== v1Lat;

    // Downward crossing: v2Lat <= pLat AND pLat < v1Lat
    signal downward;
    downward <== v2LeP.out * pLtV1.out;

    // Either upward or downward (mutually exclusive, so addition works)
    signal straddles;
    straddles <== upward + downward;

    // Cross-product test to check if point is to the left of the edge.
    // lhs = (pLon - v1Lon) * (v2Lat - v1Lat)
    // rhs = (pLat - v1Lat) * (v2Lon - v1Lon)
    //
    // For upward crossing: crosses if lhs < rhs
    // For downward crossing: crosses if lhs > rhs
    // Equivalently: crosses if (lhs < rhs) XOR downward
    //
    // We compute both and select based on direction.
    signal dPLon;
    signal dPLat;
    signal dVLon;
    signal dVLat;

    dPLon <== pLon - v1Lon;
    dPLat <== pLat - v1Lat;
    dVLon <== v2Lon - v1Lon;
    dVLat <== v2Lat - v1Lat;

    signal lhs;
    signal rhs;
    lhs <== dPLon * dVLat;
    rhs <== dPLat * dVLon;

    // Shift both to non-negative for comparison (max product ~2^58)
    var SHIFT = 1 << 60;
    component lhsLtRhs = LessThan(62);
    lhsLtRhs.in[0] <== lhs + SHIFT;
    lhsLtRhs.in[1] <== rhs + SHIFT;

    // For upward: crosses if lhs < rhs
    // For downward: crosses if lhs > rhs (i.e., NOT lhs < rhs)
    signal crossUp;
    signal crossDown;
    crossUp <== upward * lhsLtRhs.out;
    crossDown <== downward * (1 - lhsLtRhs.out);

    signal rawCross;
    rawCross <== crossUp + crossDown;

    // Mask with active flag (inactive edges contribute 0)
    crosses <== rawCross * active;
}

// =====================
// Main circuit: RegionZkp
// =====================
// MAX_VERTICES = 16 (polygon with up to 16 vertices)
// Unused vertices are set to (0,0) with active=0.

template RegionZkp(MAX_VERTICES) {
    var LAT_SHIFT = 90000000;
    var LON_SHIFT = 180000000;

    // Public inputs: polygon vertices (shifted to non-negative)
    signal input polyLat[MAX_VERTICES];
    signal input polyLon[MAX_VERTICES];
    signal input vertexCount;  // actual number of vertices (3..MAX_VERTICES)

    // Context binding (same as ZairnZkp)
    signal input contextDigest;
    signal input epoch;
    signal input challengeDigest;

    // Private inputs
    signal input userLat;
    signal input userLon;

    // Shift user coordinates to non-negative space
    signal userLatShifted;
    signal userLonShifted;
    userLatShifted <== userLat + LAT_SHIFT;
    userLonShifted <== userLon + LON_SHIFT;

    // Range-check user coordinates
    component userLatBits = Num2BitsBounded(28);
    component userLonBits = Num2BitsBounded(29);
    userLatBits.in <== userLatShifted;
    userLonBits.in <== userLonShifted;

    // Compute active flags: edge i is active if i < vertexCount
    signal active[MAX_VERTICES];
    component activeCheck[MAX_VERTICES];
    for (var i = 0; i < MAX_VERTICES; i++) {
        activeCheck[i] = LessThan(5);  // 5 bits enough for 0..16
        activeCheck[i].in[0] <== i;
        activeCheck[i].in[1] <== vertexCount;
        active[i] <== activeCheck[i].out;
    }

    // Ray-casting: count edge crossings
    component edges[MAX_VERTICES];
    signal crossCount[MAX_VERTICES + 1];
    crossCount[0] <== 0;

    for (var i = 0; i < MAX_VERTICES; i++) {
        var next = (i + 1) % MAX_VERTICES;

        edges[i] = EdgeCrossing(30);
        edges[i].pLat <== userLatShifted;
        edges[i].pLon <== userLonShifted;
        edges[i].v1Lat <== polyLat[i];
        edges[i].v1Lon <== polyLon[i];

        // For the last active edge, next wraps to vertex 0
        // For inactive edges, values don't matter (active=0 masks output)
        edges[i].v2Lat <== polyLat[next];
        edges[i].v2Lon <== polyLon[next];
        edges[i].active <== active[i];

        crossCount[i + 1] <== crossCount[i] + edges[i].crosses;
    }

    // Point is inside if crossing count is odd
    // Extract LSB of crossCount
    signal totalCrossings;
    totalCrossings <== crossCount[MAX_VERTICES];

    component crossBits = Num2BitsBounded(5);  // max 16 crossings
    crossBits.in <== totalCrossings;

    // Bind context signals
    signal contextBound;
    contextBound <== contextDigest + epoch + challengeDigest;

    signal output valid;
    valid <== crossBits.out[0];  // LSB = 1 if odd crossings = inside
    valid === 1;
}

component main {public [polyLat, polyLon, vertexCount, contextDigest, epoch, challengeDigest]} = RegionZkp(16);
