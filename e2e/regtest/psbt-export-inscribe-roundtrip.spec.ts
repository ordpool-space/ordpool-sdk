/**
 * Watch-only / PSBT-export wallet inscribe roundtrip on regtest.
 *
 * The producer-side counterpart to `psbt-export-roundtrip.spec.ts`
 * (which exercises the same path for cat21 mints). External wallets
 * — Sparrow, Electrum, Coldcard, Ledger, Trezor, Specter, Bitcoin
 * Core descriptor wallets — never inject a browser provider; the
 * user signs OFFLINE and pastes the signed PSBT back into the UI.
 *
 * End-to-end flow:
 *   1. Use Bitcoin Core's `ordpool-e2e` descriptor wallet as the
 *      "external offline wallet" stand-in (same as the mint variant).
 *   2. Get a P2WPKH address from it.
 *   3. Fund the address (1 BTC), mine + wait for electrs.
 *   4. Call `createInscribeTransactions` to build the commit PSBT
 *      and the ephemeral-signed reveal hex.
 *   5. Sign the commit PSBT via `bitcoin-cli walletprocesspsbt`
 *      with `finalize=true` — the external offline sign step.
 *   6. Feed the signed PSBT base64 into `psbtExportSigner
 *      .signAndBroadcast` with a stubbed `promptForSignedPsbt`.
 *   7. Broadcast the signed commit, mine 1 block (so the commit
 *      UTXO is mature), broadcast the reveal, mine 1 block.
 *   8. Verify on-chain: reveal locktime, witness round-trip via
 *      `InscriptionParserService`.
 *
 * The body roundtrip via the parser proves the inscription is
 * fully recoverable by every downstream ordpool consumer through
 * the same code path as a mainnet inscription.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { firstValueFrom, Observable, of } from 'rxjs';
import { InscriptionParserService } from 'ordpool-parser';

import { createInscribeTransactions } from '../../src/inscribe/inscription.service.helper';
import { Network, toScureNetwork } from '../../src/network';
import { psbtExportSigner } from '../../src/wallet/signers/psbt-export.signer';
import {
  ElectrsUtxo,
  getTx,
  getTxStatus,
  getUtxos,
  mineBlocks,
  postTx,
  rpc,
  waitForElectrsSync,
  waitForTxConfirmed,
} from './regtest-helpers';

const FUND_AMOUNT_SATS = 100_000_000; // 1 BTC
const FEE_RATE = 5; // sat/vB
const INSCRIPTION_BODY_TEXT = 'psbt-export inscribed me on regtest';
const INSCRIPTION_CONTENT_TYPE = 'text/plain;charset=utf-8';

const PSBT_WALLET = 'ordpool-e2e';
function bitcoinCliPsbtWallet(...args: string[]): string {
  return rpc('-rpcwallet=' + PSBT_WALLET, ...args);
}

describe('psbt-export signer inscribe-roundtrip on regtest (external offline wallet via bitcoin-cli walletprocesspsbt)', () => {

  let paymentAddress: string;
  let paymentPublicKey: Uint8Array;
  let recipientTaprootAddress: string;
  let utxo: ElectrsUtxo;

  beforeAll(async () => {
    paymentAddress = bitcoinCliPsbtWallet('getnewaddress', '', 'bech32');
    const addrInfo = JSON.parse(bitcoinCliPsbtWallet('getaddressinfo', paymentAddress));
    if (!addrInfo.pubkey) {
      throw new Error(`bitcoin-cli getaddressinfo did not return pubkey for ${paymentAddress}`);
    }
    paymentPublicKey = hex.decode(addrInfo.pubkey);

    const scureRegtest = toScureNetwork(Network.Regtest);
    const recipientRegtest = btc.p2tr(paymentPublicKey.subarray(1, 33), undefined, scureRegtest, true);
    recipientTaprootAddress = recipientRegtest.address!;

    bitcoinCliPsbtWallet('sendtoaddress', paymentAddress, '1.0');
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);

    const utxos = await getUtxos(paymentAddress);
    const found = utxos.find(u => u.value === FUND_AMOUNT_SATS);
    if (!found) {
      throw new Error(`Funding UTXO of ${FUND_AMOUNT_SATS} sats not found at ${paymentAddress}; saw ${JSON.stringify(utxos)}`);
    }
    utxo = found;
  });

  it('builds via SDK → signs the commit via bitcoin-cli walletprocesspsbt → finalizes + broadcasts via psbtExportSigner → broadcasts reveal → confirms on chain as a valid inscription', async () => {
    const body = new TextEncoder().encode(INSCRIPTION_BODY_TEXT);

    // Phase 1: SDK build.
    const inscribed = createInscribeTransactions({
      paymentOutput: {
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.value,
        status: { confirmed: true },
      },
      paymentPublicKey,
      paymentAddress,
      recipientAddress: recipientTaprootAddress,
      body,
      contentType: INSCRIPTION_CONTENT_TYPE,
      feeRatePerVbyte: FEE_RATE,
      network: Network.Regtest,
    });
    expect(inscribed.commitTxid).toMatch(/^[0-9a-f]{64}$/);
    expect(inscribed.revealTxid).toMatch(/^[0-9a-f]{64}$/);

    // Phase 2: external wallet signs the commit PSBT.
    //
    // finalize=false on purpose: the signer's production code path
    // takes a PARTIAL-SIG PSBT (most desktop signers — Sparrow,
    // Electrum default — return partial sigs, not a finalized
    // wire-tx) and lets scure's tx.finalize() construct the witness
    // from those sigs. BC's finalize=true emits a finalized PSBT
    // whose scure-roundtrip witness is corrupted on outputs that
    // carry an envelope tap leaf; the partial-sig path is what
    // every real-world wallet exercises and what we should test.
    const unsignedCommitBase64 = base64.encode(inscribed.commitPsbt);
    const walletprocessed = JSON.parse(bitcoinCliPsbtWallet(
      '-named', 'walletprocesspsbt',
      `psbt=${unsignedCommitBase64}`,
      'sign=true',
      'finalize=false',
    ));
    const signedCommitBase64: string = walletprocessed.psbt;

    // Phase 3: feed through psbtExportSigner. broadcast() goes to
    // local electrs.
    let capturedCommitHex: string | undefined;
    const signerResult = await firstValueFrom(psbtExportSigner.signSingleFundingInput({
      psbtBytes: inscribed.commitPsbt,
      paymentAddress,
      network: Network.Regtest,
      broadcast: (txHex: string) => {
        capturedCommitHex = txHex;
        return new Observable<string>((sub) => {
          postTx(txHex).then(txid => { sub.next(txid); sub.complete(); }, err => sub.error(err));
        });
      },
      promptForSignedPsbt: (unsigned) => {
        expect(unsigned.base64).toBe(unsignedCommitBase64);
        return of(signedCommitBase64);
      },
    }));
    expect(capturedCommitHex).toBeDefined();
    expect(signerResult.txId).toBe(inscribed.commitTxid);

    // Phase 4: commit confirmation.
    const commitTip = mineBlocks(1);
    await waitForElectrsSync(commitTip);
    const commitStatus = await getTxStatus(signerResult.txId);
    expect(commitStatus.confirmed).toBe(true);

    // Phase 5: broadcast reveal (already signed via the orchestrator's
    // ephemeral key).
    const revealTxid = await postTx(inscribed.revealHex);
    expect(revealTxid).toBe(inscribed.revealTxid);
    const revealTip = mineBlocks(1);
    await waitForElectrsSync(revealTip);
    const revealTx = await waitForTxConfirmed(revealTxid);
    expect(revealTx.status.block_hash).toBeTruthy();

    // Phase 6: content roundtrip via ordpool-parser.
    const witnessHex = (revealTx as unknown as { vin: { witness: string[] }[] }).vin[0].witness;
    const parsed = InscriptionParserService.parse({
      txid: revealTxid,
      vin: [{ witness: witnessHex }],
    });
    expect(parsed.length).toBe(1);
    expect(parsed[0].contentType).toBe(INSCRIPTION_CONTENT_TYPE);
    const recovered = new TextDecoder().decode(parsed[0].getDataRaw());
    expect(recovered).toBe(INSCRIPTION_BODY_TEXT);

    // Final on-chain shape sanity. Both commit AND reveal carry
    // lockTime=21 — the inscribe pipeline mints two cats per
    // inscription (commit cat + reveal cat) under cat21-ord's
    // --index-cat21 rule.
    const esploraReveal = await getTx(revealTxid);
    expect(esploraReveal.locktime).toBe(21);
  });
});
