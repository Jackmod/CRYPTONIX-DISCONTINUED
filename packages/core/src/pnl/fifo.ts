export interface Lot {
  solCost: number;
  tokenAmount: number;
}

export interface FifoOutcome {
  remainingLots: Lot[];
  realizedPnlSol: number;
  /**
   * Tokens sold that no tracked buy lot covered — the position predates our
   * backfill window, or the tokens arrived by airdrop/transfer rather than a
   * swap. Their proceeds are deliberately excluded from `realizedPnlSol`,
   * because we have no cost basis for them.
   */
  unmatchedTokenAmount: number;
}

export function applyFifo(lots: Lot[], sellTokenAmount: number, sellSolReceived: number): FifoOutcome {
  const remaining = lots.map((lot) => ({ ...lot }));
  let toSell = sellTokenAmount;
  let costBasisConsumed = 0;

  while (toSell > 0 && remaining.length > 0) {
    const lot = remaining[0];
    const unitCost = lot.solCost / lot.tokenAmount;

    if (lot.tokenAmount <= toSell) {
      costBasisConsumed += lot.solCost;
      toSell -= lot.tokenAmount;
      remaining.shift();
    } else {
      const consumedCost = unitCost * toSell;
      costBasisConsumed += consumedCost;
      lot.tokenAmount -= toSell;
      lot.solCost -= consumedCost;
      toSell = 0;
    }
  }

  // Count only the proceeds attributable to tokens we actually have a cost
  // basis for. Charging a full sale against a partial basis would report
  // phantom profit on any position that predates our data — which is every
  // position held before a wallet was first backfilled.
  const matchedTokenAmount = sellTokenAmount - toSell;
  const matchedProceeds =
    sellTokenAmount === 0 ? 0 : sellSolReceived * (matchedTokenAmount / sellTokenAmount);

  return {
    remainingLots: remaining,
    realizedPnlSol: matchedProceeds - costBasisConsumed,
    unmatchedTokenAmount: toSell,
  };
}
