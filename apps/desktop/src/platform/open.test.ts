import { afterEach, describe, expect, it, vi } from 'vitest';
import { openExternal } from './open';

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('openExternal', () => {
  it('opens an https link in a new browser context', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    await openExternal('https://axiom.trade/t/mint');
    expect(open).toHaveBeenCalledWith('https://axiom.trade/t/mint', '_blank', 'noopener,noreferrer');
  });

  it.each(['javascript:alert(1)', 'file:///C:/Windows/System32/calc.exe', 'data:text/html,<script>', 'not a url'])(
    'refuses to hand %s to the shell',
    async (url) => {
      const open = vi.fn();
      vi.stubGlobal('open', open);
      await openExternal(url);
      expect(open).not.toHaveBeenCalled();
    }
  );
});
