import { describe, expect, it } from '@jest/globals';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { firstValueFrom, of, throwError } from 'rxjs';

import { Network, toScureNetwork } from '../../network';
import { getDummyKeypair } from '../../cat21-mint/cat21.service.helper';
import { psbtExportSigner } from './psbt-export.signer';


/**
 * Produce a real signed PSBT round-trip using the dummy keypair —
 * the same fixture machinery the cat21 byte-snapshot tests use, but
 * we don't care about the cat21 mint shape here. Just any PSBT
 * that scure accepts as "signed and ready to finalize".
 */
function makeSignedPsbtAndExpectedTxHex(): { signedPsbtBase64: string; expectedTxHex: string } {
  const network = toScureNetwork(Network.Mainnet);
  const kp = getDummyKeypair(network);
  const tx = new btc.Transaction({ allowLegacyWitnessUtxo: true, disableScriptCheck: true });
  tx.addInput({
    txid: '0000000000000000000000000000000000000000000000000000000000000000',
    index: 0,
    witnessUtxo: {
      script: btc.p2wpkh(kp.dummyPublicKey, network).script,
      amount: BigInt(10000),
    },
    sighashType: btc.SigHash.ALL,
  });
  tx.addOutputAddress(kp.addressP2WPKH, BigInt(9000), network);
  tx.signIdx(kp.dummyPrivateKey, 0, [btc.SigHash.ALL]);
  // intentionally do NOT finalize — the signer's job is to finalize.

  const signedPsbtBase64 = base64.encode(tx.toPSBT(0));

  // Independently produce the expected finalized hex so the assertion
  // is anchored to scure's own output, not the signer's internal copy.
  const expected = btc.Transaction.fromPSBT(tx.toPSBT(0));
  expected.finalize();
  return { signedPsbtBase64, expectedTxHex: expected.hex };
}


describe('psbtExportSigner.signAndBroadcast', () => {

  const unsignedPsbtBytes = new Uint8Array(64).fill(0xff); // shape doesn't matter — signer hands it to the prompt

  it('throws when no promptForSignedPsbt callback is provided', async () => {
    const result$ = psbtExportSigner.signAndBroadcast({
      psbtBytes: unsignedPsbtBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('broadcasted-txid'),
    });

    await expect(firstValueFrom(result$)).rejects.toThrow(
      /Watch-only signing requires a promptForSignedPsbt callback/
    );
  });

  it('hands the unsigned PSBT to the prompt as both base64 and hex', async () => {
    const { signedPsbtBase64 } = makeSignedPsbtAndExpectedTxHex();

    let receivedBase64: string | undefined;
    let receivedHex: string | undefined;
    await firstValueFrom(psbtExportSigner.signAndBroadcast({
      psbtBytes: unsignedPsbtBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('broadcasted-txid'),
      promptForSignedPsbt: (unsigned) => {
        receivedBase64 = unsigned.base64;
        receivedHex = unsigned.hex;
        return of(signedPsbtBase64);
      },
    }));

    expect(receivedBase64).toBe(base64.encode(unsignedPsbtBytes));
    expect(receivedHex).toBe(hex.encode(unsignedPsbtBytes));
  });

  it('finalizes the signed PSBT and broadcasts the resulting tx-hex', async () => {
    const { signedPsbtBase64, expectedTxHex } = makeSignedPsbtAndExpectedTxHex();

    let broadcastedHex: string | undefined;
    const result = await firstValueFrom(psbtExportSigner.signAndBroadcast({
      psbtBytes: unsignedPsbtBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: (txHex) => {
        broadcastedHex = txHex;
        return of('returned-txid');
      },
      promptForSignedPsbt: () => of(signedPsbtBase64),
    }));

    expect(broadcastedHex).toBe(expectedTxHex);
    expect(result).toEqual({ txId: 'returned-txid' });
  });

  it('accepts the signed PSBT as hex as well as base64', async () => {
    const { signedPsbtBase64, expectedTxHex } = makeSignedPsbtAndExpectedTxHex();
    const signedPsbtHex = hex.encode(base64.decode(signedPsbtBase64));

    let broadcastedHex: string | undefined;
    await firstValueFrom(psbtExportSigner.signAndBroadcast({
      psbtBytes: unsignedPsbtBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: (txHex) => { broadcastedHex = txHex; return of('txid'); },
      promptForSignedPsbt: () => of(signedPsbtHex),
    }));

    expect(broadcastedHex).toBe(expectedTxHex);
  });

  it('rejects an empty signed-PSBT input', async () => {
    const result$ = psbtExportSigner.signAndBroadcast({
      psbtBytes: unsignedPsbtBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('txid'),
      promptForSignedPsbt: () => of('   '),
    });

    await expect(firstValueFrom(result$)).rejects.toThrow(/empty/i);
  });

  it('rejects garbage that is neither base64 PSBT nor hex PSBT', async () => {
    const result$ = psbtExportSigner.signAndBroadcast({
      psbtBytes: unsignedPsbtBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('txid'),
      promptForSignedPsbt: () => of('not a psbt at all'),
    });

    await expect(firstValueFrom(result$)).rejects.toThrow(/base64 or hex/);
  });

  it('propagates an error from the prompt without touching broadcast', async () => {
    let broadcastCalled = false;
    const result$ = psbtExportSigner.signAndBroadcast({
      psbtBytes: unsignedPsbtBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => { broadcastCalled = true; return of('txid'); },
      promptForSignedPsbt: () => throwError(() => new Error('user cancelled')),
    });

    await expect(firstValueFrom(result$)).rejects.toThrow('user cancelled');
    expect(broadcastCalled).toBe(false);
  });
});
