import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { firstValueFrom, of } from 'rxjs';

import { Network, toScureNetwork } from '../../network';
import { getDummyKeypair } from '../../cat21-mint/cat21.service.helper';
import { cat21walletSigner } from './cat21wallet.signer';


// Build a real signed-but-not-finalized PSBT the way CAT-21 wallet
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


describe('cat21walletSigner.signSingleFundingInput', () => {

  let requestMock: jest.Mock;

  beforeEach(() => {
    requestMock = jest.fn();
    (window as unknown as { Cat21Provider: { isCat21: true; request: jest.Mock } }).Cat21Provider = {
      isCat21: true,
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

    await firstValueFrom(cat21walletSigner.signSingleFundingInput({
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

  it('when CAT-21 wallet returns a signed PSBT, finalises it via scure and broadcasts the wire-tx hex through input.broadcast', async () => {
    const { hex: signedHex, expectedTxHex } = makeCat21WalletResponse();
    requestMock.mockResolvedValue({ result: { hex: signedHex } } as never);

    let broadcastedHex: string | undefined;
    const result = await firstValueFrom(cat21walletSigner.signSingleFundingInput({
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

    await firstValueFrom(cat21walletSigner.signSingleFundingInput({
      psbtBytes: new Uint8Array(64),
      paymentAddress: 'tb1qpayment',
      network: Network.Testnet4,
      broadcast: () => of('unused'),
    }));

    const [, params] = requestMock.mock.calls[0] as [string, { network: string }];
    expect(params.network).toBe('testnet');
  });
});


describe('cat21walletSigner.signMessage', () => {

  let requestMock: jest.Mock;

  beforeEach(() => {
    requestMock = jest.fn();
    (window as unknown as { Cat21Provider: { isCat21: true; request: jest.Mock } }).Cat21Provider = {
      isCat21: true,
      request: requestMock,
    };
  });

  afterEach(() => {
    delete (window as unknown as { Cat21Provider?: unknown }).Cat21Provider;
  });

  it('hits Cat21Provider.request with method=signMessage, message=<verbatim>, paymentType=p2tr', async () => {
    requestMock.mockResolvedValue({ result: { signature: 'AUHd69PrJ...==' } } as never);

    const result = await firstValueFrom(cat21walletSigner.signMessage({
      address: 'bc1p-ordinals-address',
      message: 'cat21-ask:v1\ncatNumber=42\naskSats=21000',
      network: Network.Mainnet,
    }));

    expect(requestMock).toHaveBeenCalledTimes(1);
    const [method, params] = requestMock.mock.calls[0] as [string, { message: string; paymentType: string }];
    expect(method).toBe('signMessage');
    expect(params.message).toBe('cat21-ask:v1\ncatNumber=42\naskSats=21000');
    // p2tr forces the ordinals key — load-bearing for BIP-322 CAT-21 verify.
    expect(params.paymentType).toBe('p2tr');
    expect(result).toEqual({ signature: 'AUHd69PrJ...==' });
  });

  it('unwraps the { result: { signature } } envelope into the flat { signature } SDK contract', async () => {
    requestMock.mockResolvedValue({ result: { signature: 'sig-bytes-base64' } } as never);
    const result = await firstValueFrom(cat21walletSigner.signMessage({
      address: 'bc1p-x',
      message: 'hi',
      network: Network.Mainnet,
    }));
    expect(result).toEqual({ signature: 'sig-bytes-base64' });
  });

  it('propagates a wallet-side rejection as an observable error', async () => {
    requestMock.mockRejectedValue(new Error('User rejected the message-sign request') as never);
    let caught: Error | null = null;
    try {
      await firstValueFrom(cat21walletSigner.signMessage({
        address: 'bc1p-x',
        message: 'hi',
        network: Network.Mainnet,
      }));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toContain('User rejected');
  });

  it('errors immediately when the CAT-21 wallet provider is not present', async () => {
    delete (window as unknown as { Cat21Provider?: unknown }).Cat21Provider;
    let caught: Error | null = null;
    try {
      await firstValueFrom(cat21walletSigner.signMessage({
        address: 'bc1p-x',
        message: 'hi',
        network: Network.Mainnet,
      }));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toContain('CAT-21 wallet provider not present');
  });
});
