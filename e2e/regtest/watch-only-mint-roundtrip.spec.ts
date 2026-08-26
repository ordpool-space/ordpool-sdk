/**
 * CAPSTONE: the full watch-only chain proven on regtest, from a pasted
 * account extended public key to a broadcast CAT-21 mint.
 *
 * The three layers are each proven in isolation (derive, scan, connect
 * assembly). This proves them composed end to end on the SINGLE-ACCOUNT
 * TAPROOT model — the model connectXpub assembles — which spends a P2TR
 * funding input the P2WPKH psbt-export specs never exercised:
 *
 *   1. A user "pastes" an account xpub (here a fresh testnet taproot
 *      account; its private half stands in for the user's offline
 *      wallet — Sparrow / Electrum / Coldcard — and never touches the
 *      SDK path, which sees only the public key).
 *   2. `deriveWatchOnlyAddresses` → the receive identity (index 0).
 *   3. Fund that address on-chain from ordpool-e2e.
 *   4. `scanWatchOnly` with a real electrs probe auto-picks it as the
 *      payment identity.
 *   5. `createTransaction(xpub, …)` builds the mint with that identity
 *      — a P2TR funding input (tapInternalKey wired by
 *      build-input-script).
 *   6. The offline key signs the P2TR input (key-path), standing in for
 *      the user signing in their own wallet.
 *   7. `psbtExportSigner.signSingleFundingInput` finalizes + broadcasts.
 *   8. Assert on-chain: nLockTime=21, the cat at the recipient at 546,
 *      ordpool-parser reads a CAT-21 mint.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { randomBytes } from '@noble/hashes/utils';
import { firstValueFrom, Observable, of } from 'rxjs';
import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import { createTransaction } from '../../src/cat21-mint/cat21.service.helper';
import { TxnOutput } from '../../src/cat21-mint/cat21.service.types';
import { Network } from '../../src/network';
import { KnownOrdinalWalletType } from '../../src/wallet/wallet.service.types';
import { psbtExportSigner } from '../../src/wallet/signers/psbt-export.signer';
import { deriveWatchOnlyAddresses } from '../../src/wallet/xpub/derive-watch-only';
import { scanWatchOnly, AddressProbe } from '../../src/wallet/xpub/scan-watch-only';
import {
  ElectrsUtxo,
  getTxHex,
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

/** Real electrs probe: funded iff the address holds any UTXO. */
async function electrsProbe(address: string): Promise<AddressProbe> {
  const utxos = await getUtxos(address);
  if (utxos.length === 0) return { funded: false };
  return { funded: true, fundedSats: utxos.reduce((s, u) => s + u.value, 0) };
}

describe('watch-only mint capstone: pasted xpub -> scan -> mint -> broadcast (regtest)', () => {

  let accountTpub: string;
  let offlineKey: HDKey;      // the user's offline wallet (private half)
  let paymentAddress: string;
  let recipientAddress: string;
  let fundingUtxo: ElectrsUtxo;

  beforeAll(async () => {
    // Fresh taproot account; the private half is the user's offline wallet.
    const master = HDKey.fromMasterSeed(randomBytes(32), TESTNET_VERSIONS);
    const account = master.derive("m/86'/1'/0'");
    accountTpub = account.publicExtendedKey;
    offlineKey = account.deriveChild(0).deriveChild(0); // m/86'/1'/0'/0/0

    const [recv0, recv1] = deriveWatchOnlyAddresses({
      extendedPublicKey: accountTpub, network: Network.Regtest, scriptType: 'p2tr', count: 2,
    });
    paymentAddress = recv0.address;   // funded + payment identity
    recipientAddress = recv1.address; // where the cat lands

    rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', paymentAddress, FUND_BTC);
    await waitForElectrsSync(mineBlocks(1));
    fundingUtxo = await waitForUtxoAt(paymentAddress, FUND_SATS);
  });

  it('scans the pasted xpub, mints with the P2TR funding identity, and confirms a CAT-21', async () => {
    // Auto-pick the payment identity from real on-chain state.
    const scan = await scanWatchOnly({
      extendedPublicKey: accountTpub,
      network: Network.Regtest,
      scriptType: 'p2tr',
      gapLimit: 4,
      probe: electrsProbe,
    });
    expect(scan.payment.address).toBe(paymentAddress);
    expect(scan.paymentReason).toBe('funds');

    // Build the mint with the scan-picked identity (P2TR funding input).
    const paymentOutput: TxnOutput = {
      txid: fundingUtxo.txid, vout: fundingUtxo.vout, value: fundingUtxo.value,
      status: { confirmed: true },
    };
    const built = createTransaction(
      KnownOrdinalWalletType.xpub,
      recipientAddress,
      paymentOutput,
      hex.decode(scan.payment.publicKeyHex),
      scan.payment.address,
      FEE,
      false,
      Network.Regtest,
    );
    expect(built.tx.lockTime).toBe(CAT21_LOCKTIME);

    // The offline wallet signs the P2TR funding input (key-path), then the
    // export signer finalizes + broadcasts — exactly the production
    // watch-only bridge, with a real key standing in for Sparrow/Coldcard.
    const unsigned = built.tx.toPSBT(0);
    const offlineSigned = btc.Transaction.fromPSBT(unsigned);
    offlineSigned.signIdx(offlineKey.privateKey!, 0);
    const signedBase64 = base64.encode(offlineSigned.toPSBT());

    let capturedTxHex: string | undefined;
    const result = await firstValueFrom(psbtExportSigner.signSingleFundingInput({
      psbtBytes: unsigned,
      paymentAddress,
      network: Network.Regtest,
      broadcast: (txHex: string) => {
        capturedTxHex = txHex;
        return new Observable<string>((sub) => {
          postTx(txHex).then(txid => { sub.next(txid); sub.complete(); }, err => sub.error(err));
        });
      },
      promptForSignedPsbt: (u) => {
        expect(u.base64).toBe(base64.encode(unsigned));
        return of(signedBase64);
      },
    }));
    const mintTxid = result.txId;
    expect(capturedTxHex).toBeDefined();

    // On-chain assertions.
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    const esploraTx = await waitForTxConfirmed(mintTxid);
    expect(esploraTx.locktime).toBe(CAT21_LOCKTIME);

    const recipientUtxos = await getUtxos(recipientAddress);
    const cat = recipientUtxos.find(u => u.txid === mintTxid && u.vout === 0);
    expect(cat?.value).toBe(RECIPIENT_AMOUNT);

    const retrievedHex = await getTxHex(mintTxid);
    expect(retrievedHex).toBe(capturedTxHex);

    const parsed = Cat21ParserService.parse(esploraTx);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
  });
});
