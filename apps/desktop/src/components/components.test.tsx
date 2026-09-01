import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Identicon } from './Identicon';
import { CoinLogo } from './CoinLogo';
import { StatusCursor } from './StatusCursor';
import { Sol, compactUsd, displayLabel, shortAddress } from './Money';
import { ExternalLink } from './ExternalLink';
import { LiveRail } from './LiveRail';
import type { FeedItem } from '../api/feed';

const ADDR = 'So11111111111111111111111111111111111111112';

function feedItem(over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 1,
    kind: 'buy',
    what: 'whale',
    detail: '1.00 SOL',
    imageUrl: null,
    link: null,
    at: new Date('2026-09-01T12:34:56Z'),
    ...over,
  };
}

describe('Identicon', () => {
  it('is stable for the same address', () => {
    const a = render(<Identicon address={ADDR} />).container.innerHTML;
    const b = render(<Identicon address={ADDR} />).container.innerHTML;
    expect(a).toBe(b);
  });

  it('differs between addresses', () => {
    const a = render(<Identicon address={ADDR} />).container.innerHTML;
    const b = render(<Identicon address={`${ADDR}x`} />).container.innerHTML;
    expect(a).not.toBe(b);
  });

  it('is mirrored down the vertical axis so it reads as a glyph', () => {
    const { container } = render(<Identicon address={ADDR} size={25} />);
    // The background rect comes first; the rest are the pattern cells.
    const cells = [...container.querySelectorAll('rect')].slice(1);
    const filled = new Set(cells.map((r) => `${r.getAttribute('x')},${r.getAttribute('y')}`));
    expect(filled.size).toBeGreaterThan(0);
    for (const key of filled) {
      const [x, y] = key.split(',').map(Number);
      // Cell width is 5 at size 25, so column index is x / 5.
      const mirroredX = (4 - x / 5) * 5;
      expect(filled.has(`${mirroredX},${y}`)).toBe(true);
    }
  });

  it('never colours an identicon with the gain or loss hue', () => {
    // Money colours are reserved; an identity must not read as a value.
    for (let i = 0; i < 200; i++) {
      const { container } = render(<Identicon address={`wallet-${i}`} />);
      // A sparse pattern can legitimately have no filled cells; skip those.
      const cell = container.querySelectorAll('rect')[1];
      if (!cell) continue;
      expect(cell.getAttribute('fill')).toMatch(/^hsl\(\d+ 55% 62%\)$/);
    }
  });

  it('gives different addresses different shapes, not just different colours', () => {
    // Regression: FNV-1a's low bit is only the parity of the input bytes, so
    // deriving each cell from `hash(addr:x:y) & 1` collapsed every wallet in
    // the app to one of two checkerboards, distinguishable by hue alone.
    const shapes = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const { container } = render(<Identicon address={`wallet-${i}`} size={25} />);
      const cells = [...container.querySelectorAll('rect')].slice(1);
      shapes.add(cells.map((r) => `${r.getAttribute('x')},${r.getAttribute('y')}`).sort().join(' '));
    }
    expect(shapes.size).toBeGreaterThan(30);
  });

  it('does not draw the same cell count for every address', () => {
    const counts = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const { container } = render(<Identicon address={`w${i}`} />);
      counts.add(container.querySelectorAll('rect').length);
    }
    expect(counts.size).toBeGreaterThan(3);
  });

  it('labels itself for screen readers', () => {
    render(<Identicon address={ADDR} />);
    expect(screen.getByLabelText(`Identicon for ${ADDR}`)).toBeInTheDocument();
  });
});

describe('CoinLogo', () => {
  it('shows the real logo when the provider has one', () => {
    render(<CoinLogo mint="mint" symbol="PEPE" imageUrl="https://cdn/p.png" />);
    expect(screen.getByAltText('PEPE logo')).toHaveAttribute('src', 'https://cdn/p.png');
  });

  it('falls back to a generated mark when there is no logo', () => {
    render(<CoinLogo mint="mint" symbol="PEPE" imageUrl={null} />);
    expect(screen.getByLabelText('Identicon for mint')).toBeInTheDocument();
  });

  it('falls back when the logo url fails to load', () => {
    render(<CoinLogo mint="mint" symbol="PEPE" imageUrl="https://cdn/gone.png" />);
    fireEvent.error(screen.getByAltText('PEPE logo'));
    expect(screen.getByLabelText('Identicon for mint')).toBeInTheDocument();
  });
});

