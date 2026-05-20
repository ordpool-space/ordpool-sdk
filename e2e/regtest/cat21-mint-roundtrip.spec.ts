import { describe, expect, it, beforeAll } from '@jest/globals';
import { secp256k1 } from '@noble/curves/secp256k1';
import { base58, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { execSync } from 'node:child_process';

import {
  createTransaction,
  getDummyKeypair,
} from '../../src/cat21-mint/cat21.service.helper';
import { TxnOutput } from '../../src/cat21-mint/cat21.service.types';
import { Network, toScureNetwork } from '../../src/network';
import { KnownOrdinalWalletType } from '../../src/wallet/wallet.service.types';
import {
  ElectrsUtxo,
  FundedAccount,
  getFundedAccount,
  getTxHex,
  getTxStatus,
  getUtxos,
  mineBlocks,
  postTx,
  waitForElectrsSync,
} from './regtest-helpers';


/**
 * Decode a regtest WIF (Wallet Import Format) into the raw 32-byte
 * private key. Regtest WIFs use version byte 0xef (same as testnet —
 * bitcoind treats regtest as a flavour of testnet for address/key
 * encoding).
 */
function wifToPrivateKey(wif: string): Uint8Array {
  const decoded = base58.decode(wif);
  // [version (1)] [privkey (32)] [compressed flag (1, optional)] [checksum (4)]
  return decoded.slice(1, 33);
}


describe('cat21 mint roundtrip on regtest', () => {

  const regtestNetwork = toScureNetwork(Network.Regtest);

  let funded: FundedAccount;
  let funderPrivateKey: Uint8Array;
  let funderPublicKey: Uint8Array;
  let funderWpkhAddress: string;
  let recipientTaprootAddress: string;
  let expectedRecipientScript: Uint8Array;
  let expectedChangeScript: Uint8Array;

  beforeAll(async () => {
    funded = getFundedAccount();
    funderPrivateKey = wifToPrivateKey(funded.wif);
    funderPublicKey = secp256k1.getPublicKey(funderPrivateKey, true);

    // Mint a CAT-21 from a SegWit input — derive a P2WPKH address
    // from the funder's key, fund it from the bootstrap's legacy
    // coinbase wallet.
    const wpkh = btc.p2wpkh(funderPublicKey, regtestNetwork);
    funderWpkhAddress = wpkh.address!;
    expectedChangeScript = wpkh.script;

    // Recipient = same funder, on a Taproot address. CAT-21 ownership
    // attaches to the first sat of the first output, which has to be
    // a single, address-keyed UTXO — taproot is the canonical choice.
    const p2tr = btc.p2tr(funderPublicKey.subarray(1, 33), undefined, regtestNetwork, true);
    recipientTaprootAddress = p2tr.address!;
    expectedRecipientScript = p2tr.script;

    const sendCmd = `docker exec ordpool-e2e-bitcoind bitcoin-cli -regtest -rpcuser=ordpool -rpcpassword=ordpool -rpcwallet=ordpool-e2e sendtoaddress ${funderWpkhAddress} 1.0`;
    execSync(sendCmd, { encoding: 'utf8' });
    const tipAfterMine = mineBlocks(1);
    await waitForElectrsSync(tipAfterMine);
  });

  it('builds a real CAT-21 mint, broadcasts it, and pins every on-chain invariant', async () => {

    const FEE                       = BigInt(2_000);
    const EXPECTED_RECIPIENT_AMOUNT = BigInt(546);   // CAT-21 canonical first-output value
    const CAT21_LOCKTIME            = 21;
    const SIGHASH_ALL               = 0x01;
    const SEQUENCE_CAT_KILLER       = 0xfffffffd;    // do NOT match this — see cat21.service.helper.ts

    // ─── Phase 1: real UTXO via electrs (the API surface our SDK actually hits) ───
    const utxos: ElectrsUtxo[] = await getUtxos(funderWpkhAddress);
    expect(utxos.length).toBeGreaterThan(0);
    const utxo = utxos[0];
    const inputValue = BigInt(utxo.value);
    expect(inputValue).toBe(BigInt(100_000_000)); // we funded with exactly 1 BTC

    const paymentOutput: TxnOutput = {
      txid: utxo.txid,
      vout: utxo.vout,
      value: utxo.value,
      status: utxo.status,
    };
    const expectedChangeAmount = inputValue - EXPECTED_RECIPIENT_AMOUNT - FEE;

    // ─── Phase 2: build the mint via the SDK helper, verify the return values ───
    const result = createTransaction(
      KnownOrdinalWalletType.leather, // P2WPKH input path
      recipientTaprootAddress,
      paymentOutput,
      funderPublicKey,
      funderWpkhAddress,
      FEE,
      false,                          // not a simulation
      Network.Regtest,
    );
    expect(result.amountToRecipient).toBe(EXPECTED_RECIPIENT_AMOUNT);
    expect(result.singleInputAmount).toBe(inputValue);
    expect(result.changeAmount).toBe(expectedChangeAmount);
    expect(result.finalTransactionFee).toBe(FEE);

    const { tx } = result;

    // ─── Phase 3: pre-broadcast invariants on the unsigned tx ───
    expect(tx.lockTime).toBe(CAT21_LOCKTIME);
    expect(tx.outputsLength).toBe(2);

    // Output ordering matters: CAT-21 ownership = first sat of first
    // output. output[0] MUST be the recipient, output[1] MUST be change.
    // Swap these by accident and the cat goes to the wrong address.
    const out0 = tx.getOutput(0);
    const out1 = tx.getOutput(1);
    expect(out0.amount).toBe(EXPECTED_RECIPIENT_AMOUNT);
    expect(out0.script).toEqual(expectedRecipientScript);
    expect(out1.amount).toBe(expectedChangeAmount);
    expect(out1.script).toEqual(expectedChangeScript);

    // ─── Phase 4: simulate vsize, compare against the real signed tx ───
    // The simulation uses a dummy keypair so the fee-estimator UI can
    // compute vsize without prompting the user. The dummy-signed and
    // really-signed txs have the same script layout — vsize must match.
    const sim = createTransaction(
      KnownOrdinalWalletType.leather,
      recipientTaprootAddress,
      paymentOutput,
      funderPublicKey,
      funderWpkhAddress,
      FEE,
      true,                           // simulation
      Network.Regtest,
    );
    const { dummyPrivateKey } = getDummyKeypair(regtestNetwork);
    sim.tx.signIdx(dummyPrivateKey, 0, [btc.SigHash.ALL]);
    sim.tx.finalize();
    const simulatedVsize = sim.tx.vsize;

    // ─── Phase 5: sign + finalize the real tx ───
    tx.signIdx(funderPrivateKey, 0, [btc.SigHash.ALL]);
    tx.finalize();
    expect(tx.vsize).toBe(simulatedVsize);

    // ─── Phase 6: introspect the witness — SIGHASH_ALL on every signature ───
    // P2WPKH witness layout: [signature_der_with_sighash_byte, pubkey].
    // The last byte of the signature blob is the sighash type.
    const finalized = btc.Transaction.fromRaw(hex.decode(tx.hex));
    const input0Final = finalized.getInput(0);
    const witness = input0Final.finalScriptWitness;
    expect(witness).toBeDefined();
    expect(witness!).toHaveLength(2);
    const signatureBytes = witness![0];
    expect(signatureBytes[signatureBytes.length - 1]).toBe(SIGHASH_ALL);

    // Sequence: do NOT match the "cat killer" value. Comment in
    // cat21.service.helper.ts:373 calls out 0xfffffffd specifically.
    expect(input0Final.sequence).not.toBe(SEQUENCE_CAT_KILLER);

    // ─── Phase 7: broadcast — bitcoind must accept the bytes ───
    const broadcastedTxid = await postTx(tx.hex);
    expect(broadcastedTxid).toBe(tx.id);

    // ─── Phase 8: mine + wait for electrs to index ───
    const tipAfterMine = mineBlocks(1);
    await waitForElectrsSync(tipAfterMine);

    // ─── Phase 9: confirmation status + bytes survive the round-trip ───
    const status = await getTxStatus(broadcastedTxid);
    expect(status.confirmed).toBe(true);
    expect(status.block_height).toBe(tipAfterMine);

    const retrievedHex = await getTxHex(broadcastedTxid);
    expect(retrievedHex).toBe(tx.hex);

    // ─── Phase 10: re-parse the on-chain bytes, re-assert every invariant ───
    // Everything we set must survive scure-serialize → POST /tx →
    // bitcoind acceptance → block inclusion → electrs reindex → GET /tx.
    const onChain = btc.Transaction.fromRaw(hex.decode(retrievedHex));
    expect(onChain.lockTime).toBe(CAT21_LOCKTIME);
    expect(onChain.outputsLength).toBe(2);

    const onChainOut0 = onChain.getOutput(0);
    const onChainOut1 = onChain.getOutput(1);
    expect(onChainOut0.amount).toBe(EXPECTED_RECIPIENT_AMOUNT);
    expect(onChainOut0.script).toEqual(expectedRecipientScript);
    expect(onChainOut1.amount).toBe(expectedChangeAmount);
    expect(onChainOut1.script).toEqual(expectedChangeScript);

    const onChainInput0 = onChain.getInput(0);
    expect(onChainInput0.sequence).not.toBe(SEQUENCE_CAT_KILLER);
    const onChainWitness = onChainInput0.finalScriptWitness;
    expect(onChainWitness).toBeDefined();
    expect(onChainWitness![0][onChainWitness![0].length - 1]).toBe(SIGHASH_ALL);
  });
});
