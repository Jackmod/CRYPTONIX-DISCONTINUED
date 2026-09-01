import { PublicKey } from '@solana/web3.js';

/**
 * True only for a well-formed Solana public key.
 *
 * A regex over the base58 alphabet is not enough: a 25-character base58 string
 * passes any length check but decodes to far fewer than 32 bytes. PublicKey
 * does the real decode, and it is already a dependency here.
 *
 * This matters because trackWallet registers a Helius webhook before anything
 * else. An unvalidated address consumes one of the free tier's address slots
 * permanently and then never fires, so the wallet looks tracked but is silent.
 */
export function isValidSolanaAddress(address: string): boolean {
  try {
    // PublicKey accepts some inputs that are not on the ed25519 curve (program
    // derived addresses are legitimately off-curve), so length/decode validity
    // is the right bar here, not on-curve-ness.
    return new PublicKey(address).toBase58() === address;
  } catch {
    return false;
  }
}
