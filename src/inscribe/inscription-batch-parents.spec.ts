/**
 * A batch with parents: the reveal topology, the envelopes, and the wallet
 * signature merge for several parent inputs. Byte-parity with `ord wallet
 * batch` and the on-chain provenance link are proven on regtest in
 * e2e/regtest/inscribe-batch-parity.spec.ts.
 */

import { describe, expect, it } from '@jest/globals';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { InscriptionParserService } from 'ordpool-parser';
import { firstValueFrom, of } from 'rxjs';

import { Network, toScureNetwork } from '../network';
import { childRevealParentIndexes, mergeParentSigAndBroadcast } from '../wallet/signers/child-reveal-finalize.helper';
import { operationNamedDefaults } from '../wallet/signers/operation-named-defaults';
import type { WalletSignerInternalImpls } from '../wallet/wallet.service.types';

import { createBatchChildInscribeTransactions } from './inscription-batch.helper';
import type { BatchParent, CreateBatchChildInscribeTransactionsArgs } from './inscription-batch.helper';

const NETWORK = Network.Mainnet;
const scureNetwork = toScureNetwork(NETWORK);
const PAYMENT_PRIV = new Uint8Array(32).fill(0xab);
const OWNER_PRIV = new Uint8Array(32).fill(0xef);
const enc = (s: string) => new TextEncoder().encode(s);
const owner = btc.p2tr(schnorr.getPublicKey(OWNER_PRIV), undefined, scureNetwork, true);

function parent(n: number, value: number): BatchParent {
  return {
    id: `${String(n).repeat(64)}i0`,
    utxo: {
      txid: String(n).repeat(64),
      vout: 0,
      value,
      scriptPubKey: owner.script,
      tapInternalKey: schnorr.getPublicKey(OWNER_PRIV),
    },
    returnAddress: owner.address!,
  };
}

function build(overrides: Partial<CreateBatchChildInscribeTransactionsArgs> = {}) {
  return createBatchChildInscribeTransactions({
    mode: 'separate-outputs',
    inscriptions: [
      { body: enc('child a'), contentType: 'text/plain' },
      { body: enc('child b'), contentType: 'text/plain' },
    ],
    parents: [parent(1, 546), parent(2, 2000)],
    postageSats: 600,
    recipientAddress: btc.p2tr(schnorr.getPublicKey(new Uint8Array(32).fill(0xcd)), undefined, scureNetwork, true).address!,
    paymentOutput: { txid: 'd'.repeat(64), vout: 0, value: 1_000_000, status: { confirmed: true } },
    paymentPublicKey: secp256k1.getPublicKey(PAYMENT_PRIV, true),
    paymentAddress: btc.p2tr(schnorr.getPublicKey(PAYMENT_PRIV), undefined, scureNetwork, true).address!,
    feeRatePerVbyte: 3,
    network: NETWORK,
    ...overrides,
  });
}

/** Sign every parent input on the wallet-facing PSBT, the way a wallet would. */
function walletSigns(psbt: Uint8Array, indexes: number[]): Uint8Array {
  const tx = btc.Transaction.fromPSBT(psbt);
  for (const i of indexes) tx.signIdx(OWNER_PRIV, i);
  return tx.toPSBT(0);
}

describe('createBatchChildInscribeTransactions', () => {
  it('spends the parents first and returns each at the same index with its own value', () => {
    const r = build();
    const reveal = btc.Transaction.fromPSBT(r.revealPsbt, { allowUnknownInputs: true });
    expect(reveal.inputsLength).toBe(3);
    expect([0, 1].map(i => hex.encode(reveal.getInput(i).txid!))).toEqual(['1'.repeat(64), '2'.repeat(64)]);
    const outputs = Array.from({ length: reveal.outputsLength }, (_, i) => Number(reveal.getOutput(i).amount));
    expect(outputs).toEqual([546, 2000, 600, 600]);
    expect(r.inscriptions.map(l => [l.vout, l.offset])).toEqual([[2, 0], [3, 0]]);
  });

  it('every envelope names both parents and points past the two parent outputs', () => {
    const r = build();
    const envelope = hex.encode(r.commit.envelopeScript);
    const parsed = InscriptionParserService.parse({
      txid: r.revealTxid,
      vin: [{ witness: ['00'.repeat(64), envelope, '00'] }],
    });
    expect(parsed.map(p => p.getParents())).toEqual([
      [parent(1, 546).id, parent(2, 2000).id],
      [parent(1, 546).id, parent(2, 2000).id],
    ]);
    // 546 + 2000 sats of parents, then one 600-sat output per child.
    expect(parsed.map(p => p.getPointer())).toEqual([2546, 3146]);
  });

  it('the merged reveal finalizes every parent input from the wallet and the commit input from the ephemeral key', async () => {
    const r = build();
    let wire = '';
    await firstValueFrom(mergeParentSigAndBroadcast(
      walletSigns(r.revealPsbtForWallet, [0, 1]),
      r.revealPsbt,
      (hexTx) => { wire = hexTx; return of('txid'); },
      2,
    ));
    const tx = btc.Transaction.fromRaw(hex.decode(wire), { allowUnknownInputs: true });
    expect(tx.id).toBe(r.revealTxid);
    expect([0, 1, 2].map(i => tx.getInput(i).finalScriptWitness!.length)).toEqual([1, 1, 3]);
  });

  it('merging fewer parent signatures than the reveal needs fails instead of broadcasting', () => {
    const r = build();
    // The wallet signed only input 0; the merge is asked for both.
    expect(() => mergeParentSigAndBroadcast(
      walletSigns(r.revealPsbtForWallet, [0]),
      r.revealPsbt,
      () => of('txid'),
      2,
    )).toThrow('wallet did not sign the parent input (index 1)');
  });

  it('refuses an empty parent list, pointing at the builder without parents', () => {
    expect(() => build({ parents: [] })).toThrow('use createBatchInscribeTransactions for a batch without parents');
  });
});

describe('child reveal parent signing', () => {
  it('parent indexes are 0..parentCount-1, one parent by default', () => {
    expect(childRevealParentIndexes(undefined)).toEqual([0]);
    expect(childRevealParentIndexes(3)).toEqual([0, 1, 2]);
    expect(() => childRevealParentIndexes(0)).toThrow('parentCount must be a positive integer');
  });

  it('the default signer asks the wallet for exactly the parent inputs at the ordinals address', async () => {
    const r = build();
    const requested: unknown[] = [];
    const legacy = {
      signPsbtOnly: (input: { signingMap: unknown }) => {
        requested.push(input.signingMap);
        return of(walletSigns(r.revealPsbtForWallet, [0, 1]));
      },
    } as unknown as WalletSignerInternalImpls;
    let wire = '';
    await firstValueFrom(operationNamedDefaults(legacy).signChildRevealParentInputs({
      psbtBytes: r.revealPsbtForWallet,
      finalizePsbtBytes: r.revealPsbt,
      ordinalsAddress: owner.address!,
      ordinalsPublicKey: hex.encode(schnorr.getPublicKey(OWNER_PRIV)),
      parentCount: 2,
      network: NETWORK,
      broadcast: (hexTx) => { wire = hexTx; return of('txid'); },
    }));
    expect(requested).toEqual([[{
      address: owner.address!,
      indexes: [0, 1],
      publicKey: hex.encode(schnorr.getPublicKey(OWNER_PRIV)),
    }]]);
    expect(btc.Transaction.fromRaw(hex.decode(wire), { allowUnknownInputs: true }).id).toBe(r.revealTxid);
  });
});
