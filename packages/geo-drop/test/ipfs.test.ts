import { afterEach, describe, expect, it, vi } from 'vitest';
import { IpfsClient, unixFsSingleBlock } from '../src/ipfs';

const VALID_CID = `Qm${'a'.repeat(44)}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('IpfsClient custom pinning', () => {
  it('resolves fresh auth headers and sends multipart content', async () => {
    const getCustomPinningHeaders = vi.fn()
      .mockResolvedValueOnce({
        Authorization: 'Bearer first',
        'Content-Type': 'application/json',
      })
      .mockResolvedValueOnce({ Authorization: 'Bearer second' });
    const fetchMock = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({ cid: VALID_CID, size: 3 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));
    vi.stubGlobal('fetch', fetchMock);

    const client = new IpfsClient({
      gateway: 'https://gateway.example/ipfs',
      pinningService: 'custom',
      customPinningUrl: 'https://pin.example/upload',
      getCustomPinningHeaders,
    });

    await client.upload('one');
    await client.upload('two');

    expect(getCustomPinningHeaders).toHaveBeenCalledTimes(2);
    const firstInit = fetchMock.mock.calls[0][1] as RequestInit;
    const secondInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(new Headers(firstInit.headers).get('authorization')).toBe('Bearer first');
    expect(new Headers(secondInit.headers).get('authorization')).toBe('Bearer second');
    expect(new Headers(firstInit.headers).has('content-type')).toBe(false);
    expect(firstInit.body).toBeInstanceOf(FormData);
    expect(firstInit.redirect).toBe('error');
  });

  it('keeps pinningApiKey compatibility for custom services', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ cid: VALID_CID }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));
    vi.stubGlobal('fetch', fetchMock);

    const client = new IpfsClient({
      gateway: 'https://gateway.example/ipfs',
      pinningService: 'custom',
      pinningApiKey: 'legacy-token',
      customPinningUrl: 'https://pin.example/upload',
    });

    await client.upload('content');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer legacy-token');
  });

  it('rejects insecure remote upload URLs before resolving auth', () => {
    const getCustomPinningHeaders = vi.fn();

    expect(() => new IpfsClient({
      gateway: 'https://gateway.example/ipfs',
      pinningService: 'custom',
      customPinningUrl: 'http://pin.example/upload',
      getCustomPinningHeaders,
    })).toThrow('Custom pinning URL must use HTTPS');
    expect(getCustomPinningHeaders).not.toHaveBeenCalled();
  });

  it('allows HTTP only for loopback development endpoints', () => {
    expect(() => new IpfsClient({
      gateway: 'https://gateway.example/ipfs',
      pinningService: 'custom',
      customPinningUrl: 'http://127.0.0.1:54321/functions/v1/ipfs-proxy',
    })).not.toThrow();
  });

  it('rejects malformed CIDs returned by a custom service', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ cid: 'not-a-cid' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )));
    const client = new IpfsClient({
      gateway: 'https://gateway.example/ipfs',
      pinningService: 'custom',
      customPinningUrl: 'https://pin.example/upload',
    });

    await expect(client.upload('content')).rejects.toThrow('Invalid IPFS CID');
  });

  it('rejects invalid upload size limits', () => {
    expect(() => new IpfsClient({
      gateway: 'https://gateway.example/ipfs',
      maxUploadSize: 0,
    })).toThrow('maxUploadSize must be a positive safe integer');
  });
});

describe('IpfsClient content integrity (CIDv0)', () => {
  // kubo: `echo "hello world" | ipfs add`
  const HELLO = 'hello world\n';
  const HELLO_CID = 'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o';
  const gatewayReturning = (body: string) => vi.fn().mockImplementation(async () => new Response(body, { status: 200 }));

  it('rebuilds the dag-pb block that a CIDv0 actually hashes', async () => {
    const block = unixFsSingleBlock(new TextEncoder().encode(HELLO));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', block as BufferSource));
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n = BigInt('0x' + Buffer.from([0x12, 0x20, ...digest]).toString('hex'));
    let cid = '';
    while (n > 0n) { cid = alphabet[Number(n % 58n)] + cid; n /= 58n; }
    expect(cid).toBe(HELLO_CID);
  });

  it('accepts genuine content for its CID', async () => {
    vi.stubGlobal('fetch', gatewayReturning(HELLO));
    const client = new IpfsClient({ gateway: 'https://gateway.example/ipfs' });
    await expect(client.fetch(HELLO_CID)).resolves.toBe(HELLO);
  });

  it('rejects content a gateway altered', async () => {
    vi.stubGlobal('fetch', gatewayReturning('hello w0rld\n'));
    const client = new IpfsClient({ gateway: 'https://gateway.example/ipfs' });
    await expect(client.fetch(HELLO_CID)).rejects.toThrow(/integrity/);
  });
});
