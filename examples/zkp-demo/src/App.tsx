import { useState } from 'react'
import {
  toFixedPoint,
  metersToRadiusSquared,
  cosLatScaled,
  validatePublicSignals,
} from '@zairn/geo-drop'

/**
 * ZKP Proximity Proof Demo
 *
 * Demonstrates the math behind zero-knowledge location proofs:
 * - Fixed-point coordinate encoding (×1e6 ≈ 0.11m resolution)
 * - Radius-squared computation with cos(lat) correction
 * - Public signal validation (no actual circuit execution needed)
 */

interface DemoState {
  // Inputs
  userLat: number
  userLon: number
  dropLat: number
  dropLon: number
  radiusMeters: number
  // Computed
  computed: null | {
    userLatFP: string
    userLonFP: string
    dropLatFP: string
    dropLonFP: string
    cosLat: string
    radiusSq: string
    dLat: bigint
    dLonCorrected: bigint
    distanceSq: bigint
    withinRadius: boolean
    distanceApproxMeters: number
  }
}

const DEFAULTS: DemoState = {
  userLat: 35.6815,
  userLon: 139.7670,
  dropLat: 35.6812,
  dropLon: 139.7671,
  radiusMeters: 50,
  computed: null,
}

function compute(s: DemoState): DemoState['computed'] {
  const userLatFP = toFixedPoint(s.userLat)
  const userLonFP = toFixedPoint(s.userLon)
  const dropLatFP = toFixedPoint(s.dropLat)
  const dropLonFP = toFixedPoint(s.dropLon)
  const cosLat = cosLatScaled(s.dropLat)
  const radiusSq = metersToRadiusSquared(s.radiusMeters)

  // The circuit computes:
  //   dLat = userLat - dropLat (in fixed-point)
  //   dLon = (userLon - dropLon) × cos(lat) / 1e6
  //   distanceSq = dLat² + dLon²
  //   assert distanceSq ≤ radiusSq
  const dLat = userLatFP - dropLatFP
  const dLonRaw = userLonFP - dropLonFP
  const dLonCorrected = (dLonRaw * cosLat) / 1_000_000n

  const distanceSq = dLat * dLat + dLonCorrected * dLonCorrected

  // Approximate real-world distance (for display)
  const distanceApproxMeters = Math.sqrt(Number(distanceSq)) * 111_320 / 1_000_000

  return {
    userLatFP: userLatFP.toString(),
    userLonFP: userLonFP.toString(),
    dropLatFP: dropLatFP.toString(),
    dropLonFP: dropLonFP.toString(),
    cosLat: cosLat.toString(),
    radiusSq: radiusSq.toString(),
    dLat,
    dLonCorrected,
    distanceSq,
    withinRadius: distanceSq <= radiusSq,
    distanceApproxMeters,
  }
}

// ─── Signal Validation Demo ───────────────────

function SignalValidationDemo() {
  const [signals, setSignals] = useState({
    dropLat: '35681200',
    dropLon: '139767100',
    radiusSq: '202617',
    result: '',
  })

  const validate = () => {
    try {
      // publicSignals format: [dropLatFP, dropLonFP, radiusSquared, cosLatScaled]
      const cosLat = cosLatScaled(Number(signals.dropLat) / 1e6).toString()
      const publicSignals = [signals.dropLat, signals.dropLon, signals.radiusSq, cosLat]

      const isValid = validatePublicSignals(publicSignals, {
        lat: Number(signals.dropLat) / 1e6,
        lon: Number(signals.dropLon) / 1e6,
        radiusMeters: 50,
      })

      setSignals(s => ({
        ...s,
        result: isValid
          ? 'Valid — signals match drop parameters'
          : 'Invalid — signals tampered or mismatched',
      }))
    } catch (e: any) {
      setSignals(s => ({ ...s, result: `Error: ${e.message}` }))
    }
  }

  return (
    <section style={sectionStyle}>
      <h2>Public Signal Validation</h2>
      <p style={helpText}>
        After proof verification, we validate that the public signals match the drop's
        known parameters. This prevents proof reuse across different drops.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <label style={labelStyle}>
          dropLat (FP)
          <input value={signals.dropLat} onChange={e => setSignals(s => ({ ...s, dropLat: e.target.value }))}
            style={inputStyle} />
        </label>
        <label style={labelStyle}>
          dropLon (FP)
          <input value={signals.dropLon} onChange={e => setSignals(s => ({ ...s, dropLon: e.target.value }))}
            style={inputStyle} />
        </label>
      </div>
      <label style={labelStyle}>
        radiusSquared (FP)
        <input value={signals.radiusSq} onChange={e => setSignals(s => ({ ...s, radiusSq: e.target.value }))}
          style={inputStyle} />
      </label>
      <button onClick={validate} style={btnStyle}>Validate Signals</button>
      {signals.result && (
        <pre style={{ ...codeStyle, color: signals.result.startsWith('Valid') ? '#2e7d32' : '#c62828' }}>
          {signals.result}
        </pre>
      )}
    </section>
  )
}

