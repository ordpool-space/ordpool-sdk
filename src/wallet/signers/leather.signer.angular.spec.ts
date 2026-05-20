import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { firstValueFrom, of } from 'rxjs';

import { Network, toScureNetwork } from '../../network';
import { getDummyKeypair } from '../../cat21-mint/cat21.service.helper';
import { leatherSigner } from './leather.signer';


// Build a real signed-but-not-finalized PSBT the way Leather would
// return it — so the signer's finalize step has something legit to
// consume.
function makeLeatherResponse(): { hex: string; expectedTxHex: string } {
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

  const psbtBytes = tx.toPSBT(0);
  const expected = btc.Transaction.fromPSBT(psbtBytes);
  expected.finalize();
  return { hex: hex.encode(psbtBytes), expectedTxHex: expected.hex };
}


describe('leatherSigner.signAndBroadcast', () => {

  let requestMock: jest.Mock;

  beforeEach(() => {
    requestMock = jest.fn();
    (window as unknown as { LeatherProvider: { request: jest.Mock } }).LeatherProvider = {
      request: requestMock,
    };
  });

  afterEach(() => {
    delete (window as unknown as { LeatherProvider?: unknown }).LeatherProvider;
  });

  it('calls window.LeatherProvider.request (NOT window.btc) with the unsigned PSBT as hex', async () => {
    const { hex: leatherHex } = makeLeatherResponse();
    requestMock.mockResolvedValue({ result: { hex: leatherHex } } as never);
    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff]); // psbt magic + 1 byte

    await firstValueFrom(leatherSigner.signAndBroadcast({
      psbtBytes: unsignedBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('txid'),
    }));

    expect(requestMock).toHaveBeenCalledTimes(1);
    const [method, params] = requestMock.mock.calls[0] as [string, { hex: string; network: string; broadcast: boolean }];
    expect(method).toBe('signPsbt');
    expect(params.hex).toBe(hex.encode(unsignedBytes));
    expect(params.broadcast).toBe(false);
  });

  it('finalises Leather\'s signed PSBT and broadcasts the resulting tx-hex', async () => {
    const { hex: leatherHex, expectedTxHex } = makeLeatherResponse();
    requestMock.mockResolvedValue({ result: { hex: leatherHex } } as never);

    let broadcastedHex: string | undefined;
    const result = await firstValueFrom(leatherSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(64),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: (txHex) => { broadcastedHex = txHex; return of('returned-txid'); },
    }));

    expect(broadcastedHex).toBe(expectedTxHex);
    expect(result).toEqual({ txId: 'returned-txid' });
  });

  it('ignores promptForSignedPsbt — Leather signs in its own UI, watch-only callback is irrelevant', async () => {
    const { hex: leatherHex } = makeLeatherResponse();
    requestMock.mockResolvedValue({ result: { hex: leatherHex } } as never);
    const promptForSignedPsbt = jest.fn();

    const result = await firstValueFrom(leatherSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(64),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('txid'),
      promptForSignedPsbt: promptForSignedPsbt as never,
    }));

    expect(result).toEqual({ txId: 'txid' });
    expect(promptForSignedPsbt).not.toHaveBeenCalled();
  });

  it('works the same way when promptForSignedPsbt is absent (proving it is optional, not required)', async () => {
    const { hex: leatherHex } = makeLeatherResponse();
    requestMock.mockResolvedValue({ result: { hex: leatherHex } } as never);

    const result = await firstValueFrom(leatherSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(64),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('txid'),
    }));

    expect(result).toEqual({ txId: 'txid' });
  });

  it('passes the correct Leather network string for testnet', async () => {
    const { hex: leatherHex } = makeLeatherResponse();
    requestMock.mockResolvedValue({ result: { hex: leatherHex } } as never);

    await firstValueFrom(leatherSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(64),
      paymentAddress: 'tb1qpayment',
      network: Network.Testnet4,
      broadcast: () => of('txid'),
    }));

    const [, params] = requestMock.mock.calls[0] as [string, { network: string }];
    expect(params.network).toBe('testnet');
  });
});