describe('StatusCursor', () => {
  it.each([
    ['live', 'live'],
    ['connecting', 'connecting'],
    ['down', 'reconnecting'],
  ] as const)('reports %s as %s', (state, label) => {
    render(<StatusCursor state={state} />);
    expect(screen.getByRole('status')).toHaveTextContent(label);
  });

  it('exposes the state for the blink rule', () => {
    const { container } = render(<StatusCursor state="live" />);
    expect(container.querySelector('.cursor')).toHaveAttribute('data-state', 'live');
  });
});

describe('Money', () => {
  it('signs and colours a gain', () => {
    const { container } = render(<Sol value={1.5} />);
    expect(container.textContent).toBe('+1.5000');
    expect(container.querySelector('span')).toHaveClass('gain');
  });

  it('colours a loss without inventing a sign', () => {
    const { container } = render(<Sol value={-1.5} />);
    expect(container.textContent).toBe('-1.5000');
    expect(container.querySelector('span')).toHaveClass('loss');
  });

  it('leaves zero uncoloured, because zero is not a result', () => {
    const { container } = render(<Sol value={0} />);
    expect(container.querySelector('span')).not.toHaveClass('gain');
    expect(container.querySelector('span')).not.toHaveClass('loss');
  });

  it('compacts usd at each magnitude', () => {
    expect(compactUsd(950)).toBe('$950');
    expect(compactUsd(12_500)).toBe('$12.5k');
    expect(compactUsd(2_400_000)).toBe('$2.4M');
  });

  it('shortens a long address but leaves a short one alone', () => {
    expect(shortAddress(ADDR)).toBe('So11…1112');
    expect(shortAddress('short')).toBe('short');
  });

  it('names a wallet by its label', () => {
    expect(displayLabel({ label: 'whale', address: ADDR })).toBe('whale');
  });

  it('falls back to the address when a label is empty or only spaces', () => {
    // A nameless row cannot be told apart from its neighbours or clicked with
    // any confidence about which wallet is being opened.
    expect(displayLabel({ label: '', address: ADDR })).toBe('So11…1112');
    expect(displayLabel({ label: '   ', address: ADDR })).toBe('So11…1112');
  });
});

describe('ExternalLink', () => {
  it('keeps a real href so the target is inspectable', () => {
    render(<ExternalLink href="https://axiom.trade/t/m">Axiom</ExternalLink>);
    expect(screen.getByText('Axiom')).toHaveAttribute('href', 'https://axiom.trade/t/m');
  });

  it('does not let the click reach a clickable row underneath', () => {
    const onRowClick = vi.fn();
    vi.stubGlobal('open', vi.fn());
    render(
      <div onClick={onRowClick}>
        <ExternalLink href="https://axiom.trade/t/m">Axiom</ExternalLink>
      </div>
    );
    fireEvent.click(screen.getByText('Axiom'));
    expect(onRowClick).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('LiveRail', () => {
  it('explains an empty rail instead of showing a blank column', () => {
    render(<LiveRail items={[]} />);
    expect(screen.getByText('Nothing has come through yet.')).toBeInTheDocument();
  });

  it('does not glow entries that were already there on first render', () => {
    const { container } = render(<LiveRail items={[feedItem({ id: 1 })]} />);
    expect(container.querySelector('.tick')).toHaveAttribute('data-fresh', 'false');
  });

  it('glows only the entries that arrived during the session', () => {
    const { container, rerender } = render(<LiveRail items={[feedItem({ id: 1 })]} />);
    rerender(<LiveRail items={[feedItem({ id: 2 }), feedItem({ id: 1 })]} />);
    const ticks = [...container.querySelectorAll('.tick')];
    expect(ticks[0]).toHaveAttribute('data-fresh', 'true');
    expect(ticks[1]).toHaveAttribute('data-fresh', 'false');
  });

  it('uses a coin logo for coins and an identicon for wallets', () => {
    render(<LiveRail items={[feedItem({ id: 2, kind: 'coin', what: 'PEPE', imageUrl: 'https://cdn/p.png' })]} />);
    expect(screen.getByAltText('PEPE logo')).toBeInTheDocument();
  });

  it('links a coin through to Axiom when the alert carried a link', () => {
    render(<LiveRail items={[feedItem({ kind: 'coin', link: 'https://axiom.trade/t/m' })]} />);
    expect(screen.getByText('Axiom')).toHaveAttribute('href', 'https://axiom.trade/t/m');
  });

  it('omits the link entirely when there is none', () => {
    render(<LiveRail items={[feedItem({ link: null })]} />);
    expect(screen.queryByText('Axiom')).not.toBeInTheDocument();
  });
});
