import { Connection, PublicKey } from '@solana/web3.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

export class SolanaRpcClient {
  private connection: Connection;

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  async getBalanceSol(address: string): Promise<number> {
    const lamports = await this.connection.getBalance(new PublicKey(address));
    return lamports / LAMPORTS_PER_SOL;
  }
}
