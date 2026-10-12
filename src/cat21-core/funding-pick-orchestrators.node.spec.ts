/**
 * @test-kind unit
 * Real:   InscribeMintOrchestrator, Cat21MintOrchestrator, selectFunding, recommendFunding, resolveFundingPick,
 *         the commit / reveal and mint builders, the watch-only (xpub) signer, broadcastCommitAndReveal
 * Faked:  the orchestrators' getUtxos / scan / broadcast deps, answering in the ports' own declared types
 *         (`TxnOutput`, `UtxoClassification` with a naming detail); the inscribe transport is
 *         recordingInscribeTransport (ordpool-sdk/testing); the person pasting a signed PSBT back is a
 *         promptForSignedPsbt that signs with the test key
 * Proves: on a separate-payment-address wallet whose only covering coin carries NAMED assets
 *         (`asset-notice`, an enabled CTA), mint() spends that recommended coin: it is signed and broadcast.
 *         On a one-address wallet the same pool throws FundingBlockedError and nothing is signed or sent.
 */
import { describe, expect, it } from '@jest/globals';
import { secp256k1 } from '@noble/curves/secp256k1';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network } from '../network.js';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types.js';
import { TxnOutput } from '../cat21-mint/cat21.service.types.js';
import { recordingInscribeTransport } from '../testing/inscribe-transport.js';
import { FundingBlockedError } from '../cat21-fee/funding-blocked-error.js';
import { InscribeMintOrchestrator, InscribeSnapshot } from '../inscribe/inscribe-mint-orchestrator.js';
import { Cat21MintOrchestrator, MintSnapshot } from '../cat21-mint/cat21-mint-orchestrator.js';
import { UtxoAssetDetail, UtxoClassification } from './ports.js';

const PAYMENT_PRIV = new Uint8Array(32).fill(0xab);
const PAYMENT_PUB = secp256k1.getPublicKey(PAYMENT_PRIV, true);
const PAYMENT_ADDR = btc.p2wpkh(PAYMENT_PUB, btc.NETWORK).address!;
const ORDINALS_XONLY = '5df12ac222a1cd78dd4681c7c7a56f3e273884a086b2b6100957d20c73be3c37';
const ORDINALS_ADDR = btc.p2tr(hex.decode(ORDINALS_XONLY), undefined, btc.NETWORK).address!;

/** The only coin in the wallet: it covers, and its scan names an inscription. */
const ASSET_COIN: TxnOutput = { txid: 'd'.repeat(64), vout: 2, status: { confirmed: true }, value: 100_000 };
const NAMED_DETAIL: UtxoAssetDetail = { inscriptionIds: ['abc123i0'], runeNames: [], catIds: [], rareSat: null };
const NAMED: UtxoClassification = { verdict: 'has-assets', assets: NAMED_DETAIL };
const scan = { classify: async (): Promise<UtxoClassification> => NAMED };

/** Separate payment address, or the payment address doubling as the ordinals address. */
const walletFor = (layout: 'separate' | 'one-address') => ({
  type: KnownOrdinalWalletType.xpub,
  ordinalsAddress: layout === 'separate' ? ORDINALS_ADDR : PAYMENT_ADDR,
  paymentAddress: PAYMENT_ADDR,
  paymentPublicKey: hex.encode(PAYMENT_PUB),
});

/** A person signing in their own wallet and pasting the PSBT back. */
function signingPrompt(): { prompt: (u: { base64: string; hex: string }) => Promise<string>; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    prompt: async (unsigned) => {
      seen.push(unsigned.base64);
      const psbt = btc.Transaction.fromPSBT(base64.decode(unsigned.base64));
      psbt.signIdx(PAYMENT_PRIV, 0, [btc.SigHash.ALL]);
      psbt.finalize();
      return base64.encode(psbt.toPSBT(0));
    },
  };
}

function settled<S>(o: { subscribe(fn: (s: S) => void): () => void }, pred: (s: S) => boolean): Promise<S> {
  return new Promise((resolve) => {
    let unsub: () => void = () => {};
    unsub = o.subscribe((snap) => {
      if (pred(snap)) {
        unsub();
        resolve(snap);
      }
    });
  });
}

const spentOutpoint = (txHex: string) => {
  const tx = btc.Transaction.fromRaw(hex.decode(txHex));
  const input = tx.getInput(0);
  return { txid: input.txid ? hex.encode(input.txid) : null, vout: input.index ?? null, inputs: tx.inputsLength };
};

