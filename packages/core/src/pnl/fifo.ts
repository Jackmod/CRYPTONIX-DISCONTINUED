export interface Lot {
  solCost: number;
  tokenAmount: number;
}

export interface FifoOutcome {
  remainingLots: Lot[];
  realizedPnlSol: number;
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

  return { remainingLots: remaining, realizedPnlSol: sellSolReceived - costBasisConsumed };
}
