/**
 * Transfer byte-parity vs LIVE `ord wallet send`.
 *
 * The SDK transfer, built with ord-parity coin selection + fee
 * (`selectOrdParityFunding`), must be byte-identical to what stock ord's
 * `wallet send` produces for the same cat + the same available UTXOs, except
 * the two things that MUST differ: `nLockTime` (ord 0, us 21 for the bonus cat)
 * and the change output's address (ord derives its own; ours is the sender's).
 *
 * Setup: a fresh ord wallet owns cats at 546, 3000 and 9000 sats plus ONE
 * cardinal UTXO, so coin selection is forced (with one candidate, our pick ==
 * ord's pick by definition). Each case runs `ord wallet send --dry-run
 * --postage <target>` for ord's reference tx, builds ours for the same inputs,
 * and asserts equality on every field but locktime + change script:
 *
 * - GROW: the 546 cat to an exact 10,000 (`targetPostageSats: 10000`).
 * - PRESERVE: the 3000 and 9000 cats with `targetPostageSats` omitted, against
 *   `--postage <the cat's own value>`, which is how ord keeps a cat's size: its
 *   default send (no `--postage`) pays the fee out of the cat's postage instead,
 *   pinned by the last case.
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
  fundWithFreshCoinbase,
  waitForOrdReady,
  waitForOrdWalletCardinal,
  waitForOrdSync,
  waitForTxConfirmed,
  waitForUtxoAt,
} from './regtest-helpers';

const FEE_RATE = 2; // integer sat/vB, removes rounding as a variable
const TARGET_POSTAGE = 10_000; // grow the 546 cat to an exact 10k postage
/** The cats the ord wallet holds: one to grow, two to preserve at non-546 sizes. */
const CAT_SIZES = [546, 3_000, 9_000] as const;

/** P2TR scriptPubKey length in bytes. */
const P2TR_SCRIPT_LEN = 34;

const bytesEqual = (a?: Uint8Array, b?: Uint8Array): boolean =>
  !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

