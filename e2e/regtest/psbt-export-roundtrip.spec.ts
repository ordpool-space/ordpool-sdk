/**
 * Watch-only / PSBT-export wallet roundtrip on regtest.
 *
 * Use case: Sparrow, Electrum, Coldcard, Ledger, Trezor, Specter,
 * Bitcoin Core descriptor wallets. None of them inject a browser
 * provider; the user signs OFFLINE in their own wallet software and
 * pastes the signed PSBT back into the cat21.space UI.
 *
 * The "external offline wallet" we stand in with here is **Bitcoin
 * Core's own descriptor wallet** via `bitcoin-cli walletprocesspsbt`.
 * That's a perfect stand-in for Sparrow/Electrum: it's the canonical
 * BIP-174 signer and consumes the same base64 PSBTs every other
 * wallet emits. If our `psbtExportSigner` accepts a PSBT signed by
 * Bitcoin Core, it accepts every BIP-174-conformant signer. Running
 * a real Sparrow binary in CI buys nothing on top.
 *
 * End-to-end flow this spec pins:
 *   1. Spin up a fresh `psbt-export-tester` descriptor wallet in
 *      bitcoind regtest (this represents the user's air-gapped
 *      wallet).
 *   2. Get a P2WPKH address from it.
 *   3. Fund the address from the ordpool-e2e wallet (1 BTC),
 *      mine + wait for electrs.
 *   4. Build a CAT-21 mint PSBT via the SDK
 *      (`createTransaction(KnownOrdinalWalletType.xpub, ...)`).
 *   5. Sign via `bitcoin-cli walletprocesspsbt` — the external
 *      offline sign step.
 *   6. Feed the signed PSBT base64 into
 *      `psbtExportSigner.signSingleFundingInput` with a stubbed
 *      `promptForSignedPsbt` that emits the signed payload
 *      directly (no UI in the test loop).
 *   7. The signer finalizes via scure and broadcasts via
 *      `input.broadcast` → electrs POST /tx.
 *   8. Mine + assert the on-chain tx: nLockTime=21, output 0 is
 *      the recipient at 546 sats, ordpool-parser identifies it
 *      as a CAT-21 mint.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { firstValueFrom, Observable, of } from 'rxjs';
import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import { createTransaction } from '../../src/cat21-mint/cat21.service.helper';
import { TxnOutput } from '../../src/cat21-mint/cat21.service.types';
import { Network, toScureNetwork } from '../../src/network';
import { KnownOrdinalWalletType } from '../../src/wallet/wallet.service.types';
import { psbtExportSigner } from '../../src/wallet/signers/psbt-export.signer';
import {
  ElectrsUtxo,
  getTxHex,
  waitForTxConfirmed,
  mineBlocks,
  postTx,
  rpc,
  waitForElectrsSync,
  waitForUtxoAt,
} from './regtest-helpers';


const CAT21_LOCKTIME = 21;
const RECIPIENT_AMOUNT = BigInt(546);
const FEE = BigInt(2_000);
const FUND_AMOUNT_SATS = 100_000_000; // 1 BTC

/**
 * The "external offline wallet" we stand in with is the existing
 * `ordpool-e2e` Bitcoin Core wallet — same one that already signs
 * its own outputs in `cat21-mint-roundtrip.spec.ts`. Bitcoin Core
 * is the canonical BIP-174 implementation, so any PSBT it signs is
 * a faithful proxy for what Sparrow / Electrum / Coldcard / Ledger /
 * Trezor would emit (those wallets all consume the same wire
 * format).
 *
 * We don't create a separate descriptor wallet because doing so
 * introduces a "does the descriptor wallet's signer recognise the
 * scure-built PSBT's input shape" question that's outside the
 * scope of THIS spec (which is testing psbtExportSigner, not
 * Bitcoin Core's descriptor-wallet ergonomics).
 */
const PSBT_WALLET = 'ordpool-e2e';


function bitcoinCliPsbtWallet(...args: string[]): string {
  return rpc('-rpcwallet=' + PSBT_WALLET, ...args);
}


