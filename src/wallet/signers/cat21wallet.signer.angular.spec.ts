import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { firstValueFrom, of } from 'rxjs';

import { Network, toScureNetwork } from '../../network';
import { getDummyKeypair } from '../../cat21-mint/cat21.service.helper';
import { cat21walletSigner } from './cat21wallet.signer';


// Build a real signed-but-not-finalized PSBT the way Cat21 Wallet
// (forked from Leather, identical signPsbt response shape) would
// return it, so the signer's finalize step has something legit to
// consume.
function makeCat21WalletResponse(): { hex: string; expectedTxHex: string } {
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


describe('cat21walletSigner.signAndBroadcast', () => {

  let requestMock: jest.Mock;

  beforeEach(() => {
    requestMock = jest.fn();
    (window as unknown as { Cat21Provider: { request: jest.Mock } }).Cat21Provider = {
      request: requestMock,
    };
  });

  afterEach(() => {
    delete (window as unknown as { Cat21Provider?: unknown }).Cat21Provider;
  });

  it('hits window.Cat21Provider.request with method=signPsbt, hex=<unsigned-PSBT>, allowedSighash=[SigHash.ALL], broadcast=false', async () => {
    const { hex: signedHex } = makeCat21WalletResponse();
    requestMock.mockResolvedValue({ result: { hex: signedHex } } as never);
    const unsignedBytes = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff]);

    await firstValueFrom(cat21walletSigner.signAndBroadcast({
      psbtBytes: unsignedBytes,
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: () => of('IGNORED'),
    }));

    expect(requestMock).toHaveBeenCalledTimes(1);
    const [method, params] = requestMock.mock.calls[0] as [string, { hex: string; allowedSighash: number[]; signAtIndex: number; network: string; broadcast: boolean }];
    expect(method).toBe('signPsbt');
    expect(params.hex).toBe(hex.encode(unsignedBytes));
    expect(params.allowedSighash).toEqual([btc.SigHash.ALL]);
    expect(params.signAtIndex).toBe(0);
    expect(params.broadcast).toBe(false);
  });

  it('when Cat21 Wallet returns a signed PSBT, finalises it via scure and broadcasts the wire-tx hex through input.broadcast', async () => {
    const { hex: signedHex, expectedTxHex } = makeCat21WalletResponse();
    requestMock.mockResolvedValue({ result: { hex: signedHex } } as never);

    let broadcastedHex: string | undefined;
    const result = await firstValueFrom(cat21walletSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(64),
      paymentAddress: 'bc1qpayment',
      network: Network.Mainnet,
      broadcast: (txHex) => { broadcastedHex = txHex; return of('txid-from-broadcaster'); },
    }));

    expect(broadcastedHex).toBe(expectedTxHex);
    expect(result).toEqual({ txId: 'txid-from-broadcaster' });
  });

  it('forwards Testnet4 as network="testnet" in the request envelope (mainnet-only ADR doesn\'t apply to the wire shape — the wallet may add more nets later)', async () => {
    const { hex: signedHex } = makeCat21WalletResponse();
    requestMock.mockResolvedValue({ result: { hex: signedHex } } as never);

    await firstValueFrom(cat21walletSigner.signAndBroadcast({
      psbtBytes: new Uint8Array(64),
      paymentAddress: 'tb1qpayment',
      network: Network.Testnet4,
      broadcast: () => of('unused'),
    }));

    const [, params] = requestMock.mock.calls[0] as [string, { network: string }];
    expect(params.network).toBe('testnet');
  });
});