describe('InscribeMintOrchestrator.mint spends the recommended coin on asset-notice', () => {
  const inscribeOrchestrator = (layout: 'separate' | 'one-address') => {
    const transport = recordingInscribeTransport();
    const o = new InscribeMintOrchestrator({
      getUtxos: async () => [ASSET_COIN],
      scan,
      transport,
      network: Network.Mainnet,
      fundingTopology: 'derive',
    });
    return { o, transport, wallet: walletFor(layout) };
  };

  it('separate payment address: the named-asset coin is signed and package-broadcast', async () => {
    const { o, transport, wallet } = inscribeOrchestrator('separate');
    await o.setWallet(wallet);
    o.setContent({ source: { kind: 'file', body: new TextEncoder().encode('hello cat'), contentType: 'text/plain' } });
    o.setFeeRate(10);
    const snap = await settled<InscribeSnapshot>(o, (s) => s.resolvedFundingStatus === 'asset-notice');
    expect(snap.fundingRecommendation.status).toBe('asset-notice');

    const signer = signingPrompt();
    const result = await o.mint(signer.prompt);

    expect(signer.seen).toHaveLength(1);
    expect(transport.calls).toEqual(['testPackage', 'submitPackage']);
    expect(transport.submitted).toHaveLength(2);
    expect(spentOutpoint(transport.submitted[0])).toEqual({ txid: ASSET_COIN.txid, vout: 2, inputs: 1 });
    expect(btc.Transaction.fromRaw(hex.decode(transport.submitted[0])).id).toBe(result.commitTxId);
    expect(o.getSnapshot().state).toBe('success');
  });

  it('one address for everything: FundingBlockedError, nothing signed, nothing sent', async () => {
    const { o, transport, wallet } = inscribeOrchestrator('one-address');
    await o.setWallet(wallet);
    o.setContent({ source: { kind: 'file', body: new TextEncoder().encode('hello cat'), contentType: 'text/plain' } });
    o.setFeeRate(10);
    await settled<InscribeSnapshot>(o, (s) => s.resolvedFundingStatus === 'expert-required');

    const signer = signingPrompt();
    const err: unknown = await o.mint(signer.prompt).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(FundingBlockedError);
    expect(err instanceof FundingBlockedError ? [err.cause, err.recommendation.recommended] : null).toEqual([
      'named-assets',
      { txid: ASSET_COIN.txid, vout: 2, value: 100_000, bucket: 'assets', assets: NAMED_DETAIL },
    ]);
    expect({ prompts: signer.seen, calls: transport.calls }).toEqual({ prompts: [], calls: [] });
  });
});

describe('Cat21MintOrchestrator.mint spends the recommended coin on asset-notice', () => {
  const mintOrchestrator = (layout: 'separate' | 'one-address') => {
    const broadcast: string[] = [];
    const o = new Cat21MintOrchestrator({
      getUtxos: async () => [ASSET_COIN],
      scan,
      broadcast: async (h) => { broadcast.push(h); return btc.Transaction.fromRaw(hex.decode(h)).id; },
      network: Network.Mainnet,
      fundingTopology: 'derive',
    });
    return { o, broadcast, wallet: walletFor(layout) };
  };

  it('separate payment address: the named-asset coin is signed and broadcast', async () => {
    const { o, broadcast, wallet } = mintOrchestrator('separate');
    await o.setWallet(wallet);
    o.setFeeRate(10);
    const snap = await settled<MintSnapshot>(o, (s) => s.resolvedFundingStatus === 'asset-notice');
    expect(snap.fundingRecommendation.status).toBe('asset-notice');

    const signer = signingPrompt();
    const { txId } = await o.mint(signer.prompt);

    expect(signer.seen).toHaveLength(1);
    expect(broadcast).toHaveLength(1);
    expect(spentOutpoint(broadcast[0])).toEqual({ txid: ASSET_COIN.txid, vout: 2, inputs: 1 });
    expect(btc.Transaction.fromRaw(hex.decode(broadcast[0])).id).toBe(txId);
    expect(o.getSnapshot().state).toBe('success');
  });

  it('one address for everything: FundingBlockedError, nothing signed, nothing broadcast', async () => {
    const { o, broadcast, wallet } = mintOrchestrator('one-address');
    await o.setWallet(wallet);
    o.setFeeRate(10);
    await settled<MintSnapshot>(o, (s) => s.resolvedFundingStatus === 'expert-required');

    const signer = signingPrompt();
    const err: unknown = await o.mint(signer.prompt).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(FundingBlockedError);
    expect(err instanceof FundingBlockedError ? [err.cause, err.recommendation.recommended] : null).toEqual([
      'named-assets',
      { txid: ASSET_COIN.txid, vout: 2, value: 100_000, bucket: 'assets', assets: NAMED_DETAIL },
    ]);
    expect({ prompts: signer.seen, broadcast }).toEqual({ prompts: [], broadcast: [] });
  });
});
