import { describe, it, expect } from 'vitest';
import { applyFifo, type Lot } from './fifo';

describe('applyFifo', () => {
  it('consumes a single lot fully and computes profit', () => {
    const lots: Lot[] = [{ solCost: 2, tokenAmount: 1000 }];
    const { remainingLots, realizedPnlSol } = applyFifo(lots, 1000, 3);
    expect(remainingLots).toEqual([]);
    expect(realizedPnlSol).toBeCloseTo(1); // sold for 3, cost was 2
  });

  it('partially consumes a lot, leaving the remainder', () => {
    const lots: Lot[] = [{ solCost: 4, tokenAmount: 1000 }];
    const { remainingLots, realizedPnlSol } = applyFifo(lots, 250, 1.5);
    expect(remainingLots).toEqual([{ solCost: 3, tokenAmount: 750 }]);
    expect(realizedPnlSol).toBeCloseTo(0.5); // cost of 250 tokens = 1, sold for 1.5
  });

  it('consumes across multiple lots oldest-first', () => {
    const lots: Lot[] = [
      { solCost: 1, tokenAmount: 100 }, // unit cost 0.01
      { solCost: 3, tokenAmount: 100 }, // unit cost 0.03
    ];
    const { remainingLots, realizedPnlSol } = applyFifo(lots, 150, 2);
    // consumes all of lot 1 (cost 1) + half of lot 2 (cost 1.5) = cost basis 2.5
    expect(remainingLots).toEqual([{ solCost: 1.5, tokenAmount: 50 }]);
    expect(realizedPnlSol).toBeCloseTo(-0.5);
  });

  it('does not mutate the input lots array', () => {
    const lots: Lot[] = [{ solCost: 2, tokenAmount: 1000 }];
    applyFifo(lots, 500, 1);
    expect(lots).toEqual([{ solCost: 2, tokenAmount: 1000 }]);
  });
});
