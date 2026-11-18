/**
 * What a wallet fee bump does to an inscribe built for cat21wallet.
 *
 * `buildInscribeCommitPsbt` resolves the commit's input sequence through
 * `resolveCat21MintInputSequence`, which gives cat21wallet `0xfffffffd`, so the
 * commit signals RBF. This spec answers, against a real bitcoind behind
 * electrs, what a fee bump of that commit does to the reveal that was signed
 * against it:
 *
 * - the bumped commit (same funding input, same commit output, smaller change)
 *   replaces the original in the mempool and evicts the reveal with it;
 * - the pre-signed reveal no longer has an input: the node refuses it;
 * - the commit output is unchanged, so a reveal re-signed with the ephemeral
 *   key against the NEW commit txid is accepted. The bump does not lock the
 *   postage, but recovering it needs the ephemeral key.
 *
 * Real: bitcoind, electrs, the SDK's commit and reveal builders.
 */
import { describe, expect, it, beforeAll } from '@jest/globals';
import { schnorr } from '@noble/curves/secp256k1';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { createInscribeTransactions } from '../../src/inscribe/inscription.service.helper';
import {
  broadcastCommitAndReveal,
  esploraInscribeTransport,
} from '../../src/inscribe/inscribe-package-broadcast';
import { CAT21_WALLET_INPUT_SEQUENCE } from '../../src/cat21-protocol/cat21-sequence';
import { Network, toScureNetwork } from '../../src/network';
import { KnownOrdinalWalletType } from '../../src/wallet/wallet.service.types';
import {
  ELECTRS_URL,
  fundUninscribed,
  mineBlocks,
  rpc,
  waitForElectrsSync,
} from './regtest-helpers';

const scureRegtest = toScureNetwork(Network.Regtest);
const transport = esploraInscribeTransport([ELECTRS_URL]);
const PARSE = { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true } as const;

function inMempool(txid: string): boolean {
  return (JSON.parse(rpc('getrawmempool')) as string[]).includes(txid);
}

function walletSign(psbt: Uint8Array): string {
  const processed = JSON.parse(rpc(
    '-rpcwallet=ordpool-e2e', '-named', 'walletprocesspsbt',
    `psbt=${base64.encode(psbt)}`, 'sign=true', 'finalize=true',
  )) as { complete: boolean; hex: string };
  expect(processed.complete).toBe(true);
  return processed.hex;
}

function testAccept(txHex: string): { allowed: boolean; 'reject-reason'?: string } {
  return (JSON.parse(rpc('testmempoolaccept', JSON.stringify([txHex]))) as Array<{ allowed: boolean; 'reject-reason'?: string }>)[0];
}

/**
 * The reveal re-signed against another commit txid: same tapscript leaf and
 * control block (read from the original reveal's witness), same outputs, signed
 * with the ephemeral key.
 */
function revealAgainst(revealHex: string, commitTxid: string, commitOutput: { script: Uint8Array; amount: bigint }, ephemeralPrivKey: Uint8Array): string {
  const original = btc.Transaction.fromRaw(hex.decode(revealHex), PARSE);
  const [, leafScript, controlBlock] = original.getInput(0).finalScriptWitness!;
  const tx = new btc.Transaction({ ...PARSE, version: original.version, lockTime: original.lockTime });
  tx.addInput({
    txid: commitTxid,
    index: 0,
    sequence: original.getInput(0).sequence,
    witnessUtxo: commitOutput,
    tapLeafScript: [[btc.TaprootControlBlock.decode(controlBlock), new Uint8Array([...leafScript, controlBlock[0] & 0xfe])]],
  });
  for (let i = 0; i < original.outputsLength; i++) {
    const out = original.getOutput(i);
    tx.addOutput({ script: out.script!, amount: out.amount! });
  }
  tx.signIdx(ephemeralPrivKey, 0);
  tx.finalizeIdx(0);
  return tx.hex;
}

describe('a fee bump of a cat21wallet inscribe commit (regtest)', () => {
  beforeAll(async () => {
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
  });

  it('replaces the commit, evicts and invalidates the signed reveal, and a reveal re-signed with the ephemeral key recovers it', async () => {
    const f = await fundUninscribed();
    const built = createInscribeTransactions({
      paymentOutput: { ...f.utxo, status: { confirmed: true } },
      paymentPublicKey: f.fundingPubkey,
      paymentAddress: f.fundingAddr,
      recipientAddress: btc.p2tr(schnorr.getPublicKey(schnorr.utils.randomPrivateKey()), undefined, scureRegtest, true).address!,
      body: new TextEncoder().encode('commit rbf probe'),
      contentType: 'text/plain;charset=utf-8',
      feeRatePerVbyte: 2,
      network: Network.Regtest,
      walletType: KnownOrdinalWalletType.cat21wallet,
    });

    const commit = btc.Transaction.fromPSBT(built.commitPsbt, PARSE);
    expect(commit.getInput(0).sequence).toBe(CAT21_WALLET_INPUT_SEQUENCE);
    expect(commit.outputsLength).toBe(2);
    const commitOutput = { script: commit.getOutput(0).script!, amount: commit.getOutput(0).amount! };
    const change = commit.getOutput(1).amount!;

    const commitHex = walletSign(built.commitPsbt);
    await broadcastCommitAndReveal(transport, {
      commitHex,
      revealHex: built.revealHex,
      commitTxId: built.commitTxid,
      revealTxId: built.revealTxid,
      commitAddress: built.commitAddress,
      ephemeral: built.ephemeral,
    });
    expect([inMempool(built.commitTxid), inMempool(built.revealTxid)]).toEqual([true, true]);

    // The bump a wallet makes: same input, same commit output, the extra fee
    // taken from the change. It must outbid commit + reveal, which it evicts.
    const bumpSats = BigInt(built.fees.commitFeeSats + built.fees.revealFeeSats + 1_000);
    commit.updateOutput(1, { amount: change - bumpSats });
    const bumpedHex = walletSign(commit.toPSBT());
    const bumpedTxid = rpc('sendrawtransaction', bumpedHex).trim();

    expect(bumpedTxid).not.toBe(built.commitTxid);
    expect({
      original: inMempool(built.commitTxid),
      signedReveal: inMempool(built.revealTxid),
      bumped: inMempool(bumpedTxid),
    }).toEqual({ original: false, signedReveal: false, bumped: true });

    expect(testAccept(built.revealHex)).toEqual(expect.objectContaining({ allowed: false, 'reject-reason': 'missing-inputs' }));

    const recovered = revealAgainst(built.revealHex, bumpedTxid, commitOutput, built.ephemeral.privKey);
    expect(testAccept(recovered).allowed).toBe(true);

    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
  });
});
