/**
 * Transfer byte-parity vs LIVE `ord wallet send`.
 *
 * The SDK transfer, built with ord-parity coin selection + fee
 * (`selectOrdParityFunding`), must be byte-identical to what stock ord's
 * `wallet send` produces for the same cat + the same available UTXOs — except
 * the two things that MUST differ: `nLockTime` (ord 0, us 21 for the bonus cat)
 * and the change output's address (ord derives its own; ours is the sender's).
 *
 * Setup: a fresh ord wallet owns exactly a cat (546) + ONE cardinal UTXO, so
 * coin selection is forced (the maintainer's point: with one candidate, our
 * pick == ord's pick by definition). We run `ord wallet send --dry-run
 * --postage <target>` for ord's reference tx, build ours for the same inputs,
 * and assert equality on every field but locktime + change script.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { secp256k1 } from '@noble/curves/secp256k1';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { buildCat21TransferPsbt } from '../../src/cat21-transfer/cat21-transfer.helper';
import { selectOrdParityFunding } from '../../src/cat21-fee/ord-coin-select';
import { CAT21_WALLET_INPUT_SEQUENCE } from '../../src/cat21-protocol/cat21-sequence';
import { Network, toScureNetwork } from '../../src/network';
import { KnownOrdinalWalletType } from '../../src/wallet/wallet.service.types';
import {
  catInscriptionId,
  getUtxos,
  mineBlocks,
  ordCreateWallet,
  ordWalletSend,
  postTx,
  rpc,
  waitForElectrsSync,
  waitForOrdReady,
  waitForOrdSync,
  waitForTxConfirmed,
  waitForUtxoAt,
} from './regtest-helpers';

const FEE_RATE = 2; // integer sat/vB — removes rounding as a variable
const TARGET_POSTAGE = 10_000; // grow the 546 cat to an exact 10k postage

/** P2TR scriptPubKey length in bytes. */
const P2TR_SCRIPT_LEN = 34;

const bytesEqual = (a?: Uint8Array, b?: Uint8Array): boolean =>
  !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

