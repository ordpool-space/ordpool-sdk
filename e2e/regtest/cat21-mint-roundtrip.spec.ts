import { describe, expect, it, beforeAll } from '@jest/globals';
import { secp256k1 } from '@noble/curves/secp256k1';
import { base58, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { Cat21ParserService, DigitalArtifactType } from 'ordpool-parser';

import {
  createTransaction,
  getDummyKeypair,
} from '../../src/cat21-mint/cat21.service.helper';
import { TxnOutput } from '../../src/cat21-mint/cat21.service.types';
import { Network, toScureNetwork } from '../../src/network';
import { KnownOrdinalWalletType } from '../../src/wallet/wallet.service.types';
import {
  FundedAccount,
  getFundedAccount,
  getTxHex,
  waitForTxConfirmed,
  mineBlocks,
  postTx,
  rpc,
  waitForElectrsSync,
  waitForUtxoAt,
  waitForUtxoMatching,
} from './regtest-helpers';


// ─── shared CAT-21 invariants ────────────────────────────────────────
const CAT21_LOCKTIME      = 21;
const RECIPIENT_AMOUNT    = BigInt(546);   // canonical first-output value
const SIGHASH_ALL         = 0x01;
// Non-RBF-signaling sequence (BIP-125). Xverse only offers its
// "accelerate" replace-by-fee button when the input opts in
// (sequence < 0xfffffffe), and the replacement tx drops
// nLockTime=21, killing the cat. Stay at or above this.
const MIN_NON_RBF_SEQUENCE = 0xfffffffe;


/**
 * Decode a regtest WIF into the raw 32-byte private key. Regtest WIFs
 * use version byte 0xef (same as testnet, bitcoind treats regtest as
 * a flavour of testnet for address/key encoding).
 */
function wifToPrivateKey(wif: string): Uint8Array {
  const decoded = base58.decode(wif);
  // [version (1)] [privkey (32)] [compressed flag (1, optional)] [checksum (4)]
  return decoded.slice(1, 33);
}

/**
 * One mint scenario, a wallet path the SDK supports plus the
 * address-shape that wallet uses for payment inputs.
 *
 * The recipient address is always a Taproot output (CAT-21 ownership
 * lives at the first sat of the first output, single-key-controlled).
 * The varying axis here is the *input* shape: what kind of UTXO the
 * funder is spending.
 */
interface MintCase {
  label: string;
  walletType: KnownOrdinalWalletType;
  buildPayment: (pubkey: Uint8Array, network: typeof btc.NETWORK) => {
    address: string;
    script: Uint8Array;
  };
  /** Returns the payment pubkey shape the helper expects. */
  paymentPubkey: (compressedPubkey: Uint8Array) => Uint8Array;
  /** Legacy P2PKH inputs need the full funding tx hex (nonWitnessUtxo). */
  needsTransactionHex: boolean;
  /** Expected witness-blob count after finalize (for the SIGHASH_ALL probe). */
  expectedWitnessShape:
    | { kind: 'segwit_p2wpkh' }      // witness=[sig, pubkey], sighash is last byte of witness[0]
    | { kind: 'segwit_p2sh_p2wpkh' } // same witness shape; scriptSig holds the redeem-script push
    | { kind: 'segwit_p2tr' }        // witness=[schnorr_sig], 64 bytes = SIGHASH_DEFAULT
    | { kind: 'legacy_p2pkh' };      // no witness; scriptSig is [sig, pubkey], sighash is last byte of sig
}


const cases: MintCase[] = [
  {
    label: 'Leather (Native SegWit / P2WPKH)',
    walletType: KnownOrdinalWalletType.leather,
    buildPayment: (pk, net) => btc.p2wpkh(pk, net) as { address: string; script: Uint8Array },
    paymentPubkey: (pk) => pk,
    needsTransactionHex: false,
    expectedWitnessShape: { kind: 'segwit_p2wpkh' },
  },
  {
    label: 'Xverse (Nested SegWit / P2SH-P2WPKH)',
    walletType: KnownOrdinalWalletType.xverse,
    buildPayment: (pk, net) => {
      const sh = btc.p2sh(btc.p2wpkh(pk, net), net);
      return { address: sh.address!, script: sh.script };
    },
    paymentPubkey: (pk) => pk,
    needsTransactionHex: false,
    expectedWitnessShape: { kind: 'segwit_p2sh_p2wpkh' },
  },
  {
    label: 'Unisat (Taproot / P2TR)',
    walletType: KnownOrdinalWalletType.unisat,
    buildPayment: (pk, net) => {
      const tr = btc.p2tr(pk.subarray(1, 33), undefined, net, true);
      return { address: tr.address!, script: tr.script };
    },
    paymentPubkey: (pk) => pk,   // helper toXOnly's internally for unisat-taproot
    needsTransactionHex: false,
    expectedWitnessShape: { kind: 'segwit_p2tr' },
  },
  {
    label: 'Unisat (Legacy / P2PKH)',
    walletType: KnownOrdinalWalletType.unisat,
    buildPayment: (pk, net) => {
      const pkh = btc.p2pkh(pk, net);
      return { address: pkh.address!, script: pkh.script };
    },
    paymentPubkey: (pk) => pk,
    needsTransactionHex: true,
    expectedWitnessShape: { kind: 'legacy_p2pkh' },
  },
];


describe('cat21 mint roundtrip on regtest', () => {

  const regtestNetwork = toScureNetwork(Network.Regtest);

  let funded: FundedAccount;
  let funderPrivateKey: Uint8Array;
  let funderPublicKey: Uint8Array;
  let recipientTaprootAddress: string;
  let expectedRecipientScript: Uint8Array;

  /** Per-case funding info, keyed by label. */
  const funding: Record<string, {
    paymentAddress: string;
    paymentScript: Uint8Array;
    fundingTxid: string;
    transactionHex?: string;
  }> = {};
  /**
   * Dust-absorb branch uses its own keypair, separate from the funder,
   * so its 1000-sat dust UTXO sits at a dedicated address. That keeps
   * it unambiguous — never tangled with the funder's per-case funding
   * UTXOs when the SDK looks up spendable outputs for the dust mint
   * (the funder's P2WPKH case address would otherwise carry both).
   */
  let dustPrivateKey: Uint8Array;
  let dustPublicKey: Uint8Array;
  let dustPaymentAddress: string;
  let dustPaymentScript: Uint8Array;
  const DUST_AMOUNT_SATS = 1000;

  beforeAll(async () => {
    funded = getFundedAccount();
    funderPrivateKey = wifToPrivateKey(funded.wif);
    funderPublicKey  = secp256k1.getPublicKey(funderPrivateKey, true);

    // Recipient is fixed across all cases, Taproot.
    const p2tr = btc.p2tr(funderPublicKey.subarray(1, 33), undefined, regtestNetwork, true);
    recipientTaprootAddress = p2tr.address!;
    expectedRecipientScript = p2tr.script;

    // Bootstrap mines exactly 101 blocks, so only the block-1
    // coinbase is mature. We need two separate mature 50-BTC inputs
    // (one for dust, one for the main funding tx). Mine 2 more.
    let tip = mineBlocks(2);
    await waitForElectrsSync(tip);

    // Pin inputs explicitly so each `send` spends a specific mature
    // coinbase. The bitcoind wallet holds only its own coinbases (the
    // funder key is foreign to it), so once we pin, coin selection
    // can't reach for a coinbase a later step depends on. Keeps the
    // funding deterministic and reproducible.
    //
    // listunspent yields every wallet UTXO; we pick two mature
    // 50-BTC coinbases as funding sources (one for the dust send,
    // one for the sendmany).
    type Unspent = { txid: string; vout: number; amount: number; spendable: boolean; confirmations: number };
    // minconf=100 filters server-side to mature outputs; we still
    // check `spendable` + value because the wallet may hold non-coinbase
    // entries after later sends (it doesn't here, but keep the guard).
    const unspent: Unspent[] = JSON.parse(rpc('-rpcwallet=ordpool-e2e', 'listunspent', '100'));
    const matureCoinbases = unspent
      .filter(u => u.spendable && u.amount === 50)
      .sort((a, b) => b.confirmations - a.confirmations); // deepest first
    if (matureCoinbases.length < 2) {
      throw new Error(`need >=2 mature 50-BTC coinbases, got ${matureCoinbases.length}`);
    }
    const [dustInput, sendmanyInput] = matureCoinbases;

    // Dust UTXO: separate keypair so the wallet doesn't claim it.
    dustPrivateKey = secp256k1.utils.randomPrivateKey();
    dustPublicKey  = secp256k1.getPublicKey(dustPrivateKey, true);
    const dustPaymentScure = btc.p2wpkh(dustPublicKey, regtestNetwork);
    dustPaymentAddress = dustPaymentScure.address!;
    dustPaymentScript  = dustPaymentScure.script;
    rpc(
      '-named', '-rpcwallet=ordpool-e2e', 'send',
      `outputs=${JSON.stringify([{ [dustPaymentAddress]: 0.00001 }])}`,
      `options=${JSON.stringify({ inputs: [{ txid: dustInput.txid, vout: dustInput.vout }] })}`,
    );

    // Fund the 4 case addresses in one tx, also with a pinned input.
    const recipientList: Array<Record<string, number>> = [];
    for (const c of cases) {
      const payment = c.buildPayment(funderPublicKey, regtestNetwork);
      funding[c.label] = {
        paymentAddress: payment.address,
        paymentScript: payment.script,
        fundingTxid: '',
      };
      recipientList.push({ [payment.address]: 1.0 });
    }
    const sendResult = JSON.parse(rpc(
      '-named', '-rpcwallet=ordpool-e2e', 'send',
      `outputs=${JSON.stringify(recipientList)}`,
      `options=${JSON.stringify({ inputs: [{ txid: sendmanyInput.txid, vout: sendmanyInput.vout }] })}`,
    ));
    for (const c of cases) {
      funding[c.label].fundingTxid = sendResult.txid;
    }

    tip = mineBlocks(1);
    await waitForElectrsSync(tip);

    // Legacy P2PKH input needs the full funding-tx hex (nonWitnessUtxo).
    // The sendmany tx hex is the same for every case, its vout index
    // is what differs per case (each case looks itself up by address).
    for (const c of cases.filter(c => c.needsTransactionHex)) {
      funding[c.label].transactionHex = await getTxHex(funding[c.label].fundingTxid);
    }
  });


  // ───────────────────────────────────────────────────────────────────
  // Change-branch happy path, one variant per supported wallet/input shape.
  // The full 11-phase assertion suite runs for every case.
  // ───────────────────────────────────────────────────────────────────
  describe.each(cases)('change-branch via $label', (testCase) => {

    it('builds + signs + broadcasts a CAT-21 mint and pins every on-chain invariant', async () => {

      const FEE = BigInt(2_000);
      const { paymentAddress, paymentScript: expectedChangeScript, transactionHex, fundingTxid } = funding[testCase.label];

      // ─── Phase 1: real UTXO via electrs ───
      // Pick by source-tx (txid we sent in beforeAll). Picking by
      // value alone goes wrong if the address has other UTXOs of the
      // same value, Unisat-Legacy reuses the bootstrap coinbase
      // address, Leather also holds a dust UTXO for the dust-absorb
      // test. Source-txid is unambiguous.
      const utxo = await waitForUtxoMatching(
        paymentAddress,
        u => u.txid === fundingTxid && u.value === 100_000_000,
        `txid=${fundingTxid} value=100_000_000`,
      );
      const inputValue = BigInt(utxo.value);

      const paymentOutput: TxnOutput = {
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.value,
        status: utxo.status,
        transactionHex,
      };
      const expectedChangeAmount = inputValue - RECIPIENT_AMOUNT - FEE;
      const paymentPubkey = testCase.paymentPubkey(funderPublicKey);

      // ─── Phase 2: build via helper ───
      const result = createTransaction(
        testCase.walletType,
        recipientTaprootAddress,
        paymentOutput,
        paymentPubkey,
        paymentAddress,
        FEE,
        false,
        Network.Regtest,
      );
      expect(result.amountToRecipient).toBe(RECIPIENT_AMOUNT);
      expect(result.singleInputAmount).toBe(inputValue);
      expect(result.changeAmount).toBe(expectedChangeAmount);
      expect(result.finalTransactionFee).toBe(FEE);

      const { tx } = result;

      // ─── Phase 3: pre-broadcast structure ───
      expect(tx.lockTime).toBe(CAT21_LOCKTIME);
      expect(tx.outputsLength).toBe(2);

      // Output ordering, CAT-21 ownership lives at first sat of first output.
      const out0 = tx.getOutput(0);
      const out1 = tx.getOutput(1);
      expect(out0.amount).toBe(RECIPIENT_AMOUNT);
      expect(out0.script).toEqual(expectedRecipientScript);
      expect(out1.amount).toBe(expectedChangeAmount);
      expect(out1.script).toEqual(expectedChangeScript);

      // ─── Phase 4: simulation vsize matches the real-signed vsize ───
      const sim = createTransaction(
        testCase.walletType,
        recipientTaprootAddress,
        paymentOutput,
        paymentPubkey,
        paymentAddress,
        FEE,
        true,                         // simulation
        Network.Regtest,
      );
      const { dummyPrivateKey } = getDummyKeypair(regtestNetwork);
      // Taproot inputs in the SDK now omit `sighashType`
      // (SIGHASH_DEFAULT, wire-equivalent to SIGHASH_ALL per
      // BIP-341); allow both shapes so the Taproot test case
      // doesn't trip scure's allowed-sighash check.
      sim.tx.signIdx(dummyPrivateKey, 0, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
      sim.tx.finalize();

      // ─── Phase 5: sign + finalize the real tx ───
      tx.signIdx(funderPrivateKey, 0, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
      tx.finalize();
      // ECDSA DER signatures vary by 0-2 bytes depending on whether
      // r/s components hit a high bit and need a leading zero. For
      // legacy P2PKH inputs that variance lands 1:1 in vsize; for
      // SegWit it usually rounds away but can still drift by 1.
      // The simulation's fee estimate is "within a couple of sats"
      // accurate, not byte-exact.
      expect(Math.abs(tx.vsize - sim.tx.vsize)).toBeLessThanOrEqual(2);

      // ─── Phase 6: SIGHASH_ALL + non-RBF sequence ───
      const finalized = btc.Transaction.fromRaw(hex.decode(tx.hex));
      const input0 = finalized.getInput(0);
      assertSighashAll(input0, testCase.expectedWitnessShape);
      expect(input0.sequence).toBeGreaterThanOrEqual(MIN_NON_RBF_SEQUENCE);

      // ─── Phase 7: broadcast ───
      const broadcastedTxid = await postTx(tx.hex);
      expect(broadcastedTxid).toBe(tx.id);

      // ─── Phase 8: mine + wait for electrs ───
      const tipAfterMine = mineBlocks(1);
      await waitForElectrsSync(tipAfterMine);

      // ─── Phase 9: confirmation + bytes round-trip ───
      // Poll until confirmed: getTxStatus is a single fetch and races
      // electrs's block-mapping pass after waitForElectrsSync (which only
      // tracks tip height). waitForTxConfirmed polls status.confirmed +
      // block_hash.
      const status = (await waitForTxConfirmed(broadcastedTxid)).status;
      expect(status.confirmed).toBe(true);
      expect(status.block_height).toBe(tipAfterMine);

      const retrievedHex = await getTxHex(broadcastedTxid);
      expect(retrievedHex).toBe(tx.hex);

      // ─── Phase 10: re-parse the on-chain bytes, re-assert ───
      const onChain = btc.Transaction.fromRaw(hex.decode(retrievedHex));
      expect(onChain.lockTime).toBe(CAT21_LOCKTIME);
      expect(onChain.outputsLength).toBe(2);
      expect(onChain.getOutput(0).amount).toBe(RECIPIENT_AMOUNT);
      expect(onChain.getOutput(0).script).toEqual(expectedRecipientScript);
      expect(onChain.getOutput(1).amount).toBe(expectedChangeAmount);
      expect(onChain.getOutput(1).script).toEqual(expectedChangeScript);

      const onChainInput0 = onChain.getInput(0);
      expect(onChainInput0.sequence).toBeGreaterThanOrEqual(MIN_NON_RBF_SEQUENCE);
      assertSighashAll(onChainInput0, testCase.expectedWitnessShape);

      // ─── Phase 11: ordpool-parser identifies the on-chain tx as a CAT-21 ───
      const esploraTx = await waitForTxConfirmed(broadcastedTxid);
      // eslint-disable-next-line no-console
      console.log(`[e2e:${testCase.label}] txid       = ${esploraTx.txid}`);
      // eslint-disable-next-line no-console
      console.log(`[e2e:${testCase.label}] block_hash = ${esploraTx.status.block_hash}`);

      expect(esploraTx.locktime).toBe(CAT21_LOCKTIME);
      expect(esploraTx.status.block_hash).toBeTruthy();

      const parsed = Cat21ParserService.parse(esploraTx);
      expect(parsed).not.toBeNull();
      expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
      expect(parsed!.transactionId).toBe(broadcastedTxid);
      expect(parsed!.blockId).toBe(esploraTx.status.block_hash);
      expect(parsed!.uniqueId).toBe(
        `${DigitalArtifactType.Cat21}-${broadcastedTxid}-${esploraTx.status.block_hash}`
      );
      expect(parsed!.getImage()).toMatch(/^<svg/);
      expect(parsed!.getTraits()).not.toBeNull();
    });
  });


  // ───────────────────────────────────────────────────────────────────
  // Dust-absorb branch: when change would land below the dust limit,
  // it folds into the miner fee. CAT-21 *feature* (rarer color via
  // higher feeRate, faster confirmation), don't "fix" it.
  // ───────────────────────────────────────────────────────────────────
  describe('dust-absorb branch (sub-dust change folds into the miner fee)', () => {

    it('emits a single 546-sat recipient output and zero change', async () => {

      const dustUtxo = await waitForUtxoAt(dustPaymentAddress, DUST_AMOUNT_SATS);

      const inputValue = BigInt(dustUtxo.value);   // 1000 sats
      const FEE_INPUT  = BigInt(300);
      // 1000 - 546 - 300 = 154 < dust limit 294 (for P2WPKH) → absorb branch.
      // After absorb: change folds into fee → finalFee = 300 + 154 = 454, output count = 1.
      const EXPECTED_FOLDED_CHANGE = BigInt(154);
      const EXPECTED_FINAL_FEE     = FEE_INPUT + EXPECTED_FOLDED_CHANGE;

      const paymentOutput: TxnOutput = {
        txid: dustUtxo.txid,
        vout: dustUtxo.vout,
        value: dustUtxo.value,
        status: dustUtxo.status,
      };

      const result = createTransaction(
        KnownOrdinalWalletType.leather,
        recipientTaprootAddress,
        paymentOutput,
        dustPublicKey,
        dustPaymentAddress,
        FEE_INPUT,
        false,
        Network.Regtest,
      );

      // helper return values reflect the absorbed branch
      expect(result.amountToRecipient).toBe(RECIPIENT_AMOUNT);
      expect(result.singleInputAmount).toBe(inputValue);
      expect(result.changeAmount).toBe(BigInt(0));
      expect(result.finalTransactionFee).toBe(EXPECTED_FINAL_FEE);

      const { tx } = result;
      expect(tx.lockTime).toBe(CAT21_LOCKTIME);

      // Critical: ONE output. The recipient still gets exactly 546
      // sats, the dust goes to the miner. Any future refactor that
      // pads the recipient with the dust would silently break holders'
      // expectation that every Cat lives on a 546-sat UTXO.
      expect(tx.outputsLength).toBe(1);
      const onlyOutput = tx.getOutput(0);
      expect(onlyOutput.amount).toBe(RECIPIENT_AMOUNT);
      expect(onlyOutput.script).toEqual(expectedRecipientScript);
      // payment-address script never appears as an output in this branch
      expect(onlyOutput.script).not.toEqual(dustPaymentScript);

      // ─── sign + broadcast + mine ───
      tx.signIdx(dustPrivateKey, 0, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
      tx.finalize();
      const broadcastedTxid = await postTx(tx.hex);
      expect(broadcastedTxid).toBe(tx.id);
      const tipAfterMine = mineBlocks(1);
      await waitForElectrsSync(tipAfterMine);

      // ─── electrs sees one output worth 546, fee 454 ───
      const esploraTx = await waitForTxConfirmed(broadcastedTxid);
      // eslint-disable-next-line no-console
      console.log(`[e2e:dust-absorb] txid       = ${esploraTx.txid}`);
      // eslint-disable-next-line no-console
      console.log(`[e2e:dust-absorb] block_hash = ${esploraTx.status.block_hash}`);

      expect(esploraTx.locktime).toBe(CAT21_LOCKTIME);
      expect(esploraTx.vout).toHaveLength(1);
      expect(esploraTx.fee).toBe(Number(EXPECTED_FINAL_FEE));

      // Parser still recognises it as a CAT-21 (1-output mints are valid).
      const parsed = Cat21ParserService.parse(esploraTx);
      expect(parsed).not.toBeNull();
      expect(parsed!.type).toBe(DigitalArtifactType.Cat21);
    });
  });
});


/**
 * SIGHASH_ALL check that adapts to whichever input-script shape the
 * tx uses.
 *
 * - P2WPKH / P2SH-P2WPKH: witness = [signature_der_with_sighash_byte, pubkey],
 *   the last byte of `witness[0]` is the sighash type.
 * - P2TR (keypath): witness = [schnorr_signature], 64 bytes for the
 *   default sighash (BIP-341 says SIGHASH_DEFAULT == SIGHASH_ALL),
 *   65 bytes if explicit. We accept either: 64-byte → DEFAULT,
 *   65-byte → last byte must be 0x01.
 * - Legacy P2PKH: scriptSig holds [push <signature>, push <pubkey>].
 *   The signature is the first pushdata; its final byte is the sighash.
 */
function assertSighashAll(
  input: { finalScriptWitness?: Uint8Array[]; finalScriptSig?: Uint8Array },
  shape: MintCase['expectedWitnessShape'],
): void {
  if (shape.kind === 'segwit_p2wpkh' || shape.kind === 'segwit_p2sh_p2wpkh') {
    const witness = input.finalScriptWitness;
    expect(witness).toBeDefined();
    expect(witness!).toHaveLength(2);
    const sig = witness![0];
    expect(sig[sig.length - 1]).toBe(SIGHASH_ALL);
    return;
  }
  if (shape.kind === 'segwit_p2tr') {
    const witness = input.finalScriptWitness;
    expect(witness).toBeDefined();
    expect(witness!).toHaveLength(1);
    const sig = witness![0];
    // 64 bytes → SIGHASH_DEFAULT (== SIGHASH_ALL implicit, BIP-341).
    // 65 bytes → explicit sighash byte at the end, must be 0x01.
    if (sig.length === 64) return;
    expect(sig).toHaveLength(65);
    expect(sig[64]).toBe(SIGHASH_ALL);
    return;
  }
  // legacy_p2pkh: scriptSig is two pushdata items: <signature> <pubkey>.
  // The first item is a single-byte length prefix followed by the
  // signature; the sighash byte is the last byte of that signature.
  const scriptSig = input.finalScriptSig;
  expect(scriptSig).toBeDefined();
  const sigLen = scriptSig![0];
  const sig = scriptSig!.subarray(1, 1 + sigLen);
  expect(sig[sig.length - 1]).toBe(SIGHASH_ALL);
}