describe('transfer byte-parity vs live `ord wallet send`', () => {
  const regtestNetwork = toScureNetwork(Network.Regtest);

  let ordWalletAddress: string;
  let walletScript: Uint8Array;
  const cats = new Map<number, { txid: string; inscriptionId: string }>();
  let cardinal: { txid: string; vout: number; value: number; script: Uint8Array };

  beforeAll(async () => {
    let tip = mineBlocks(3);
    await waitForElectrsSync(tip);
    await waitForOrdReady();
    await waitForOrdSync(tip);

    // A fresh, cat-aware ord wallet whose UTXO set we fully control.
    ordWalletAddress = ordCreateWallet('ordsend');
    expect(ordWalletAddress).toMatch(/^bcrt1p/); // ord wallets are taproot

    // Give it exactly ONE cardinal UTXO, from a freshly mined COINBASE rather
    // than a sendtoaddress. The shared wallet's coins may carry sats that
    // passed through an nLockTime=21 transaction, which ord (running
    // --index-cat21) reports as inscribed; the wallet then has no cardinal and
    // `ord wallet send` refuses, intermittently, depending on which UTXO the
    // shared wallet happened to pick. Coinbase sats have passed through no
    // transaction at all.
    fundWithFreshCoinbase(ordWalletAddress);
    // Fund a mint source for each cat.
    const minterPriv = secp256k1.utils.randomPrivateKey();
    const minterAddr = btc.p2wpkh(secp256k1.getPublicKey(minterPriv, true), regtestNetwork).address!;
    const minterScript = btc.p2wpkh(secp256k1.getPublicKey(minterPriv, true), regtestNetwork).script;
    for (let i = 0; i < CAT_SIZES.length; i++) rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', minterAddr, '0.2');
    tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdSync(tip);

    // Mint each cat (nLockTime=21) TO the ord wallet's address so the ord
    // wallet owns it and `wallet send` can move it.
    for (const sats of CAT_SIZES) {
      const minterUtxo = await waitForUtxoAt(minterAddr, 20_000_000);
      const mint = new btc.Transaction({ lockTime: 21 });
      mint.addInput({
        txid: minterUtxo.txid,
        index: minterUtxo.vout,
        sequence: 0xfffffffe,
        witnessUtxo: { script: minterScript, amount: BigInt(minterUtxo.value) },
      });
      mint.addOutputAddress(ordWalletAddress, BigInt(sats), regtestNetwork); // the cat, to the ord wallet
      mint.addOutputAddress(minterAddr, BigInt(minterUtxo.value - sats - 1_000), regtestNetwork);
      mint.signIdx(minterPriv, 0, [btc.SigHash.ALL]);
      mint.finalize();
      await postTx(mint.hex);
      tip = mineBlocks(1);
      await waitForElectrsSync(tip);
      await waitForTxConfirmed(mint.id);
      await waitForOrdSync(tip);
      cats.set(sats, { txid: mint.id, inscriptionId: catInscriptionId(mint.id) });
    }

    // `ord wallet send` runs with --no-sync, so it reads ord's own wallet view
    // rather than the node's. electrs and the ord index being caught up says
    // nothing about that third view, and depending on it without waiting for it
    // leaves the send to discover the problem instead of the setup.
    //
    // The floor is deliberately loose: a regtest coinbase subsidy halves every
    // 150 blocks, so the amount depends on how far the shared chain has run and
    // pinning it would make this spec fail on chain age rather than on
    // behaviour. Anything comfortably above the cats plus a fee proves the point.
    await waitForOrdWalletCardinal('ordsend', 1_000_000);

    // Resolve the ord wallet's UTXOs: the cats and the coinbase cardinal.
    const utxos = await getUtxos(ordWalletAddress);
    const catTxids = new Set([...cats.values()].map((c) => c.txid));
    for (const sats of CAT_SIZES) {
      expect(utxos.find((u) => u.txid === cats.get(sats)!.txid && u.vout === 0)?.value).toBe(sats);
    }
    // Identified as "the one that is not a cat" rather than by amount, for
    // the same subsidy-halving reason.
    const cardinals = utxos.filter((u) => !catTxids.has(u.txid));
    expect(cardinals).toHaveLength(1);

    // The ord wallet's taproot scriptPubKey, taken authoritatively from the
    // on-chain output (same address for all its UTXOs).
    const catOut = JSON.parse(rpc('gettxout', cats.get(546)!.txid, '0')) as {
      scriptPubKey: { hex: string };
    };
    walletScript = hex.decode(catOut.scriptPubKey.hex);
    cardinal = { txid: cardinals[0].txid, vout: cardinals[0].vout, value: cardinals[0].value, script: walletScript };
  });

  const freshTaprootAddress = (): string => btc.p2tr(
    secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true).slice(1),
    undefined,
    regtestNetwork,
  ).address!;

  const findIdx = (tx: btc.Transaction, txid: string, vout: number): number => {
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i);
      if (inp.index === vout && inp.txid && Buffer.from(inp.txid).toString('hex') === txid) return i;
    }
    return -1;
  };

  /**
   * Build ord's reference send and ours for the cat of `catSats`, moved to
   * `postageSats`, and assert parity on every field but locktime + change
   * script. `targetPostageSats` is what our builder is told: the target for a
   * resize, omitted for a preserve.
   */
  function expectParity(catSats: number, postageSats: number, targetPostageSats: number | undefined): void {
    const cat = cats.get(catSats)!;
    // Recipient and our change: taproot, to match ord's all-taproot fee model.
    const recipientAddr = freshTaprootAddress();
    const ourChangeAddr = freshTaprootAddress();

    const ordSend = ordWalletSend(recipientAddr, cat.inscriptionId, FEE_RATE, postageSats, 'ordsend');
    const ordTx = btc.Transaction.fromPSBT(base64.decode(ordSend.psbt));

    const funding = selectOrdParityFunding({
      outgoingValueSats: catSats,
      targetPostageSats: postageSats,
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
      catUtxo: { txid: cat.txid, vout: 0, value: catSats, scriptPubKey: walletScript },
      fundingInputs: funding.fundingInputs.map((u) => ({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        scriptPubKey: cardinal.script,
      })),
      destinations: { recipientAddress: recipientAddr, senderChangeAddress: ourChangeAddr },
      feeSats: funding.feeSats,
      ...(targetPostageSats === undefined ? {} : { targetPostageSats }),
    });
    const sdkTx = btc.Transaction.fromPSBT(sdk.psbt);

    expect(sdkTx.version).toBe(ordTx.version); // both 2

    // Inputs: same count, same outpoints (cat then cardinal), same sequences.
    expect(sdkTx.inputsLength).toBe(ordTx.inputsLength);
    expect(findIdx(ordTx, cat.txid, 0)).toBeGreaterThanOrEqual(0);
    expect(findIdx(ordTx, cardinal.txid, cardinal.vout)).toBeGreaterThanOrEqual(0);
    // Our builder pins cat at input 0.
    expect(findIdx(sdkTx, cat.txid, 0)).toBe(0);
    // Every input carries the RBF sequence in both.
    for (let i = 0; i < sdkTx.inputsLength; i++) {
      expect(sdkTx.getInput(i).sequence).toBe(CAT21_WALLET_INPUT_SEQUENCE);
    }
    for (let i = 0; i < ordTx.inputsLength; i++) {
      expect(ordTx.getInput(i).sequence).toBe(CAT21_WALLET_INPUT_SEQUENCE);
    }

    // output[0]: the cat, at the postage, to the SAME recipient: value AND script match.
    expect(sdkTx.getOutput(0).amount).toBe(BigInt(postageSats));
    expect(ordTx.getOutput(0).amount).toBe(BigInt(postageSats));
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
  }

  it('GROW: SDK transfer of the 546 cat == `ord wallet send --postage 10000` on every field but locktime + change addr', () => {
    expectParity(546, TARGET_POSTAGE, TARGET_POSTAGE);
  });

  it.each([3_000, 9_000])('PRESERVE: SDK transfer of the %i cat (no target) == `ord wallet send --postage <its value>`', (sats) => {
    expectParity(sats, sats, undefined);
  });

  it('ord\'s default send (no --postage) pays the fee out of a 3000 cat\'s postage, so it does not preserve the size', () => {
    const cat = cats.get(3_000)!;
    const ordSend = ordWalletSend(freshTaprootAddress(), cat.inscriptionId, FEE_RATE, undefined, 'ordsend');
    const ordTx = btc.Transaction.fromPSBT(base64.decode(ordSend.psbt));
    const feeSats = ordSend.fee;

    expect({ inputs: ordTx.inputsLength, outputs: ordTx.outputsLength, cat: ordTx.getOutput(0).amount }).toEqual({
      inputs: 1,
      outputs: 1,
      cat: BigInt(3_000 - feeSats),
    });
    expect(feeSats).toBeGreaterThan(0);
  });
});
