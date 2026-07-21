import assert from 'node:assert/strict';
import {
  computeTrustScore,
  computeTrustScoreV2,
  DEFAULT_TRUST_SIGNAL_PROVIDERS,
} from '../dist/index.js';

const current = {
  lat: 35,
  lon: 139,
  accuracy: 10,
  timestamp: '2026-01-01T00:01:00.000Z',
};
const history = [{
  lat: 35,
  lon: 139,
  accuracy: 10,
  timestamp: '2026-01-01T00:00:00.000Z',
}];

assert.deepEqual(
  computeTrustScoreV2(current, history),
  computeTrustScore(current, history),
);
assert.equal(DEFAULT_TRUST_SIGNAL_PROVIDERS.length, 2);

console.log('trust-scorer dist smoke passed');
