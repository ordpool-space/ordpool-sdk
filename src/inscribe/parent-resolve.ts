import type { BatchParent } from './inscription-batch.helper';
import { encodeInscriptionId } from './inscription-envelope';
import { failInscribe } from './inscribe-errors';
import type { Network } from '../network';
import type { OrdOutputResponse } from '../cat21-mint/utxo-content.types';
import { deriveOwnedTaprootInput } from './taproot-owned-input';

/**
 * Turning a parent inscription's id into the input a child's reveal spends.
 *
 * A batch names its parents by id, but the reveal has to spend the coin each
 * parent currently sits on and hand it straight back. Finding that coin means
 * asking ord where the inscription is now, then deriving the same
 * tweaked-script / untweaked-internal-key pair a sat source needs. Both halves
 * are easy to get subtly wrong and are worth testing once here.
 */

/** The subset of ord's `/inscription/<id>` this reads. */
interface OrdInscriptionResponse {
  /** Where the inscription sits now, `<txid>:<vout>:<offset>`. */
  satpoint?: string;
  /** The address holding it. */
  address?: string;
  /** Sats in the coin holding it; the parent returns with exactly this value. */
  value?: number;
}

export interface ResolveParentOptions {
  /** Base URL of an ord server with the JSON API. */
  ordBaseUrl: string;
  /** The connected wallet's ordinals public key, hex or bytes, x-only or compressed. */
  ordinalsPublicKey: string | Uint8Array;
  network: Network;
  /** Per-request timeout. Default 10 000 ms. */
  timeoutMs?: number;
  /** The fetch to use. Default the global `fetch`. */
  fetchFn?: typeof fetch;
}

/**
 * Resolve a parent inscription id to the {@link BatchParent} a batch takes.
 *
 * Asks ord where the inscription is (`GET /inscription/<id>`), reads the coin
 * it sits on (`GET /output/<outpoint>`), and derives the script and internal
 * key from the wallet's ordinals key, refusing when that key does not own the
 * coin: the reveal has to spend the parent, so a parent the wallet cannot sign
 * for is a batch that can never be broadcast, and saying so here beats
 * discovering it after someone has approved a commit.
 *
 * The parent returns to the address it was found at, which is ord's own
 * behaviour for `wallet batch` with parents.
 */
export async function batchParentFromInscriptionId(
  id: string,
  options: ResolveParentOptions,
): Promise<BatchParent> {
  encodeInscriptionId(id); // throws `invalid-inscription-id` on a malformed one
  const base = options.ordBaseUrl.replace(/\/+$/, '');
  const get = async <T>(path: string): Promise<T | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    try {
      const res = await (options.fetchFn ?? fetch)(`${base}${path}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const inscription = await get<OrdInscriptionResponse>(`/inscription/${id}`);
  if (inscription === null || inscription.satpoint === undefined || inscription.address === undefined) {
    failInscribe('parent-not-found',
      `ord did not resolve parent inscription ${id}`,
      'That parent inscription could not be found. Check the id, or try again if the explorer is busy.',
      { id });
  }
  const [txid, voutText] = inscription.satpoint.split(':');
  const vout = Number(voutText);
  if (txid === undefined || !Number.isInteger(vout)) {
    failInscribe('parent-not-found',
      `ord returned an unreadable satpoint for ${id}: ${inscription.satpoint}`,
      'That parent inscription could not be located.',
      { id, satpoint: inscription.satpoint });
  }

  const output = await get<OrdOutputResponse & { value?: number }>(`/output/${txid}:${vout}`);
  const value = output?.value ?? inscription.value;
  if (value === undefined) {
    failInscribe('parent-not-found',
      `ord did not report a value for the coin holding ${id}`,
      'That parent inscription could not be located.',
      { id, outpoint: `${txid}:${vout}` });
  }

  const address = output?.address ?? inscription.address;
  const { scriptPubKey, tapInternalKey } = deriveOwnedTaprootInput(
    address, options.ordinalsPublicKey, options.network,
    { notTaproot: 'parent-must-be-taproot', notOwned: 'parent-not-owned' },
    'That parent inscription is not in your wallet, so your wallet cannot sign for it.',
  );

  return {
    id,
    utxo: { txid, vout, value, scriptPubKey, tapInternalKey },
    returnAddress: address,
  };
}
