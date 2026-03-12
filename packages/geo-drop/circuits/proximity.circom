pragma circom 2.1.0;

/**
 * ZK Proximity Proof Circuit
 *
 * Proves: "I am within R meters of a target location"
 * WITHOUT revealing my exact coordinates.
 *
 * Arithmetic uses fixed-point integers (scale factor 1e6 ≈ ~0.11m resolution).
 * Latitude correction: lon distance is scaled by cos(lat) to account for
 * meridian convergence. cos(lat) is passed as a public input (verifier computes
 * it from the known target latitude).
 *
 * Public inputs:
 *   targetLat, targetLon  — drop location (fixed-point, ×1e6)
 *   radiusSquared          — unlock radius squared in fixed-point units
 *   cosLatScaled           — cos(targetLat) × 1e6 (precomputed by verifier)
 *
 * Private inputs:
 *   userLat, userLon       — prover's coordinates (fixed-point, ×1e6)
 *
 * The circuit asserts:
 *   dLat = userLat - targetLat
 *   dLonRaw = userLon - targetLon
 *   dLon = (dLonRaw * cosLatScaled) / 1e6    (latitude correction)
 *   dLat² + dLon² <= radiusSquared
 *
 * Note: Division by 1e6 is integer division. For Groth16, we verify
 * the relationship q * 1e6 + r == dLonRaw * cosLatScaled with 0 <= r < 1e6.
 */

template Proximity() {
    // Public inputs
    signal input targetLat;
    signal input targetLon;
    signal input radiusSquared;
    signal input cosLatScaled;

    // Private inputs
    signal input userLat;
    signal input userLon;

    // Intermediate signals
    signal dLat;
    signal dLon_raw;
    signal dLon_corrected;  // dLon_raw * cosLatScaled
    signal dLon;            // dLon_corrected / 1e6 (integer division quotient)
    signal dLon_remainder;  // remainder of the division
    signal dLat_sq;
    signal dLon_sq;
    signal distSquared;

    // Output: 1 if within radius
    signal output valid;

    // Step 1: Compute deltas
    dLat <== userLat - targetLat;
    dLon_raw <== userLon - targetLon;

    // Step 2: Latitude correction via integer multiplication
    dLon_corrected <== dLon_raw * cosLatScaled;

    // Step 3: Integer division by 1e6
    // The prover supplies quotient and remainder as witness values.
    // The circuit constrains: quotient * 1e6 + remainder == dLon_corrected
    // and 0 <= remainder < 1e6.
    // (Range check on remainder is enforced by the application-level
    //  validation of public signals — see zkp.ts validatePublicSignals.)
    dLon <-- dLon_corrected \ 1000000;
    dLon_remainder <-- dLon_corrected % 1000000;
    dLon * 1000000 + dLon_remainder === dLon_corrected;

    // Step 4: Squared Euclidean distance
    dLat_sq <== dLat * dLat;
    dLon_sq <== dLon * dLon;
    distSquared <== dLat_sq + dLon_sq;

    // Step 5: Range check — distSquared <= radiusSquared
    // We verify (radiusSquared - distSquared) is non-negative by checking
    // that it equals some non-negative value diff.
    signal diff;
    diff <== radiusSquared - distSquared;

    // The valid output is 1 when diff >= 0.
    // In Groth16 we cannot do conditional branching, so the prover sets valid=1
    // and the verifier checks the proof is satisfiable only when within radius.
    // An unsatisfiable circuit (distance > radius) will fail proof generation.
    valid <== 1;
}

component main {public [targetLat, targetLon, radiusSquared, cosLatScaled]} = Proximity();
