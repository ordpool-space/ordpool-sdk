/**
 * `satOffset`: the padding output ord puts in front of a chosen sat. That the
 * inscription lands on the chosen sat is proven through stock ord's sat index
 * on regtest (e2e/regtest/inscribe-satpoint-parity.spec.ts); these pin the
 * commit layout and the refusals.
 */

import { describe, expect, it } from '@jest/globals';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network, toScureNetwork } from '../network';

import { createInscribeTransactions } from './inscription.service.helper';
import type { CreateInscribeTransactionsArgs } from './inscription.service.helper';

const NETWORK = Network.Mainnet;
const scureNetwork = toScureNetwork(NETWORK);
const PAYMENT_PRIV = new Uint8Array(32).fill(0xab);
const paymentAddress = btc.p2tr(schnorr.getPublicKey(PAYMENT_PRIV), undefined, scureNetwork, true).address!;

function build(overrides: Partial<CreateInscribeTransactionsArgs>) {
  return createInscribeTransactions({
    paymentOutput: { txid: 'd'.repeat(64), vout: 0, value: 100_000, status: { confirmed: true } },
    paymentPublicKey: secp256k1.getPublicKey(PAYMENT_PRIV, true),
    paymentAddress,
    recipientAddress: btc.p2tr(schnorr.getPublicKey(new Uint8Array(32).fill(0xcd)), undefined, scureNetwork, true).address!,
    body: new TextEncoder().encode('onto a chosen sat'),
    contentType: 'text/plain',
    feeRatePerVbyte: 3,
    network: NETWORK,
    ...overrides,
  });
}

function outputs(psbt: Uint8Array): Array<[string, number]> {
  const tx = btc.Transaction.fromPSBT(psbt);
  return Array.from({ length: tx.outputsLength }, (_, i) => {
    const o = tx.getOutput(i);
    return [hex.encode(o.script!), Number(o.amount)];
  });
}

describe('satOffset', () => {
  it('puts a padding output of exactly the offset first, to the payment address, then the commit output', () => {
    const r = build({ satOffset: 5_000 });
    const outs = outputs(r.commitPsbt);
    const paymentScript = hex.encode(btc.OutScript.encode(btc.Address(scureNetwork).decode(paymentAddress)));
    expect(outs[0]).toEqual([paymentScript, 5_000]);
    expect(outs[1]).toEqual([hex.encode(r.commit.outputScript), r.commit.outputValueSats]);
    // The funding covers the padding too.
    expect(r.fees.fundingRequirementSats).toBe(5_000 + r.fees.commitOutputValueSats + r.fees.commitFeeSats);
  });

  it('the reveal spends the commit output at vout 1', () => {
    const r = build({ satOffset: 5_000 });
    const reveal = btc.Transaction.fromRaw(hex.decode(r.revealHex));
    expect(hex.encode(reveal.getInput(0).txid!)).toBe(r.commitTxid);
    expect(reveal.getInput(0).index).toBe(1);
  });

  it('offset 0 is the funding input\'s first sat: no padding output, commit output at vout 0', () => {
    const r = build({ satOffset: 0 });
    expect(outputs(r.commitPsbt)[0]).toEqual([hex.encode(r.commit.outputScript), r.commit.outputValueSats]);
    expect(btc.Transaction.fromRaw(hex.decode(r.revealHex)).getInput(0).index).toBe(0);
  });

  it('refuses a padding output below the payment address\'s dust limit', () => {
    expect(() => build({ satOffset: 100 })).toThrow(/satOffset 100 would make a padding output below the 330-sat dust limit/);
  });

  it('refuses an offset outside the funding input', () => {
    expect(() => build({ satOffset: 100_000 })).toThrow('satOffset 100000 is outside the 100000-sat funding input');
  });

  it('a batch takes satOffset only in same-sat mode, as ord takes sat / satpoint only there', async () => {
    const { createBatchInscribeTransactions } = await import('./inscription-batch.helper');
    const args = {
      inscriptions: [{ body: new TextEncoder().encode('x'), contentType: 'text/plain' }],
      recipientAddress: paymentAddress,
      paymentOutput: { txid: 'd'.repeat(64), vout: 0, value: 100_000, status: { confirmed: true } },
      paymentPublicKey: secp256k1.getPublicKey(PAYMENT_PRIV, true),
      paymentAddress,
      feeRatePerVbyte: 3,
      network: NETWORK,
      satOffset: 5_000,
    };
    expect(() => createBatchInscribeTransactions({ ...args, mode: 'separate-outputs' }))
      .toThrow('`satOffset` can only be set in `same-sat` mode');
    const r = createBatchInscribeTransactions({ ...args, mode: 'same-sat' });
    expect(outputs(r.commitPsbt)[0][1]).toBe(5_000);
  });
});

