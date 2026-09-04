import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { firstValueFrom, of } from 'rxjs';

import { Network, toScureNetwork } from '../../network';
import { getDummyKeypair } from '../../cat21-mint/cat21.service.helper';
import { leatherSigner } from './leather.signer';


// Build a real signed-but-not-finalized PSBT the way Leather would
// return it, so the signer's finalize step has something legit to
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


describe('leatherSigner.signSingleFundingInput', () => {

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

  it('when called, hits window.LeatherProvider.request with method=signPsbt, hex=<unsigned-PSBT>, broadcast=false', async () => {
    const { hex: leatherHex } = makeLeatherResponse();
    requestMock.mockResolvedValue({ result: { hex: leatherHex } } as never);
    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff]); // psbt magic + 1 byte

    await firstValueFrom(leatherSigner.signSingleFundingInput({
      psbtBytes: unsignedBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('LEAKED-FROM-BROADCAST-CALLBACK'),
    }));

    expect(requestMock).toHaveBeenCalledTimes(1);
    const [method, params] = requestMock.mock.calls[0] as [string, { hex: string; network: string; broadcast: boolean }];
    expect(method).toBe('signPsbt');
    expect(params.hex).toBe(hex.encode(unsignedBytes));
    expect(params.broadcast).toBe(false);
  });

  it('when Leather returns a signed PSBT, finalises it via scure and passes the tx-hex to our broadcast callback, which provides the txid', async () => {
    const { hex: leatherHex, expectedTxHex } = makeLeatherResponse();
    requestMock.mockResolvedValue({ result: { hex: leatherHex } } as never);

    let broadcastedHex: string | undefined;
    const result = await firstValueFrom(leatherSigner.signSingleFundingInput({
      psbtBytes: new Uint8Array(64),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: (txHex) => { broadcastedHex = txHex; return of('txid-from-broadcaster'); },
    }));

    expect(broadcastedHex).toBe(expectedTxHex);
    expect(result).toEqual({ txId: 'txid-from-broadcaster' });
  });

  it('when network is Testnet4, passes Leather params.network = "testnet"', async () => {
    const { hex: leatherHex } = makeLeatherResponse();
    requestMock.mockResolvedValue({ result: { hex: leatherHex } } as never);

    await firstValueFrom(leatherSigner.signSingleFundingInput({
      psbtBytes: new Uint8Array(64),
      paymentAddress: 'tb1qpayment',
      network: Network.Testnet4,
      broadcast: () => of('unused'),
    }));

    const [, params] = requestMock.mock.calls[0] as [string, { network: string }];
    expect(params.network).toBe('testnet');
  });
});

describe('leatherSigner.signMessage', () => {

  afterEach(() => {
    delete (window as unknown as { LeatherProvider?: unknown }).LeatherProvider;
  });

  it("signs via LeatherProvider.request('signMessage', {message, paymentType: 'p2tr'}) — p2tr pins the ordinals key — and unwraps result.signature", async () => {
    const request = jest.fn(async (_method: string, _params: unknown) => ({ result: { signature: 'BASE64_BIP322_SIG' } }));
    (window as unknown as { LeatherProvider: unknown }).LeatherProvider = { request };

    const result = await firstValueFrom(leatherSigner.signMessage({
      address: 'bc1pordinals',
      message: 'ordpool sign-message',
      network: Network.Mainnet,
    }));

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('signMessage', { message: 'ordpool sign-message', paymentType: 'p2tr' });
    expect(result).toEqual({ signature: 'BASE64_BIP322_SIG' });
  });
});
