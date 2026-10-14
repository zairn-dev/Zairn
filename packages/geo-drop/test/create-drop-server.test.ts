/**
 * createDrop() with server-side creation: the SDK must hand the plaintext to
 * the create-drop Edge Function and never write geo_drops itself or derive a
 * key without the server secret.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';

const directInserts: string[] = [];

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
      getSession: async () => ({ data: { session: { access_token: 'jwt-1' } }, error: null }),
    },
    from: (table: string) => ({
      insert: (payload: unknown) => {
        directInserts.push(table);
        return { select: () => ({ single: async () => ({ data: payload, error: null }) }) };
      },
      update: () => ({ eq: async () => ({ data: null, error: null }) }),
    }),
  }),
}));

import { createGeoDrop } from '../src/core';
import { GeoDropError } from '../src/errors';

afterEach(() => {
  vi.unstubAllGlobals();
  directInserts.length = 0;
});

const serverDrop = { id: 'drop-1', title: 'Gate', lat: 35, lon: 139, geohash: 'xn76urx' };

function respondWith(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('createDrop via the create-drop Edge Function', () => {
  it('is used by default with serverUnlock and no client secret', async () => {
    const fetchMock = respondWith(201, { drop: serverDrop });
    const sdk = createGeoDrop({ supabaseUrl: 'http://sb.test', supabaseAnonKey: 'anon', serverUnlock: true });

    const drop = await sdk.createDrop(
      { title: 'Gate', content_type: 'text', lat: 35, lon: 139, password: 'pw' },
      'hello treasure',
    );

    expect(drop).toEqual(serverDrop);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://sb.test/functions/v1/create-drop');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer jwt-1');
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({ content: 'hello treasure', password: 'pw', storage: 'db', lat: 35, lon: 139 });
    expect(directInserts).not.toContain('geo_drops');
  });

  it('maps server errors to GeoDropError codes', async () => {
    respondWith(400, { error: 'Invalid coordinates', code: 'invalid_input' });
    const sdk = createGeoDrop({ supabaseUrl: 'http://sb.test', supabaseAnonKey: 'anon', serverUnlock: true });
    const err = await sdk.createDrop({ title: 'x', content_type: 'text', lat: 1, lon: 1 }, 'c').catch((e) => e);
    expect(err).toBeInstanceOf(GeoDropError);
    expect(err.code).toBe('INVALID_INPUT');

    respondWith(429, { error: 'Rate limit exceeded' });
    const limited = await sdk.createDrop({ title: 'x', content_type: 'text', lat: 1, lon: 1 }, 'c').catch((e) => e);
    expect(limited.code).toBe('RATE_LIMITED');
  });

  it('a trusted backend with the secret can opt out and encrypt locally', async () => {
    const fetchMock = respondWith(500, {});
    const sdk = createGeoDrop({
      supabaseUrl: 'http://sb.test', supabaseAnonKey: 'anon', serverUnlock: true,
      encryptionSecret: 'server-secret', serverCreate: false,
    });
    await sdk.createDrop({ title: 'Gate', content_type: 'text', lat: 35, lon: 139 }, 'hello');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(directInserts).toContain('geo_drops');
  });
});
