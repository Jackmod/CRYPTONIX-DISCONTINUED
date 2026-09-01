import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { Wallet } from './api/client';

/** No network of any kind: neither fetch nor the socket may escape a test. */
class SilentSocket {
  static instances: SilentSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    SilentSocket.instances.push(this);
  }
  close() {}
}

const WALLET: Wallet = {
  id: 1,
  address: 'AAAA1111111111111111111111111111111111111111',
  label: 'whale',
  isMine: true,
  heliusWebhookId: null,
  backfillStatus: 'done',
  addedAt: '2026-08-01T00:00:00.000Z',
};

/**
 * The nav, specifically.
 *
 * Section names deliberately repeat as headings inside the view they open, so
 * every nav assertion has to say which one it means.
 */
function nav() {
  return within(screen.getByRole('navigation', { name: 'Sections' }));
}

function routeFetch(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: string) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const body = routes[path];
    if (body === undefined) return new Response('[]', { status: 200 });
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  SilentSocket.instances = [];
  vi.stubGlobal('WebSocket', SilentSocket);
  localStorage.clear();
});

afterEach(() => vi.unstubAllGlobals());

describe('App', () => {
  it('loads wallets on start and shows how many are tracked', async () => {
    routeFetch({ '/wallets': [WALLET] });
    render(<App />);
    await waitFor(() => expect(screen.getByText('1 tracked')).toBeInTheDocument());
  });

  it('shows every section in the nav', () => {
    routeFetch({});
    render(<App />);
    for (const name of ['Wallets', 'Coins', 'Calls', 'PnL', 'Settings']) {
      expect(nav().getByText(name)).toBeInTheDocument();
    }
  });

  it('switches sections without reloading wallets', async () => {
    const fetchMock = routeFetch({ '/wallets': [WALLET] });
    render(<App />);
    await waitFor(() => expect(screen.getByText('1 tracked')).toBeInTheDocument());
    const walletCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/wallets')).length;

    fireEvent.click(nav().getByText('Coins'));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Coins' })).toBeInTheDocument());
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/wallets'))).toHaveLength(walletCalls);
  });

  it('marks the open section for assistive tech', () => {
    routeFetch({});
    render(<App />);
    fireEvent.click(nav().getByText('Settings'));
    expect(nav().getByText('Settings').closest('button')).toHaveAttribute('aria-current', 'page');
    expect(nav().getByText('Wallets').closest('button')).not.toHaveAttribute('aria-current');
  });

  it('surfaces an unreachable engine on the wallets view', async () => {
    routeFetch({ '/wallets': new TypeError('fetch failed') });
    render(<App />);
    await waitFor(() => expect(screen.getByText(/cannot reach the engine/)).toBeInTheDocument());
  });

  it('starts connecting to the socket with the configured key', () => {
    routeFetch({});
    localStorage.setItem(
      'cryptonix.connection',
      JSON.stringify({ httpUrl: 'http://e', wsUrl: 'ws://e/ws', apiKey: 'abc' })
    );
    render(<App />);
    expect(SilentSocket.instances[0].url).toBe('ws://e/ws?apiKey=abc');
  });

  it('persists a saved connection and uses it immediately', async () => {
    routeFetch({});
    render(<App />);
    fireEvent.click(nav().getByText('Settings'));
    fireEvent.change(screen.getByLabelText('Engine HTTP URL'), { target: { value: 'http://other:9000' } });
    fireEvent.click(screen.getByText('Save connection'));

    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('cryptonix.connection')!).httpUrl).toBe('http://other:9000')
    );
    await waitFor(() =>
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).startsWith('http://other:9000'))).toBe(true)
    );
  });

  it('falls back to defaults when stored settings are corrupt', () => {
    routeFetch({});
    localStorage.setItem('cryptonix.connection', 'not json');
    render(<App />);
    expect(SilentSocket.instances[0].url).toBe('ws://localhost:8787/ws?apiKey=');
  });

  it('ignores a stored value of the wrong shape rather than crashing', () => {
    routeFetch({});
    localStorage.setItem('cryptonix.connection', JSON.stringify({ httpUrl: 42, wsUrl: null }));
    render(<App />);
    expect(SilentSocket.instances[0].url).toBe('ws://localhost:8787/ws?apiKey=');
  });

  it('still renders when storage itself throws', () => {
    routeFetch({});
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('site data blocked');
    });
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Wallets' })).toBeInTheDocument();
    getItem.mockRestore();
  });

  it('adds a wallet in settings and shows it on the wallets view', async () => {
    let wallets: Wallet[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
        if (path === '/wallets' && init?.method === 'POST') {
          wallets = [WALLET];
          return new Response(JSON.stringify(WALLET), { status: 201 });
        }
        if (path === '/wallets') return new Response(JSON.stringify(wallets), { status: 200 });
        return new Response('[]', { status: 200 });
      })
    );

    render(<App />);
    fireEvent.click(nav().getByText('Settings'));
    fireEvent.change(screen.getByLabelText('Solana address'), { target: { value: WALLET.address } });
    fireEvent.click(screen.getByText('Track wallet'));

    // The nav count is driven by the same list the wallets view renders, so it
    // proves the reload actually happened rather than the form clearing.
    await waitFor(() => expect(nav().getByText('1')).toBeInTheDocument());
    fireEvent.click(nav().getByText('Wallets'));
    expect(screen.getByText('whale')).toBeInTheDocument();
  });

  it('re-reads the wallet list on a timer, so a wallet tracked from Discord appears', async () => {
    // Tracking publishes no alert, so nothing pushes this; only a poll sees it.
    let wallets: Wallet[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      if (path === '/wallets') return new Response(JSON.stringify(wallets), { status: 200 });
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers({ shouldAdvanceTime: true });

    render(<App />);
    await waitFor(() => expect(screen.getByText('0 tracked')).toBeInTheDocument());

    wallets = [WALLET];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    await waitFor(() => expect(screen.getByText('1 tracked')).toBeInTheDocument());
    vi.useRealTimers();
  });

  it('does not re-read the wallet list on every trade', async () => {
    const fetchMock = routeFetch({ '/wallets': [WALLET] });
    render(<App />);
    await waitFor(() => expect(screen.getByText('1 tracked')).toBeInTheDocument());
    const before = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/wallets')).length;

    for (let id = 90; id < 96; id++) {
      SilentSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          id,
          type: 'wallet_buy',
          payload: { walletLabel: 'whale', mint: 'mint', solAmount: 1 },
        }),
      });
    }

    await waitFor(() => expect(screen.getAllByText(/1\.00 SOL/).length).toBeGreaterThan(0));
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/wallets'))).toHaveLength(before);
  });

  it('re-reads a wallet balance when a trade lands', async () => {
    const fetchMock = routeFetch({ '/wallets': [WALLET], '/wallets/1/balance': { sol: 4 } });
    render(<App />);
    await waitFor(() => expect(screen.getByText('4.000')).toBeInTheDocument());
    const before = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/balance')).length;

    SilentSocket.instances[0].onmessage?.({
      data: JSON.stringify({
        id: 99,
        type: 'wallet_buy',
        payload: { walletLabel: 'whale', mint: 'mint', solAmount: 1 },
      }),
    });

    await waitFor(() =>
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/balance')).length).toBeGreaterThan(before)
    );
  });
});
