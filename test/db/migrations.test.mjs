import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.mjs';

test('every migration applies in order on a fresh database', async () => {
  const { failures } = await freshDb({ keepGoing: true });
  assert.deepEqual(failures, []);
});
