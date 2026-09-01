import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineClient, EngineError } from './client';

function stub(response: Response | Error) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Asserts the call rejects, and hands back the error with its real type. */
async function failure(promise: Promise<unknown>): Promise<EngineError> {
  try {
    await promise;
  } catch (err) {
    return err as EngineError;
  }
  throw new Error('expected the request to fail, but it resolved');
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('EngineClient', () => {
  it('sends the api key as a bearer token on every request', async () => {
    const fetchMock = stub(json([]));
    await new EngineClient('http://engine', 'sekret').listWallets();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://engine/wallets',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer sekret' }) })
    );
  });

  it('surfaces the engine error sentence, not the raw json', async () => {
    stub(json({ error: 'label is required' }, 400));
    await expect(new EngineClient('http://e', 'k').listWallets()).rejects.toThrow('label is required');
  });

  it('keeps the status so a caller can tell 401 from 404', async () => {
    stub(json({ error: 'unauthorized' }, 401));
    const err = await failure(new EngineClient('http://e', 'k').listWallets());
    expect(err).toBeInstanceOf(EngineError);
    expect(err.status).toBe(401);
  });

  it('falls back to the raw body when the error is not json', async () => {
    stub(new Response('Bad Gateway', { status: 502 }));
    await expect(new EngineClient('http://e', 'k').listWallets()).rejects.toThrow('Bad Gateway');
  });

  it('reports an unreachable engine as status 0', async () => {
    stub(new TypeError('fetch failed'));
    const err = await failure(new EngineClient('http://e', 'k').listWallets());
    expect(err.status).toBe(0);
    expect(err.message).toContain('cannot reach the engine');
  });

  it('treats a balance response with no sol field as zero', async () => {
    stub(json({}));
    await expect(new EngineClient('http://e', 'k').getBalance(1)).resolves.toBe(0);
  });

  it('encodes the since cursor', async () => {
    const fetchMock = stub(json([]));
    await new EngineClient('http://e', 'k').listAlertsSince(42);
    expect(fetchMock.mock.calls[0][0]).toBe('http://e/alerts?since=42');
  });

  it('posts a tracked wallet as json', async () => {
    const fetchMock = stub(json({ id: 1 }, 201));
    await new EngineClient('http://e', 'k').trackWallet('addr', 'label', true);
    const init = fetchMock.mock.calls[0][1]!;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ address: 'addr', label: 'label', isMine: true });
  });

  it('handles the empty 204 body on untrack', async () => {
    stub(new Response(null, { status: 204 }));
    await expect(new EngineClient('http://e', 'k').untrackWallet(3)).resolves.toBeUndefined();
  });
});
