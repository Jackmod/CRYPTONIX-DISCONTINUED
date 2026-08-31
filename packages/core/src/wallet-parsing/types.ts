export interface HeliusTokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  mint: string;
  tokenAmount: number;
}

export interface HeliusNativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number; // lamports
}

export interface HeliusEnhancedTransaction {
  signature: string;
  timestamp: number; // unix seconds
  type: string;
  tokenTransfers: HeliusTokenTransfer[];
  nativeTransfers: HeliusNativeTransfer[];
}

export interface ParsedSwap {
  signature: string;
  ts: Date;
  mint: string;
  side: 'buy' | 'sell';
  solAmount: number;
  tokenAmount: number;
}
