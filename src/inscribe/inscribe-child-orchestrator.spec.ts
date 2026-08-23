/**
 * `inscribeChildAndBroadcast` orchestrator spec (Pipeline A).
 *
 * Pins the ORCHESTRATOR's composition: build the commit + child-reveal
 * PSBTs, sign the commit funding input, broadcast the commit, sign the
 * reveal's PARENT input at the ordinals address, broadcast the reveal,
 * thread the txids. The signer is mocked (its real signing is proven
 * end-to-end against real ord in `e2e/regtest/inscribe-child-roundtrip`).
 */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { firstValueFrom, map, of } from 'rxjs';

import { Network, toScureNetwork } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';

jest.mock('../wallet/signers', () => ({ findSignerOrThrow: jest.fn() }));
import { findSignerOrThrow } from '../wallet/signers';
import { inscribeChildAndBroadcast } from './inscribe-child-orchestrator';

const NETWORK = Network.Mainnet;
const scureNetwork = toScureNetwork(NETWORK);
const PAYMENT_PRIV = new Uint8Array(32).fill(0xab);
const PARENT_PRIV = new Uint8Array(32).fill(0xef);
const PARENT_ID = 'b'.repeat(64) + 'i0';
const COMMIT_TXID = 'c'.repeat(64);
const REVEAL_TXID = 'e'.repeat(64);

const mockedFind = findSignerOrThrow as jest.MockedFunction<typeof findSignerOrThrow>;

function paymentContext() {
  return {
    paymentPublicKey: secp256k1.getPublicKey(PAYMENT_PRIV, true),
    paymentAddress: btc.p2tr(schnorr.getPublicKey(PAYMENT_PRIV), undefined, scureNetwork, true).address!,
  };
}
function parentUtxo() {
  const p = btc.p2tr(schnorr.getPublicKey(PARENT_PRIV), undefined, scureNetwork, true);
  return {
    utxo: {
      txid: 'a'.repeat(64), vout: 0, value: 546,
      scriptPubKey: p.script,
      tapInternalKey: schnorr.getPublicKey(PARENT_PRIV),
    },
    returnAddress: p.address!,
  };
}
function recipientAddress() {
  return btc.p2tr(schnorr.getPublicKey(new Uint8Array(32).fill(0xcd)), undefined, scureNetwork, true).address!;
}

