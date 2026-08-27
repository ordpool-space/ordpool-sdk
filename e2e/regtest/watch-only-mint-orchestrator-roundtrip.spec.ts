/**
 * Watch-only mint proven through the PUBLIC ORCHESTRATOR on regtest.
 *
 * `watch-only-mint-roundtrip.spec.ts` proves the internal path
 * (`createTransaction` + `psbtExportSigner` directly). Consumers don't
 * call those — they call the orchestrator. This proves the orchestrator
 * threads `promptForSignedPsbt` through to the watch-only signer, so a
 * watch-only user can actually mint:
 *
 *   pasted xpub → scan → Cat21Service.createCat21Transaction(
 *     …, promptForSignedPsbt) → export/paste sign (offline key) →
 *   psbtExportSigner finalizes + broadcasts → confirmed CAT-21.
 *
 * Without the callback the orchestrator's signer call throws
 * "Watch-only signing requires a promptForSignedPsbt callback"; this
 * pins that it is now surfaced + threaded.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { randomBytes } from '@noble/hashes/utils';
import { firstValueFrom, Observable, of } from 'rxjs';
import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import { Cat21Service } from '../../src/cat21-mint/cat21.service';
import { TxnOutput } from '../../src/cat21-mint/cat21.service.types';
import { Network } from '../../src/network';
import { KnownOrdinalWalletType } from '../../src/wallet/wallet.service.types';
import { deriveWatchOnlyAddresses } from '../../src/wallet/xpub/derive-watch-only';
import { scanWatchOnly, AddressProbe } from '../../src/wallet/xpub/scan-watch-only';
import {
  ElectrsUtxo,
  getUtxos,
  waitForTxConfirmed,
  mineBlocks,
  postTx,
  rpc,
  waitForElectrsSync,
  waitForUtxoAt,
} from './regtest-helpers';

const TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587cf };
const CAT21_LOCKTIME = 21;
const RECIPIENT_AMOUNT = 546;
const FEE = BigInt(2_000);
const FUND_BTC = '0.0020';
const FUND_SATS = 200_000;

async function electrsProbe(address: string): Promise<AddressProbe> {
  const utxos = await getUtxos(address);
  if (utxos.length === 0) return { funded: false };
  return { funded: true, fundedSats: utxos.reduce((s, u) => s + u.value, 0) };
}

/** A bare Cat21Service: only `network` + `postTransaction` are needed by
 *  createCat21Transaction, and we wire broadcast straight to regtest electrs
 *  (no Angular HttpClient). */
function makeCat21Service(): Cat21Service {
  const svc = Object.create(Cat21Service.prototype) as Cat21Service;
  (svc as unknown as { network: Network }).network = Network.Regtest;
  svc.postTransaction = (txHex: string): Observable<string> =>
    new Observable<string>((sub) => {
      postTx(txHex).then(txid => { sub.next(txid); sub.complete(); }, err => sub.error(err));
    });
  return svc;
}

describe('watch-only mint via the public orchestrator on regtest', () => {

  let accountTpub: string;
  let offlineKey: HDKey;
  let paymentAddress: string;
  let recipientAddress: string;
  let fundingUtxo: ElectrsUtxo;

  beforeAll(async () => {
    const master = HDKey.fromMasterSeed(randomBytes(32), TESTNET_VERSIONS);
    const account = master.derive("m/86'/1'/0'");
    accountTpub = account.publicExtendedKey;
    offlineKey = account.deriveChild(0).deriveChild(0); // m/86'/1'/0'/0/0

    const [recv0, recv1] = deriveWatchOnlyAddresses({
      extendedPublicKey: accountTpub, network: Network.Regtest, scriptType: 'p2tr', count: 2,
    });
    paymentAddress = recv0.address;
    recipientAddress = recv1.address;

    rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', paymentAddress, FUND_BTC);
    await waitForElectrsSync(mineBlocks(1));
    fundingUtxo = await waitForUtxoAt(paymentAddress, FUND_SATS);
  });

  it('createCat21Transaction threads promptForSignedPsbt so a watch-only mint confirms', async () => {
    const scan = await scanWatchOnly({
      extendedPublicKey: accountTpub, network: Network.Regtest, scriptType: 'p2tr', gapLimit: 4, probe: electrsProbe,
    });
    expect(scan.payment.address).toBe(paymentAddress);

    const cat21 = makeCat21Service();
    const paymentOutput: TxnOutput = {
      txid: fundingUtxo.txid, vout: fundingUtxo.vout, value: fundingUtxo.value, status: { confirmed: true },
    };

    // The export/paste bridge: the SDK builds the PSBT and hands it here;
    // the user's offline wallet (a real key stands in) signs input 0.
    let promptCalled = false;
    const promptForSignedPsbt = (unsigned: { base64: string; hex: string }): Observable<string> => {
      promptCalled = true;
      const signed = btc.Transaction.fromPSBT(base64.decode(unsigned.base64));
      signed.signIdx(offlineKey.privateKey!, 0);
      return of(base64.encode(signed.toPSBT()));
    };

    const { txId } = await firstValueFrom(cat21.createCat21Transaction(
      KnownOrdinalWalletType.xpub,
      recipientAddress,
      paymentOutput,
      scan.payment.address,
      hex.decode(scan.payment.publicKeyHex),
      FEE,
      promptForSignedPsbt,
    ));
    expect(promptCalled).toBe(true);
    expect(txId).toMatch(/^[0-9a-f]{64}$/);

    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    const esploraTx = await waitForTxConfirmed(txId);
    expect(esploraTx.locktime).toBe(CAT21_LOCKTIME);

    const recipientUtxos = await getUtxos(recipientAddress);
    expect(recipientUtxos.find(u => u.txid === txId && u.vout === 0)?.value).toBe(RECIPIENT_AMOUNT);

    const parsed = Cat21ParserService.parse(esploraTx);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  });

  it('without promptForSignedPsbt the watch-only mint throws the callback error (proves the arg is load-bearing)', async () => {
    const cat21 = makeCat21Service();
    const paymentOutput: TxnOutput = {
      txid: fundingUtxo.txid, vout: fundingUtxo.vout, value: fundingUtxo.value, status: { confirmed: true },
    };
    await expect(firstValueFrom(cat21.createCat21Transaction(
      KnownOrdinalWalletType.xpub,
      recipientAddress,
      paymentOutput,
      paymentAddress,
      hex.decode(deriveWatchOnlyAddresses({
        extendedPublicKey: accountTpub, network: Network.Regtest, scriptType: 'p2tr', count: 1,
      })[0].publicKeyHex),
      FEE,
      // no promptForSignedPsbt
    ))).rejects.toThrow(/promptForSignedPsbt/);
  });
});
