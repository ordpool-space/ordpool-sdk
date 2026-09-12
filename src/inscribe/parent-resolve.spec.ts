/**
 * @jest-environment node
 *
 * The ord responses mocked here are the real shape `ord.ordpool.space` returns
 * (captured 2026-09-12 for inscription #0): `/inscription/<id>` carries
 * `address`, `satpoint` and `value`; `/output/<outpoint>` carries `address`,
 * `value` and `script_pubkey`. Node env because the mocks build `Response`,
 * which jsdom does not provide. The live check is in
 * e2e/regtest/inscribe-batch-orchestrator.spec.ts.
 */

import { describe, expect, it } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';

import { Network } from '../network';
import { InscribeInputError } from './inscribe-errors';
import { batchParentFromInscriptionId } from './parent-resolve';

const priv = schnorr.utils.randomPrivateKey();
const xonly = schnorr.getPublicKey(priv);
const tr = btc.p2tr(xonly, undefined, btc.NETWORK, true);
const ADDR = tr.address!;

const PARENT_TXID = '717d25914a1191c30f4c1d709e3ec0e1fab79cc7bf92cd12a93bed68db63416a';
const PARENT_ID = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0';

function ord(over: { inscription?: object | 404; output?: object | 404 } = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/inscription/')
      ? over.inscription ?? {
          address: ADDR, satpoint: `${PARENT_TXID}:0:0`, value: 606,
          id: PARENT_ID, number: 0, content_type: 'image/png',
        }
      : over.output ?? {
          address: ADDR, value: 606, script_pubkey: hex.encode(tr.script),
          outpoint: `${PARENT_TXID}:0`, inscriptions: [PARENT_ID], spent: false,
        };
    if (body === 404) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

const opts = (fetchFn: typeof fetch) => ({
  ordBaseUrl: 'https://ord.example', ordinalsPublicKey: xonly, network: Network.Mainnet, fetchFn,
});

describe('batchParentFromInscriptionId', () => {
  it('resolves the id to the coin it sits on, with the keys the reveal signs with', async () => {
    const parent = await batchParentFromInscriptionId(PARENT_ID, opts(ord()));
    expect(parent.id).toBe(PARENT_ID);
    expect(parent.utxo.txid).toBe(PARENT_TXID);
    expect(parent.utxo.vout).toBe(0);
    expect(parent.utxo.value).toBe(606);
    expect(parent.returnAddress).toBe(ADDR);
    // Tweaked script, untweaked internal key: the pair that actually spends.
    expect(hex.encode(parent.utxo.scriptPubKey)).toBe(hex.encode(tr.script));
    expect(Array.from(parent.utxo.tapInternalKey)).toEqual(Array.from(xonly));
    expect(hex.encode(parent.utxo.scriptPubKey.slice(2))).not.toBe(hex.encode(xonly));
  });

  it('reads the vout from the satpoint, not from the first output', async () => {
    const parent = await batchParentFromInscriptionId(PARENT_ID, opts(ord({
      inscription: { address: ADDR, satpoint: `${PARENT_TXID}:3:0`, value: 606 },
    })));
    expect(parent.utxo.vout).toBe(3);
  });

  it('refuses a parent the wallet cannot sign for', async () => {
    const someoneElse = schnorr.getPublicKey(schnorr.utils.randomPrivateKey());
    await expect(batchParentFromInscriptionId(PARENT_ID, {
      ...opts(ord()), ordinalsPublicKey: someoneElse,
    })).rejects.toThrow(InscribeInputError);
    try {
      await batchParentFromInscriptionId(PARENT_ID, { ...opts(ord()), ordinalsPublicKey: someoneElse });
    } catch (err) {
      expect((err as InscribeInputError).code).toBe('parent-not-owned');
    }
  });

  it('refuses a parent that is not on a Taproot coin', async () => {
    const wpkh = btc.p2wpkh(secp256k1.getPublicKey(priv, true), btc.NETWORK);
    try {
      await batchParentFromInscriptionId(PARENT_ID, opts(ord({
        inscription: { address: wpkh.address!, satpoint: `${PARENT_TXID}:0:0`, value: 606 },
        output: { address: wpkh.address!, value: 606, script_pubkey: hex.encode(wpkh.script) },
      })));
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as InscribeInputError).code).toBe('parent-must-be-taproot');
    }
  });

  it('says so when ord does not know the inscription', async () => {
    try {
      await batchParentFromInscriptionId(PARENT_ID, opts(ord({ inscription: 404 })));
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as InscribeInputError).code).toBe('parent-not-found');
      expect((err as InscribeInputError).details.id).toBe(PARENT_ID);
    }
  });

  it('falls back to the inscription\'s own value when the output lookup fails', async () => {
    const parent = await batchParentFromInscriptionId(PARENT_ID, opts(ord({ output: 404 })));
    expect(parent.utxo.value).toBe(606);
    expect(parent.returnAddress).toBe(ADDR);
  });

  it('refuses a malformed id without asking ord', async () => {
    let asked = false;
    const fetchFn = (async () => { asked = true; return new Response('{}', { status: 200 }); }) as typeof fetch;
    await expect(batchParentFromInscriptionId('not-an-id', opts(fetchFn))).rejects.toThrow(/Invalid inscription id/);
    expect(asked).toBe(false);
  });
});