// ─── Main App ─────────────────────────────────

export default function App() {
  const [state, setState] = useState<DemoState>(DEFAULTS)

  const runCompute = () => {
    setState(s => ({ ...s, computed: compute(s) }))
  }

  const c = state.computed

  return (
    <div>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>ZKP Proximity Proof</h1>
      <p style={{ color: 'var(--md-outline)', marginBottom: 32 }}>
        Prove you're within a radius without revealing your exact coordinates.
        <br />This demo shows the fixed-point math used inside the Groth16 circuit.
      </p>

      {/* ─── Input ─── */}
      <section style={sectionStyle}>
        <h2>Inputs (Private + Public)</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <label style={labelStyle}>
            User Lat (private)
            <input type="number" step="0.0001" value={state.userLat}
              onChange={e => setState(s => ({ ...s, userLat: Number(e.target.value) }))}
              style={{ ...inputStyle, background: '#fff3e0' }} />
          </label>
          <label style={labelStyle}>
            User Lon (private)
            <input type="number" step="0.0001" value={state.userLon}
              onChange={e => setState(s => ({ ...s, userLon: Number(e.target.value) }))}
              style={{ ...inputStyle, background: '#fff3e0' }} />
          </label>
          <label style={labelStyle}>
            Drop Lat (public)
            <input type="number" step="0.0001" value={state.dropLat}
              onChange={e => setState(s => ({ ...s, dropLat: Number(e.target.value) }))}
              style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Drop Lon (public)
            <input type="number" step="0.0001" value={state.dropLon}
              onChange={e => setState(s => ({ ...s, dropLon: Number(e.target.value) }))}
              style={inputStyle} />
          </label>
        </div>
        <label style={labelStyle}>
          Radius (public): {state.radiusMeters}m
          <input type="range" min={10} max={500} value={state.radiusMeters}
            onChange={e => setState(s => ({ ...s, radiusMeters: Number(e.target.value) }))}
            style={{ width: '100%' }} />
        </label>
        <button onClick={runCompute} style={btnStyle}>Compute Circuit Inputs</button>
      </section>

      {/* ─── Results ─── */}
      {c && (
        <>
          <section style={sectionStyle}>
            <h2>Step 1: Fixed-Point Encoding (×1e6)</h2>
            <p style={helpText}>
              Coordinates are converted to integers for arithmetic inside the circuit.
              1 unit ≈ 0.11m at equator.
            </p>
            <pre style={codeStyle}>
{`userLat:  ${state.userLat}°  →  ${c.userLatFP}
userLon:  ${state.userLon}°  →  ${c.userLonFP}
dropLat:  ${state.dropLat}°  →  ${c.dropLatFP}
dropLon:  ${state.dropLon}°  →  ${c.dropLonFP}`}
            </pre>
          </section>

          <section style={sectionStyle}>
            <h2>Step 2: Longitude Correction</h2>
            <p style={helpText}>
              At latitude {state.dropLat}°, one degree of longitude is shorter than
              one degree of latitude. We multiply dLon by cos(lat).
            </p>
            <pre style={codeStyle}>
{`cos(${state.dropLat}°) × 1e6 = ${c.cosLat}
radiusSquared (FP)  = ${c.radiusSq}`}
            </pre>
          </section>

          <section style={sectionStyle}>
            <h2>Step 3: Distance Check (Circuit Logic)</h2>
            <p style={helpText}>
              The circuit proves: dLat² + (dLon × cos(lat))² ≤ R²
            </p>
            <pre style={codeStyle}>
{`dLat           = ${c.dLat.toString()}
dLon×cos(lat)  = ${c.dLonCorrected.toString()}

dLat²          = ${(c.dLat * c.dLat).toString()}
dLon_corr²     = ${(c.dLonCorrected * c.dLonCorrected).toString()}
─────────────────────────────────
distanceSq     = ${c.distanceSq.toString()}
radiusSq       = ${c.radiusSq}

distanceSq ${c.withinRadius ? '≤' : '>'} radiusSq  →  ${c.withinRadius ? 'WITHIN RADIUS' : 'OUTSIDE RADIUS'}

≈ ${c.distanceApproxMeters.toFixed(1)}m (approximate)`}
            </pre>
            <div style={{
              padding: 12, borderRadius: 8, marginTop: 8, fontWeight: 600,
              background: c.withinRadius ? '#e8f5e9' : '#ffebee',
              color: c.withinRadius ? '#2e7d32' : '#c62828',
            }}>
              {c.withinRadius
                ? 'Proof would succeed — user is within the radius'
                : 'Proof would fail — user is outside the radius'}
            </div>
          </section>

          <section style={sectionStyle}>
            <h2>Privacy Summary</h2>
            <pre style={codeStyle}>
{`Private inputs (never leave client):
  userLat = ${state.userLat}°
  userLon = ${state.userLon}°

Public inputs (visible to verifier):
  dropLat      = ${c.dropLatFP}  (${state.dropLat}°)
  dropLon      = ${c.dropLonFP}  (${state.dropLon}°)
  radiusSq     = ${c.radiusSq}
  cos(lat)×1e6 = ${c.cosLat}

The verifier learns ONLY:
  "The prover is within ${state.radiusMeters}m of (${state.dropLat}, ${state.dropLon})"

They do NOT learn the prover's actual coordinates.`}
            </pre>
          </section>
        </>
      )}

      <SignalValidationDemo />

      <section style={{ ...sectionStyle, borderColor: 'var(--md-outline)' }}>
        <h2>How the Full Flow Works</h2>
        <pre style={{ ...codeStyle, fontSize: 13 }}>
{`1. Drop creator sets proof_config = { method: 'zkp', params: { verification_key } }

2. Claimer calls generateProximityProof(userLat, userLon, dropLat, dropLon, radius)
   → Runs Groth16 prover with compiled circom circuit (WASM + zkey)
   → Returns { proof, publicSignals }
   → User coordinates NEVER leave the client

3. Verifier calls verifyProximityProof(proof, publicSignals, verificationKey)
   → Cryptographically verifies the proof in ~10ms
   → Also validates publicSignals match drop parameters
   → Returns boolean

Note: This demo shows the math only. Full proof generation requires
      compiled circuit artifacts (see circuits/README.md for build instructions).`}
        </pre>
      </section>
    </div>
  )
}

// ─── Styles ───────────────────────────────────

const sectionStyle: React.CSSProperties = {
  marginBottom: 24, padding: 20, borderRadius: 12,
  border: '1px solid #e0dce5', background: 'white',
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', marginTop: 4,
  border: '1px solid var(--md-outline)', borderRadius: 6,
  fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box',
}

const labelStyle: React.CSSProperties = {
  fontSize: 13, color: 'var(--md-outline)', display: 'block', marginBottom: 8,
}

const btnStyle: React.CSSProperties = {
  padding: '10px 24px', border: 'none', borderRadius: 8,
  background: 'var(--md-primary)', color: 'var(--md-on-primary)',
  fontSize: 14, cursor: 'pointer', marginTop: 8,
}

const codeStyle: React.CSSProperties = {
  background: '#f5f2f8', padding: 16, borderRadius: 8,
  fontSize: 13, lineHeight: 1.6, overflow: 'auto',
  whiteSpace: 'pre-wrap', wordBreak: 'break-all',
}

const helpText: React.CSSProperties = {
  fontSize: 14, color: 'var(--md-outline)', margin: '0 0 12px', lineHeight: 1.5,
}
