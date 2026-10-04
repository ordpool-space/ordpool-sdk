/**
 * The inscribe broadcast against a real bitcoind behind electrs.
 *
 * The unit spec pins every branch of `broadcastCommitAndReveal` with the
 * answers it expects; this pins that the node really answers that way. The
 * claim that matters for money: a reveal the node refuses keeps the commit off
 * the network and the funding coin unspent. Bare `submitpackage` would have
 * kept the commit on its own, which is the reason the dry run exists.
 */
import { describe, expect, it, beforeAll } from '@jest/globals';
import { schnorr } from '@noble/curves/secp256k1';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { InscribeInputError } from '../../src/inscribe/inscribe-errors';
import { createInscribeTransactions } from '../../src/inscribe/inscription.service.helper';
import {
  broadcastCommitAndReveal,
  esploraInscribeTransport,
  packageState,
  type SignedCommitAndReveal,
} from '../../src/inscribe/inscribe-package-broadcast';
import { Network, toScureNetwork } from '../../src/network';
import {
  ELECTRS_URL,
  fundUninscribed,
  mineBlocks,
  rpc,
  waitForElectrsSync,
} from './regtest-helpers';

const scureRegtest = toScureNetwork(Network.Regtest);
const transport = esploraInscribeTransport([ELECTRS_URL]);

/** A funded inscribe whose commit is signed by the regtest wallet; nothing sent. */
async function signedInscribe(label: string) {
  const f = await fundUninscribed();
  const built = createInscribeTransactions({
    paymentOutput: { ...f.utxo, status: { confirmed: true } },
    paymentPublicKey: f.fundingPubkey,
    paymentAddress: f.fundingAddr,
    recipientAddress: btc.p2tr(schnorr.getPublicKey(schnorr.utils.randomPrivateKey()), undefined, scureRegtest, true).address!,
    body: new TextEncoder().encode(`package broadcast: ${label}`),
    contentType: 'text/plain;charset=utf-8',
    feeRatePerVbyte: 2,
    network: Network.Regtest,
  });
  const processed = JSON.parse(rpc(
    '-rpcwallet=ordpool-e2e', '-named', 'walletprocesspsbt',
    `psbt=${base64.encode(built.commitPsbt)}`, 'sign=true', 'finalize=true',
  )) as { complete: boolean; hex: string };
  expect(processed.complete).toBe(true);
  const pair: SignedCommitAndReveal = {
    commitHex: processed.hex,
    revealHex: built.revealHex,
    commitTxId: built.commitTxid,
    revealTxId: built.revealTxid,
    commitAddress: built.commitAddress,
    ephemeral: built.ephemeral,
  };
  return { f, built, pair };
}

/**
 * The reveal with one byte of its script-path signature flipped. The txid is
 * unchanged (witness data is not part of it); the node refuses it on the
 * signature check.
 */
function withBrokenSignature(revealHex: string): string {
  const tx = btc.Transaction.fromRaw(hex.decode(revealHex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  const sig = hex.encode(tx.getInput(0).finalScriptWitness![0]);
  const flipped = sig.slice(0, 2) === '00' ? `01${sig.slice(2)}` : `00${sig.slice(2)}`;
  expect(revealHex.split(sig).length).toBe(2); // the signature occurs exactly once
  return revealHex.replace(sig, flipped);
}

function inMempool(txid: string): boolean {
  return (JSON.parse(rpc('getrawmempool')) as string[]).includes(txid);
}

/** The funding coin as the node sees it, mempool included; '' once spent. */
function fundingCoin(f: { utxo: { txid: string; vout: number } }): string {
  return rpc('gettxout', f.utxo.txid, String(f.utxo.vout), 'true').trim();
}

describe('inscribe package broadcast on regtest (bitcoind behind electrs)', () => {
  beforeAll(async () => {
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
  });

  it('sends a valid commit and reveal together', async () => {
    const { pair } = await signedInscribe('valid');
    await broadcastCommitAndReveal(transport, pair);
    expect([inMempool(pair.commitTxId), inMempool(pair.revealTxId)]).toEqual([true, true]);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
  });

  it('keeps the commit off the network and the funding coin unspent when the node refuses the reveal', async () => {
    const { f, pair } = await signedInscribe('refused reveal');
    const before = fundingCoin(f);
    expect(JSON.parse(before).value).toBe(f.utxo.value / 1e8);

    const err = await broadcastCommitAndReveal(transport, { ...pair, revealHex: withBrokenSignature(pair.revealHex) }).catch(e => e);
    expect(err).toBeInstanceOf(InscribeInputError);
    expect((err as InscribeInputError).code).toBe('package-rejected');

    // The coin the commit would spend is exactly as it was: nothing was sent.
    expect(fundingCoin(f)).toBe(before);
  });

  it('bare submitpackage keeps the commit alone when it refuses the reveal, and the signed reveal can follow on its own', async () => {
    const { f, built, pair } = await signedInscribe('bare submitpackage');
    const outcomes = await transport.submitPackage([pair.commitHex, withBrokenSignature(pair.revealHex)]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].kind).toBe('result');
    expect(outcomes[0].kind === 'result' && outcomes[0].result.package_msg).toBe('transaction failed');
    expect(packageState(outcomes, pair.commitTxId, pair.revealTxId)).toBe('commit-only');

    // The commit is in the mempool on its own, paying exactly the commit fee.
    const entry = JSON.parse(rpc('getmempoolentry', pair.commitTxId)) as { fees: { base: number } };
    expect(Math.round(entry.fees.base * 1e8)).toBe(built.fees.commitFeeSats);
    expect(fundingCoin(f)).toBe('');

    // A retry now meets `txn-already-in-mempool` on the commit and finishes by
    // sending the valid reveal alone.
    await broadcastCommitAndReveal(transport, pair);
    expect(inMempool(pair.revealTxId)).toBe(true);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
  });
});