describe('inscribeChildAndBroadcast orchestrator', () => {
  let signSingleFundingInput: jest.Mock;
  let signChildRevealParentInputs: jest.Mock;
  const broadcasts: string[] = [];

  beforeEach(() => {
    broadcasts.length = 0;
    // Each signer method uses the broadcast callback the orchestrator hands
    // it, then resolves the txid — exactly how the real signers behave.
    signSingleFundingInput = jest.fn((input: any) =>
      input.broadcast(`commit-hex`).pipe(map(() => ({ txId: COMMIT_TXID }))),
    );
    signChildRevealParentInputs = jest.fn((input: any) =>
      input.broadcast(`reveal-hex`).pipe(map(() => ({ txId: REVEAL_TXID }))),
    );
    mockedFind.mockReturnValue({
      providerId: KnownOrdinalWalletType.xverse,
      signSingleFundingInput,
      signChildRevealParentInputs,
    } as any);
  });

  function run() {
    const { paymentPublicKey, paymentAddress } = paymentContext();
    const parent = parentUtxo();
    return firstValueFrom(inscribeChildAndBroadcast({
      walletType: KnownOrdinalWalletType.xverse,
      paymentOutput: { txid: 'd'.repeat(64), vout: 0, value: 100_000, status: { confirmed: true } },
      paymentPublicKey,
      paymentAddress,
      recipientAddress: recipientAddress(),
      body: new TextEncoder().encode('<html>child</html>'),
      contentType: 'text/html',
      feeRatePerVbyte: 8,
      parentInscriptionId: PARENT_ID,
      parentUtxo: parent,
      network: NETWORK,
      broadcast: (txHex: string) => { broadcasts.push(txHex); return of(txHex); },
    }));
  }

  it('signs the commit funding input, then the reveal parent input at the parent ordinals address', async () => {
    const parent = parentUtxo();
    const result = await run();

    // Commit funding input signed at the payment address.
    expect(signSingleFundingInput).toHaveBeenCalledTimes(1);
    const commitArgs = signSingleFundingInput.mock.calls[0][0] as any;
    expect(commitArgs.paymentAddress).toBe(paymentContext().paymentAddress);
    expect(commitArgs.psbtBytes).toBeInstanceOf(Uint8Array);
    // It's the commit PSBT: exactly one input (the funding UTXO).
    expect(btc.Transaction.fromPSBT(commitArgs.psbtBytes).inputsLength).toBe(1);

    // Reveal parent input signed at the PARENT's ordinals address.
    expect(signChildRevealParentInputs).toHaveBeenCalledTimes(1);
    const revealArgs = signChildRevealParentInputs.mock.calls[0][0] as any;
    expect(revealArgs.ordinalsAddress).toBe(parent.returnAddress);
    // It's the child reveal PSBT: parent input (0) + commit input (1).
    const revealPsbt = btc.Transaction.fromPSBT(revealArgs.psbtBytes);
    expect(revealPsbt.inputsLength).toBe(2);
    expect(revealPsbt.getInput(0).finalScriptWitness).toBeUndefined(); // wallet signs it
    expect(revealPsbt.getInput(1).finalScriptWitness).toBeDefined();   // ephemeral, done
  });

  it('broadcasts commit then reveal, and threads the txids into the result', async () => {
    const result = await run();
    expect(broadcasts).toEqual(['commit-hex', 'reveal-hex']);
    expect(result.commitTxId).toBe(COMMIT_TXID);
    expect(result.revealTxId).toBe(REVEAL_TXID);
    expect(result.childInscriptionId).toBe(`${REVEAL_TXID}i0`);
    expect(result.commitAddress.startsWith('bc1p')).toBe(true);
    expect(result.ephemeral.privKey.length).toBe(32);
    expect(result.fees.totalFeeSats).toBeGreaterThan(0);
  });

  it('fires onCommitSigned with the signed commit hex before broadcast', async () => {
    const seen: string[] = [];
    const { paymentPublicKey, paymentAddress } = paymentContext();
    await firstValueFrom(inscribeChildAndBroadcast({
      walletType: KnownOrdinalWalletType.xverse,
      paymentOutput: { txid: 'd'.repeat(64), vout: 0, value: 100_000, status: { confirmed: true } },
      paymentPublicKey, paymentAddress,
      recipientAddress: recipientAddress(),
      body: new TextEncoder().encode('x'),
      contentType: 'text/plain',
      feeRatePerVbyte: 8,
      parentInscriptionId: PARENT_ID,
      parentUtxo: parentUtxo(),
      network: NETWORK,
      broadcast: (txHex: string) => of(txHex),
      onCommitSigned: (h) => seen.push(h),
    }));
    expect(seen).toEqual(['commit-hex']);
  });

  it('propagates a builder error (insufficient funds) as an error observable', async () => {
    const { paymentPublicKey, paymentAddress } = paymentContext();
    await expect(firstValueFrom(inscribeChildAndBroadcast({
      walletType: KnownOrdinalWalletType.xverse,
      paymentOutput: { txid: 'd'.repeat(64), vout: 0, value: 500, status: { confirmed: true } },
      paymentPublicKey, paymentAddress,
      recipientAddress: recipientAddress(),
      body: new TextEncoder().encode('x'),
      contentType: 'text/plain',
      feeRatePerVbyte: 8,
      parentInscriptionId: PARENT_ID,
      parentUtxo: parentUtxo(),
      network: NETWORK,
      broadcast: (txHex: string) => of(txHex),
    }))).rejects.toThrow(/Insufficient funds for child inscribe/);
  });
});