describe('satSource', () => {
  const OWNER_PRIV = new Uint8Array(32).fill(0xef);
  const owner = btc.p2tr(schnorr.getPublicKey(OWNER_PRIV), undefined, scureNetwork, true);
  const source = (value: number, offset: number) => ({
    txid: 'e'.repeat(64), vout: 0, value, scriptPubKey: owner.script,
    tapInternalKey: schnorr.getPublicKey(OWNER_PRIV), address: owner.address!, offset,
  });

  it('spends the sat\'s UTXO first; padding and remainder return to its address, the funding pays only the fee', () => {
    const r = build({ satSource: source(20_000, 5_000) });
    const commit = btc.Transaction.fromPSBT(r.commitPsbt);
    expect(hex.encode(commit.getInput(0).txid!)).toBe('e'.repeat(64));
    expect(hex.encode(commit.getInput(1).txid!)).toBe('d'.repeat(64));
    const outs = outputs(r.commitPsbt);
    const ownerScript = hex.encode(owner.script);
    expect(outs[0]).toEqual([ownerScript, 5_000]);
    expect(outs[1]).toEqual([hex.encode(r.commit.outputScript), r.commit.outputValueSats]);
    expect(outs[2]).toEqual([ownerScript, 20_000 - 5_000 - r.commit.outputValueSats]);
    expect(r.fees.fundingRequirementSats).toBe(r.fees.commitFeeSats);
  });

  it('a remainder below the owner address\'s dust limit becomes postage: no remainder output, a bigger inscription output', () => {
    // Size the UTXO so 100 sats (below P2TR's 330) would remain.
    const probe = build({ satSource: source(1_000_000, 0) });
    const r = build({ satSource: source(probe.commit.outputValueSats + 100, 0) });
    const outs = outputs(r.commitPsbt);
    expect(outs[0][1]).toBe(probe.commit.outputValueSats + 100); // the commit output takes it all
    expect(outs.some(([script]) => script === hex.encode(owner.script))).toBe(false);
    const reveal = btc.Transaction.fromRaw(hex.decode(r.revealHex));
    expect(Number(reveal.getOutput(0).amount)).toBe(546 + 100);
  });

  it('refuses satOffset and satSource together', () => {
    expect(() => build({ satOffset: 1_000, satSource: source(20_000, 0) }))
      .toThrow('pass satOffset (a sat in the funding UTXO) or satSource, not both');
  });

  it('the orchestrator has the wallet sign the commit as a transfer: the sat\'s UTXO at 0, the funding at 1', async () => {
    const { inscribeAndBroadcast } = await import('./inscribe-orchestrator');
    const { KnownOrdinalWalletType } = await import('../wallet/wallet.service.types');
    const { base64 } = await import('@scure/base');
    const { firstValueFrom, of } = await import('rxjs');
    const handed: string[][] = [];
    const broadcasts: string[] = [];
    const result = await firstValueFrom(inscribeAndBroadcast({
      walletType: KnownOrdinalWalletType.xpub,
      paymentOutput: { txid: 'd'.repeat(64), vout: 0, value: 100_000, status: { confirmed: true } },
      paymentPublicKey: secp256k1.getPublicKey(PAYMENT_PRIV, true),
      paymentAddress,
      recipientAddress: owner.address!,
      body: new TextEncoder().encode('rare'),
      contentType: 'text/plain',
      satSource: source(20_000, 5_000),
      feeRatePerVbyte: 3,
      network: NETWORK,
      broadcast: (txHex: string) => { broadcasts.push(txHex); return of(btc.Transaction.fromRaw(hex.decode(txHex)).id); },
      promptForSignedPsbt: (unsigned: { base64: string }) => {
        const psbt = btc.Transaction.fromPSBT(base64.decode(unsigned.base64));
        // What the wallet is handed: the sat's UTXO at 0, the funding at 1.
        handed.push([0, 1].map(i => hex.encode(psbt.getInput(i).txid!)));
        psbt.signIdx(OWNER_PRIV, 0);
        psbt.signIdx(PAYMENT_PRIV, 1);
        psbt.finalize();
        return of(base64.encode(psbt.toPSBT(0)));
      },
    }));
    expect(handed).toEqual([['e'.repeat(64), 'd'.repeat(64)]]);
    const commit = btc.Transaction.fromRaw(hex.decode(broadcasts[0]));
    expect(commit.id).toBe(result.commitTxId);
    expect(commit.inputsLength).toBe(2);
    expect(btc.Transaction.fromRaw(hex.decode(broadcasts[1])).id).toBe(result.revealTxId);
  });
});

