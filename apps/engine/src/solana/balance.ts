import { Connection, PublicKey } from '@solana/web3.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

export class SolanaRpcClient {
  private connection: Connection;

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  async getBalanceSol(address: string): Promise<number> {
    let lamports: number;
    try {
      lamports = await this.connection.getBalance(new PublicKey(address));
    } catch (err) {
      // web3.js puts the full request URL — which carries our Helius API key
      // as a query param — into the error message. server.ts's asyncRoute
      // console.errors the whole error object on any route failure, so
      // letting the original error escape would write the key to logs on
      // every RPC timeout. Never let that reach a log.
      throw new Error(`solana rpc getBalance failed for ${address}`);
    }
    return lamports / LAMPORTS_PER_SOL;
  }
}
