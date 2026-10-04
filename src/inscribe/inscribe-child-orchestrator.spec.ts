/**
 * `inscribeChildAndBroadcast` orchestrator spec (Pipeline A).
 *
 * Pins the ORCHESTRATOR's composition: build the commit + child-reveal
 * PSBTs, sign the commit funding input, sign the reveal's PARENT input at
 * the ordinals address, and only then send both as one package, threading
 * the txids of the signed bytes. The signer is mocked, but it signs for real
 * with the test keys (its wallet-side signing is proven end-to-end against
 * real ord in `e2e/regtest/inscribe-child-roundtrip`).
 */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { firstValueFrom, map, of } from 'rxjs';

import { Network, toScureNetwork } from '../network.js';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types.js';

jest.mock('../wallet/signers', () => ({ findSignerOrThrow: jest.fn() }));
import { findSignerOrThrow } from '../wallet/signers/index.js';
import { inscribeChildAndBroadcast } from './inscribe-child-orchestrator.js';
import { recordingInscribeTransport, type RecordingInscribeTransport } from '../testing/inscribe-transport.js';

const NETWORK = Network.Mainnet;
const scureNetwork = toScureNetwork(NETWORK);
const PAYMENT_PRIV = new Uint8Array(32).fill(0xab);
const PARENT_PRIV = new Uint8Array(32).fill(0xef);
const PARENT_ID = 'b'.repeat(64) + 'i0';

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
  let transport: RecordingInscribeTransport;
  // What the mocked signers handed over, to compare with what was sent.
  let signedCommitHex: string;
  let signedRevealHex: string;

  beforeEach(() => {
    transport = recordingInscribeTransport();
    // Each signer method signs with the test key, then hands the wire hex to
    // the broadcast callback the orchestrator gave it, exactly as the real
    // signers do.
    signSingleFundingInput = jest.fn((input: any) => {
      const tx = btc.Transaction.fromPSBT(input.psbtBytes);
      tx.signIdx(PAYMENT_PRIV, 0);
      tx.finalize();
      signedCommitHex = tx.hex;
      return input.broadcast(tx.hex).pipe(map((txId) => ({ txId })));
    });
    signChildRevealParentInputs = jest.fn((input: any) => {
      const tx = btc.Transaction.fromPSBT(input.finalizePsbtBytes, { allowUnknownInputs: true });
      tx.signIdx(PARENT_PRIV, 0);
      tx.finalize();
      signedRevealHex = tx.hex;
      return input.broadcast(tx.hex).pipe(map((txId) => ({ txId })));
    });
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
      transport,
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
    // The ordinals pubkey (the parent's Taproot internal key) is threaded
    // so address-filter signers can shim the correct wallet-side address.
    expect(revealArgs.ordinalsPublicKey).toBe(hex.encode(schnorr.getPublicKey(PARENT_PRIV)));
    // psbtBytes is the WALLET-FACING reveal PSBT: parent input (0) +
    // commit input (1), but input 1 is BARE (no envelope tap-leaf) so
    // every wallet's signPsbt handles it.
    const walletPsbt = btc.Transaction.fromPSBT(revealArgs.psbtBytes);
    expect(walletPsbt.inputsLength).toBe(2);
    expect(walletPsbt.getInput(0).finalScriptWitness).toBeUndefined(); // wallet signs it
    expect(walletPsbt.getInput(1).tapScriptSig).toBeUndefined();       // stripped
    expect(walletPsbt.getInput(1).tapLeafScript).toBeUndefined();      // stripped
    // finalizePsbtBytes is the FULL reveal PSBT: input 1 carries the
    // ephemeral script-path sig as a partial tapScriptSig for the merge.
    const fullPsbt = btc.Transaction.fromPSBT(revealArgs.finalizePsbtBytes, { allowUnknownInputs: true });
    expect(fullPsbt.getInput(1).tapScriptSig).toBeDefined();
    expect(fullPsbt.getInput(1).tapScriptSig!.length).toBe(1);
  });

  it('sends commit and reveal together only after both are signed, and threads their txids into the result', async () => {
    const result = await run();
    expect(transport.calls).toEqual(['testPackage', 'submitPackage']);
    expect(transport.submitted).toEqual([signedCommitHex, signedRevealHex]);
    const commitTx = btc.Transaction.fromRaw(hex.decode(signedCommitHex));
    const revealTx = btc.Transaction.fromRaw(hex.decode(signedRevealHex), { allowUnknownInputs: true });
    expect(result.commitTxId).toBe(commitTx.id);
    expect(result.revealTxId).toBe(revealTx.id);
    expect(result.childInscriptionId).toBe(`${revealTx.id}i0`);
    // The reveal spends the commit it was sent with.
    expect(hex.encode(revealTx.getInput(1).txid!)).toBe(commitTx.id);
    expect(result.commitAddress.startsWith('bc1p')).toBe(true);
    expect(result.ephemeral.privKey.length).toBe(32);
    expect(result.fees.totalFeeSats).toBeGreaterThan(0);
  });

  it('fires onCommitSigned with the signed commit hex before anything is sent', async () => {
    const seen: string[] = [];
    const sentWhenSigned: number[] = [];
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
      transport,
      onCommitSigned: (h) => { seen.push(h); sentWhenSigned.push(transport.calls.length); },
    }));
    expect(seen).toEqual([signedCommitHex]);
    // Nothing had reached the transport when the hook fired.
    expect(sentWhenSigned).toEqual([0]);
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
      transport,
    }))).rejects.toThrow(/Insufficient funds for child inscribe/);
    expect(transport.calls).toEqual([]);
  });
});