describe('paddingUtxo', () => {
  const pad = { txid: 'f'.repeat(64), vout: 0, value: 1_000, status: { confirmed: true } };

  it('spends the padding input first; the padding output is its value plus the offset', () => {
    const r = build({ satOffset: 100, paddingUtxo: pad });
    const commit = btc.Transaction.fromPSBT(r.commitPsbt);
    expect([0, 1].map(i => hex.encode(commit.getInput(i).txid!))).toEqual(['f'.repeat(64), 'd'.repeat(64)]);
    const outs = outputs(r.commitPsbt);
    expect(outs[0][1]).toBe(1_100);
    expect(outs[1]).toEqual([hex.encode(r.commit.outputScript), r.commit.outputValueSats]);
    expect(btc.Transaction.fromRaw(hex.decode(r.revealHex)).getInput(0).index).toBe(1);
  });

  it('is refused when the padding would clear dust anyway, since ord pads only a sub-dust padding output', () => {
    expect(() => build({ satOffset: 5_000, paddingUtxo: pad }))
      .toThrow('paddingInput is only for a chosen sat less than a dust limit into its UTXO');
    expect(() => build({ satOffset: 0, paddingUtxo: pad }))
      .toThrow('paddingInput is only for a chosen sat less than a dust limit into its UTXO');
  });

  it('without one, a sub-dust offset names how much padding it needs', () => {
    expect(() => build({ satOffset: 100 })).toThrow('pass a paddingInput of at least 230 sats');
  });

  it('the signing positions: payment 0 and 1; with a satSource, payment 0 and 2 and ordinals 1', async () => {
    const { paddedSatCommitSigningPositions } = await import('../wallet/wallet.service.types');
    expect(paddedSatCommitSigningPositions({ paymentAddress: 'pay' })).toEqual([{ address: 'pay', indexes: [0, 1] }]);
    expect(paddedSatCommitSigningPositions({ paymentAddress: 'pay', ordinalsAddress: 'ord' }))
      .toEqual([{ address: 'pay', indexes: [0, 2] }, { address: 'ord', indexes: [1] }]);
  });

  it('the orchestrator hands the wallet the padded commit: padding at 0, the funding holding the sat at 1', async () => {
    const { inscribeAndBroadcast } = await import('./inscribe-orchestrator');
    const { KnownOrdinalWalletType } = await import('../wallet/wallet.service.types');
    const { base64 } = await import('@scure/base');
    const { firstValueFrom, of } = await import('rxjs');
    const handed: string[][] = [];
    const broadcasts: string[] = [];
    const result = await firstValueFrom(inscribeAndBroadcast({
      walletType: KnownOrdinalWalletType.xpub,
      paymentOutput: { txid: 'd'.repeat(64), vout: 0, value: 100_000, status: { confirmed: true } },
      paymentPublicKey: secp256k1.getPublicKey(PAYMENT_PRIV, true),
      paymentAddress,
      recipientAddress: paymentAddress,
      body: new TextEncoder().encode('padded'),
      contentType: 'text/plain',
      satOffset: 100,
      paddingUtxo: pad,
      feeRatePerVbyte: 3,
      network: NETWORK,
      broadcast: (txHex: string) => { broadcasts.push(txHex); return of(btc.Transaction.fromRaw(hex.decode(txHex)).id); },
      promptForSignedPsbt: (unsigned: { base64: string }) => {
        const psbt = btc.Transaction.fromPSBT(base64.decode(unsigned.base64));
        handed.push([0, 1].map(i => hex.encode(psbt.getInput(i).txid!)));
        psbt.signIdx(PAYMENT_PRIV, 0);
        psbt.signIdx(PAYMENT_PRIV, 1);
        psbt.finalize();
        return of(base64.encode(psbt.toPSBT(0)));
      },
    }));
    expect(handed).toEqual([['f'.repeat(64), 'd'.repeat(64)]]);
    expect(btc.Transaction.fromRaw(hex.decode(broadcasts[0])).id).toBe(result.commitTxId);
    expect(btc.Transaction.fromRaw(hex.decode(broadcasts[1])).id).toBe(result.revealTxId);
  });
});
