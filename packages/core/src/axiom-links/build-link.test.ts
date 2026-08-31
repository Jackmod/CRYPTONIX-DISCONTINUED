import { describe, it, expect } from 'vitest';
import { buildAxiomLink } from './build-link';

describe('buildAxiomLink', () => {
  it('builds an axiom.trade link from a mint address', () => {
    expect(buildAxiomLink('So11111111111111111111111111111111111111112'))
      .toBe('https://axiom.trade/t/So11111111111111111111111111111111111111112');
  });
});
