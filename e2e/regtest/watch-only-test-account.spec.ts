/**
 * The watch-only test account, proven by spending on a real chain.
 *
 * A watch-only spec needs both halves of one account: the extended PUBLIC key
 * to paste into a connect field, and the private half to stand in for the
 * offline signer that fills the paste-back textarea. The risk in a helper like
 * this is that the two halves drift, and the failure is quiet: a PSBT signed
 * with the wrong child key still finalises, it just produces a transaction
 * nobody can spend.
 *
 * So the assertion is not "a signature appeared". The signed transaction is
 * broadcast to bitcoind, which rejects any signature that does not satisfy the
 * scriptPubKey the address committed to. The node is the oracle.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network, toScureNetwork } from '../../src/network';
import { deriveWatchOnlyAddresses } from '../../src/wallet/xpub/derive-watch-only';
import {
  makeWatchOnlyTestAccount,
  mineBlocks,
  postTx,
  rpc,
  waitForElectrsSync,
  waitForTxConfirmed,
  waitForUtxoAt,
} from './regtest-helpers';

const FEE_SATS = 1_000;
const FUND_SATS = 2_000_000;

describe('makeWatchOnlyTestAccount', () => {

  const account = makeWatchOnlyTestAccount();

  it('hands out a tpub the SDK derivation accepts, and agrees with it on addresses', () => {
    expect(account.accountExtendedPublicKey.startsWith('tpub')).toBe(true);

    // addressAt must be the SAME address the consumer's connect flow derives
    // from the pasted key, or the spec funds one address and the app watches
    // another.
    const derived = deriveWatchOnlyAddresses({
      extendedPublicKey: account.accountExtendedPublicKey,
      network: Network.Regtest,
      scriptType: 'p2tr',
      count: 3,
    });
    expect(account.addressAt(0)).toBe(derived[0].address);
    expect(account.addressAt(1)).toBe(derived[1].address);
    expect(account.addressAt(2)).toBe(derived[2].address);
    expect(account.addressAt(0)).not.toBe(account.addressAt(1));
  });

  it('is deterministic, and a different seed is a different account', () => {
    expect(makeWatchOnlyTestAccount().accountExtendedPublicKey)
      .toBe(account.accountExtendedPublicKey);
    expect(makeWatchOnlyTestAccount({ seed: new Uint8Array(32).fill(0x7b) }).accountExtendedPublicKey)
      .not.toBe(account.accountExtendedPublicKey);
  });

  describe('signExportedPsbt', () => {
    let funded: { txid: string; vout: number; value: number };

    beforeAll(async () => {
      rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', account.addressAt(0), '0.02');
      await waitForElectrsSync(mineBlocks(1));
      funded = await waitForUtxoAt(account.addressAt(0), FUND_SATS);
    }, 120_000);

    it('produces a signature bitcoind accepts for the key that owns the coin', async () => {
      const scureNetwork = toScureNetwork(Network.Regtest);
      const payment = account.p2trAt(0);

      // tapInternalKey is the UNTWEAKED internal key. Taking it by decoding the
      // address yields the TWEAKED output key instead, and signing then fails
      // with "No taproot scripts signed". The SDK's builders set this field
      // themselves, so a consumer exporting a PSBT never hand-rolls it.
      const tx = new btc.Transaction();
      tx.addInput({
        txid: funded.txid,
        index: funded.vout,
        witnessUtxo: { script: payment.script, amount: BigInt(funded.value) },
        tapInternalKey: payment.tapInternalKey,
      });
      tx.addOutputAddress(account.addressAt(1), BigInt(funded.value - FEE_SATS), scureNetwork);

      // The offline half signs the exported bytes, exactly as a spec's
      // paste-back step would.
      const signedBase64 = account.signExportedPsbt(base64.encode(tx.toPSBT(0)));

      const signed = btc.Transaction.fromPSBT(base64.decode(signedBase64));
      signed.finalize();
      const txid = await postTx(signed.hex);

      // bitcoind accepted it, so the private half really owns the address the
      // public half derived. A wrong child key fails here, not earlier.
      await waitForElectrsSync(mineBlocks(1));
      await waitForTxConfirmed(txid);
      const landed = await waitForUtxoAt(account.addressAt(1), funded.value - FEE_SATS);
      expect(landed.txid).toBe(txid);
    }, 180_000);
  });
});