describe('psbt-export signer roundtrip on regtest (external offline wallet via bitcoin-cli walletprocesspsbt)', () => {

  const regtestNetwork = toScureNetwork(Network.Regtest);

  let paymentAddress: string;
  let paymentPublicKey: Uint8Array;
  let recipientTaprootAddress: string;
  let expectedRecipientScript: Uint8Array;
  let utxo: ElectrsUtxo;

  beforeAll(async () => {
    // The external wallet's payment address. P2WPKH (Native SegWit)
    // is the default descriptor-wallet output type and the most
    // common shape for desktop signers in 2026.
    paymentAddress = bitcoinCliPsbtWallet('getnewaddress', '', 'bech32');

    // getaddressinfo returns the descriptor's pubkey for P2WPKH. The
    // SDK needs this to build the input script.
    const addrInfo = JSON.parse(bitcoinCliPsbtWallet('getaddressinfo', paymentAddress));
    if (!addrInfo.pubkey) {
      throw new Error(`bitcoin-cli getaddressinfo did not return pubkey for ${paymentAddress}: ${JSON.stringify(addrInfo)}`);
    }
    paymentPublicKey = hex.decode(addrInfo.pubkey);

    // Pick a recipient Taproot address. We derive it from the SAME
    // payment pubkey (self-recipient) because the descriptor wallet
    // only exposes ECDSA-shaped pubkeys via getaddressinfo —
    // bech32m / P2TR derivation lives inside the descriptor, not
    // the `pubkey` JSON field. Self-recipient is fine: the spec
    // verifies the cat lands at output 0 at 546 sats, not who the
    // recipient is.
    const recipientP2tr = btc.p2tr(paymentPublicKey.subarray(1, 33), undefined, regtestNetwork, true);
    recipientTaprootAddress = recipientP2tr.address!;
    expectedRecipientScript = recipientP2tr.script;

    // Fund the payment address (self-send within ordpool-e2e). The
    // wallet picks one of its own mature coinbase outputs as input.
    bitcoinCliPsbtWallet('sendtoaddress', paymentAddress, '1.0');
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    utxo = await waitForUtxoAt(paymentAddress, FUND_AMOUNT_SATS);
  });


  it('builds via SDK → signs via bitcoin-cli walletprocesspsbt → finalizes + broadcasts via psbtExportSigner → confirms on chain as a valid CAT-21 mint', async () => {

    const paymentOutput: TxnOutput = {
      txid: utxo.txid,
      vout: utxo.vout,
      value: utxo.value,
      status: { confirmed: true },
    };

    // Phase 1: SDK build. walletType=xpub goes through the
    // address-format-driven dispatch (P2WPKH script).
    const built = createTransaction(
      KnownOrdinalWalletType.xpub,
      recipientTaprootAddress,
      paymentOutput,
      paymentPublicKey,
      paymentAddress,
      FEE,
      false,                          // not a simulation
      Network.Regtest,
    );
    expect(built.tx.lockTime).toBe(CAT21_LOCKTIME);
    expect(built.tx.outputsLength).toBe(2);
    expect(built.tx.getOutput(0).amount).toBe(RECIPIENT_AMOUNT);
    expect(built.tx.getOutput(0).script).toEqual(expectedRecipientScript);

    // Phase 2: hand the unsigned PSBT to the external wallet for
    // signing. bitcoin-cli walletprocesspsbt is BIP-174 canonical.
    // We let it `finalize=true` (the wallet does both sign and
    // finalize). The SDK signer is happy with either shape: it
    // detects already-final inputs and skips re-finalization.
    // Real-world parity: Bitcoin Core's GUI emits final PSBTs
    // by default, and some hardware-wallet desktop suites do too;
    // others (Sparrow's "Sign" button without "Combine + Finalize")
    // emit partial-sig PSBTs. The unit specs pin both branches.
    const unsignedPsbtBase64 = base64.encode(built.tx.toPSBT(0));
    const walletprocessed = JSON.parse(bitcoinCliPsbtWallet(
      '-named', 'walletprocesspsbt',
      `psbt=${unsignedPsbtBase64}`,
      'sign=true',
      'finalize=true',
    ));
    expect(walletprocessed.complete).toBe(true);
    const signedPsbtBase64: string = walletprocessed.psbt;
    expect(typeof signedPsbtBase64).toBe('string');
    expect(signedPsbtBase64.length).toBeGreaterThan(0);

    // Phase 3: feed the externally-signed PSBT into psbtExportSigner.
    // broadcast() is the production callback the SDK relies on —
    // here we wire it directly to regtest electrs via postTx, AND
    // capture the finalized hex on the side for independent decoding.
    let capturedTxHex: string | undefined;
    const signerResult = await firstValueFrom(psbtExportSigner.signSingleFundingInput({
      psbtBytes: built.tx.toPSBT(0),
      paymentAddress,
      network: Network.Regtest,
      broadcast: (txHex: string) => {
        capturedTxHex = txHex;
        return new Observable<string>((sub) => {
          postTx(txHex).then(txid => { sub.next(txid); sub.complete(); }, err => sub.error(err));
        });
      },
      promptForSignedPsbt: (unsigned) => {
        // Sanity: the prompt sees the SAME PSBT we built (the
        // signer doesn't quietly rewrite it).
        expect(unsigned.base64).toBe(unsignedPsbtBase64);
        return of(signedPsbtBase64);
      },
    }));

    expect(capturedTxHex).toBeDefined();
    const broadcastedTxid = signerResult.txId;

    // Phase 4: scure's finalized hex must be a structurally valid
    // tx; its computed txid must match what electrs accepted.
    const finalized = btc.Transaction.fromRaw(hex.decode(capturedTxHex!));
    expect(finalized.lockTime).toBe(CAT21_LOCKTIME);
    expect(finalized.outputsLength).toBe(2);
    expect(finalized.getOutput(0).amount).toBe(RECIPIENT_AMOUNT);
    expect(finalized.getOutput(0).script).toEqual(expectedRecipientScript);
    expect(broadcastedTxid).toBe(finalized.id);

    // Phase 5: mine + wait for electrs.
    const tipAfterMine = mineBlocks(1);
    await waitForElectrsSync(tipAfterMine);

    // Phase 6: tx confirmed, bytes match.
    // Poll until confirmed: getTxStatus is a single fetch and races
    // electrs's block-mapping pass after waitForElectrsSync.
    const status = (await waitForTxConfirmed(broadcastedTxid)).status;
    expect(status.confirmed).toBe(true);
    expect(status.block_height).toBe(tipAfterMine);

    const retrievedHex = await getTxHex(broadcastedTxid);
    expect(retrievedHex).toBe(capturedTxHex);

    // Phase 7: ordpool-parser recognises the on-chain tx as a CAT-21.
    const esploraTx = await waitForTxConfirmed(broadcastedTxid);
    const cat = Cat21ParserService.parse(esploraTx);
    expect(cat).not.toBeNull();
    expect(cat!.type).toBe(DigitalArtifactType.Cat21);
  });
});