describe('transfer byte-parity vs live `ord wallet send`', () => {
  const regtestNetwork = toScureNetwork(Network.Regtest);

  let ordWalletAddress: string;
  let catTxid: string;
  let inscriptionId: string;
  let catScript: Uint8Array;
  let cardinal: { txid: string; vout: number; value: number; script: Uint8Array };

  beforeAll(async () => {
    let tip = mineBlocks(3);
    await waitForElectrsSync(tip);
    await waitForOrdReady();
    await waitForOrdSync(tip);

    // A fresh, cat-aware ord wallet whose UTXO set we fully control.
    ordWalletAddress = ordCreateWallet('ordsend');
    expect(ordWalletAddress).toMatch(/^bcrt1p/); // ord wallets are taproot

    // Give it exactly ONE cardinal UTXO (1 BTC).
    rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', ordWalletAddress, '1.0');
    // Fund a mint source for the cat.
    const minterPriv = secp256k1.utils.randomPrivateKey();
    const minterAddr = btc.p2wpkh(secp256k1.getPublicKey(minterPriv, true), regtestNetwork).address!;
    const minterScript = btc.p2wpkh(secp256k1.getPublicKey(minterPriv, true), regtestNetwork).script;
    rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', minterAddr, '0.2');
    tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdSync(tip);

    // Mint a cat (nLockTime=21, 546) TO the ord wallet's address so the ord
    // wallet owns it and `wallet send` can move it.
    const minterUtxo = await waitForUtxoAt(minterAddr, 20_000_000);
    const mint = new btc.Transaction({ lockTime: 21 });
    mint.addInput({
      txid: minterUtxo.txid,
      index: minterUtxo.vout,
      sequence: 0xfffffffe,
      witnessUtxo: { script: minterScript, amount: BigInt(minterUtxo.value) },
    });
    mint.addOutputAddress(ordWalletAddress, BigInt(546), regtestNetwork); // the cat, to the ord wallet
    mint.addOutputAddress(minterAddr, BigInt(minterUtxo.value - 546 - 1_000), regtestNetwork);
    mint.signIdx(minterPriv, 0, [btc.SigHash.ALL]);
    mint.finalize();
    catTxid = mint.id;
    await postTx(mint.hex);
    tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForTxConfirmed(catTxid);
    await waitForOrdSync(tip);

    inscriptionId = catInscriptionId(catTxid);

    // Resolve the ord wallet's UTXOs: the cat (546) and the cardinal (1 BTC).
    const utxos = await getUtxos(ordWalletAddress);
    const catUtxo = utxos.find((u) => u.txid === catTxid && u.vout === 0)!;
    const cardinalUtxo = utxos.find((u) => u.value === 100_000_000)!;
    expect(catUtxo).toBeTruthy();
    expect(cardinalUtxo).toBeTruthy();

    // The ord wallet's taproot scriptPubKey, taken authoritatively from the
    // on-chain output (same address for both its UTXOs).
    const catOut = JSON.parse(rpc('gettxout', catTxid, '0')) as {
      scriptPubKey: { hex: string };
    };
    const spk = hex.decode(catOut.scriptPubKey.hex);
    catScript = spk;
    cardinal = { txid: cardinalUtxo.txid, vout: cardinalUtxo.vout, value: cardinalUtxo.value, script: spk };
  }, 180_000);

  it('SDK transfer == `ord wallet send --postage 10000` on every field but locktime + change addr', () => {
    // Recipient: a fresh taproot address (match ord's all-taproot fee model).
    const recipientAddr = btc.p2tr(
      secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true).slice(1),
      undefined,
      regtestNetwork,
    ).address!;
    // Our own change: also taproot, so output script lengths match ord's.
    const ourChangeAddr = btc.p2tr(
      secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true).slice(1),
      undefined,
      regtestNetwork,
    ).address!;

    // ── ord's reference tx (live `wallet send --dry-run`) ──
    const ordSend = ordWalletSend(recipientAddr, inscriptionId, FEE_RATE, TARGET_POSTAGE, 'ordsend');
    const ordTx = btc.Transaction.fromPSBT(base64.decode(ordSend.psbt));

    // ── ord-parity coin selection for OUR builder ──
    const funding = selectOrdParityFunding({
      outgoingValueSats: 546,
      targetPostageSats: TARGET_POSTAGE,
      feeRatePerVb: FEE_RATE,
      cardinalUtxos: [{ txid: cardinal.txid, vout: cardinal.vout, value: cardinal.value }],
      outgoingScriptLen: P2TR_SCRIPT_LEN,
      changeScriptLen: P2TR_SCRIPT_LEN,
      changeDustSats: 330,
    });
    if ('error' in funding) throw new Error(funding.error);

    const sdk = buildCat21TransferPsbt({
      walletType: KnownOrdinalWalletType.cat21wallet,
      network: Network.Regtest,
      catUtxo: { txid: catTxid, vout: 0, value: 546, scriptPubKey: catScript },
      fundingInputs: funding.fundingInputs.map((u) => ({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        scriptPubKey: cardinal.script,
      })),
      destinations: { recipientAddress: recipientAddr, senderChangeAddress: ourChangeAddr },
      feeSats: funding.feeSats,
      targetPostageSats: TARGET_POSTAGE,
    });
    const sdkTx = btc.Transaction.fromPSBT(sdk.psbt);

    // ── diagnostics (surface any drift on the first run) ──
    const dump = (label: string, tx: btc.Transaction) => {
      const ins = Array.from({ length: tx.inputsLength }, (_, i) => {
        const inp = tx.getInput(i);
        return `${inp.txid ? Buffer.from(inp.txid).toString('hex').slice(0, 12) : '?'}:${inp.index} seq=${inp.sequence?.toString(16)}`;
      });
      const outs = Array.from({ length: tx.outputsLength }, (_, i) => {
        const o = tx.getOutput(i);
        return `${o.amount} (${o.script?.length}b)`;
      });
      // eslint-disable-next-line no-console
      console.log(`[${label}] v${tx.version} lock=${tx.lockTime} in=[${ins.join(', ')}] out=[${outs.join(', ')}]`);
    };
    dump('ord', ordTx);
    dump('sdk', sdkTx);

    // ── the parity assertions ──
    expect(sdkTx.version).toBe(ordTx.version); // both 2

    // Inputs: same count, same outpoints (cat then cardinal), same sequences.
    expect(sdkTx.inputsLength).toBe(ordTx.inputsLength);
    // Locate ord's cat + cardinal inputs by outpoint.
    const findIdx = (tx: btc.Transaction, txid: string, vout: number): number => {
      for (let i = 0; i < tx.inputsLength; i++) {
        const inp = tx.getInput(i);
        if (inp.index === vout && inp.txid && Buffer.from(inp.txid).toString('hex') === txid) return i;
      }
      return -1;
    };
    expect(findIdx(ordTx, catTxid, 0)).toBeGreaterThanOrEqual(0);
    expect(findIdx(ordTx, cardinal.txid, cardinal.vout)).toBeGreaterThanOrEqual(0);
    // Our builder pins cat at input 0.
    expect(findIdx(sdkTx, catTxid, 0)).toBe(0);
    // Every input carries the RBF sequence in both.
    for (let i = 0; i < sdkTx.inputsLength; i++) {
      expect(sdkTx.getInput(i).sequence).toBe(CAT21_WALLET_INPUT_SEQUENCE);
    }
    for (let i = 0; i < ordTx.inputsLength; i++) {
      expect(ordTx.getInput(i).sequence).toBe(CAT21_WALLET_INPUT_SEQUENCE);
    }

    // output[0]: the cat, at the target, to the SAME recipient — value AND script match.
    expect(sdkTx.getOutput(0).amount).toBe(BigInt(TARGET_POSTAGE));
    expect(ordTx.getOutput(0).amount).toBe(BigInt(TARGET_POSTAGE));
    expect(bytesEqual(sdkTx.getOutput(0).script, ordTx.getOutput(0).script)).toBe(true);

    // output[1]: the change VALUE must match (proves fee parity); the script
    // legitimately differs (ord's change addr vs ours).
    expect(sdkTx.outputsLength).toBe(2);
    expect(ordTx.outputsLength).toBe(2);
    expect(sdkTx.getOutput(1).amount).toBe(ordTx.getOutput(1).amount);
    expect(bytesEqual(sdkTx.getOutput(1).script, ordTx.getOutput(1).script)).toBe(false); // the ONE expected value diff

    // the sole intentional structural diff: locktime.
    expect(ordTx.lockTime).toBe(0);
    expect(sdkTx.lockTime).toBe(21);
  }, 120_000);
});
