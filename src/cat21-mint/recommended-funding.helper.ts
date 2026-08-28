import * as btc from '@scure/btc-signer';

import { computePsbtVsize } from '../cat21-fee/compute-psbt-vsize.helper';
import { getDummyKeypair } from '../cat21-fee/dummy-keypair';
import { CAT21_POSTAGE_SATS } from '../cat21-protocol/cat21-postage';
import { Network, toScureNetwork } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { buildCat21MintPsbt } from './cat21-mint.helper';

/**
 * vsize of a canonical single-taproot-input CAT-21 mint (1 input, cat output
 * + change output), MEASURED from a real simulated PSBT via
 * `computePsbtVsize` — never a hardcoded vbyte constant (HQ "never guess
 * numbers" rule). The shape is deterministic, so we build + measure once and
 * cache. Taproot is the representative default (Xverse/Leather ordinals
 * addresses); the hint over- rather than under-funds on the ~11 vB smaller
 * native-segwit path, which is the safe direction for a funding floor.
 */
let cachedMintVsize: number | null = null;

function defaultMintVsize(): number {
  if (cachedMintVsize !== null) return cachedMintVsize;

  const scureNetwork = toScureNetwork(Network.Mainnet);
  const { dummyPublicKey, addressP2TR } = getDummyKeypair(scureNetwork);
  const xOnly = dummyPublicKey.slice(1, 33); // compressed pubkey → 32-byte x-only

  const { psbt } = buildCat21MintPsbt({
    walletType: KnownOrdinalWalletType.xverse, // any non-cat21wallet default (sequence only)
    network: Network.Mainnet,
    fundingInput: {
      txid: '00'.repeat(32),
      vout: 0,
      value: 100_000, // ample: yields a cat output + a change output (1-in, 2-out)
      scriptPubKey: btc.p2tr(xOnly, undefined, scureNetwork).script,
      tapInternalKey: xOnly,
    },
    destinations: { recipientAddress: addressP2TR, senderChangeAddress: addressP2TR },
    feeSats: 0,
  });

  cachedMintVsize = computePsbtVsize({ psbt, network: scureNetwork });
  return cachedMintVsize;
}

/**
 * Funding floor in sats for the empty-state hint in the mint flow: the cat
 * postage plus the miner fee for a representative mint at the given fee rate,
 * rounded up to the next 100 sat so the displayed number reads cleanly.
 *
 * The tx vsize is MEASURED from a simulated mint (`computePsbtVsize`), not a
 * hardcoded vbyte guess. The actual viable-UTXO check remains dynamic
 * per-PSBT in the mint orchestrator; this helper only keeps the user-facing
 * hint honest at the current fee rate.
 */
export function calculateRecommendedFundingSats(feeRatePerVb: number): number {
  return Math.ceil((CAT21_POSTAGE_SATS + defaultMintVsize() * feeRatePerVb) / 100) * 100;
}
