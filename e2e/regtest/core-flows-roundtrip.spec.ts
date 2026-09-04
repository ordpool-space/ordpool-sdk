import { describe, expect, it, beforeAll } from '@jest/globals';
import { secp256k1 } from '@noble/curves/secp256k1';
import { base58 } from '@scure/base';
import * as btc from '@scure/btc-signer';

// The HIGH-LEVEL orchestrated flow, on-chain, over REAL ports — the proof the
// pyramid was missing. The framework-agnostic core (no JIT shim)
// runs its real content-checked selection + fee + build + sign + broadcast
// against the live regtest stack, and cat21-ord confirms the cat.
import { executeMint, simulateMint } from '../../src/cat21-core/mint.core';
import { executeTransfer } from '../../src/cat21-core/transfer.core';
import {
  BroadcastPort,
  ContentScanPort,
  SignPort,
  UtxosPort,
} from '../../src/cat21-core/ports';
import { Network, toScureNetwork } from '../../src/network';
import { KnownOrdinalWalletType } from '../../src/wallet/wallet.service.types';
import { UtxoContentScanner } from '../../src/cat21-mint/utxo-content-scanner.service';
import {
  getFundedAccount,
  getTx,
  getUtxos,
  mineBlocks,
  postTx,
  rpc,
  waitForCatAtAddress,
  waitForElectrsSync,
  waitForOrdSync,
} from './regtest-helpers';

const ORD_URL = process.env.REGTEST_ORD_URL ?? 'http://localhost:8080';
const ORD_STOCK_URL = process.env.REGTEST_ORD_STOCK_URL ?? 'http://localhost:8081';
const ELECTRS_URL = process.env.REGTEST_ELECTRS_URL ?? 'http://localhost:3000';

/** Regtest WIF → raw 32-byte private key (version byte 0xef, compressed). */
function wifToPrivateKey(wif: string): Uint8Array {
  return base58.decode(wif).slice(1, 33);
}

describe('cat21-core flows over REAL ports (high-level orchestrated flow, on-chain)', () => {
  const net = Network.Regtest;
  const scure = toScureNetwork(net);

  let priv: Uint8Array;
  let pub: Uint8Array;
  let xonly: Uint8Array;
  let paymentAddress: string;
  let ordinalsAddress: string;
  let utxos: UtxosPort;
  let scan: ContentScanPort;
  let sign: SignPort;
  let broadcast: BroadcastPort;
  let scanned: string[];

  // The cat minted in test 1, moved in test 2.
  let mintTxid: string;

  beforeAll(async () => {
    const funded = getFundedAccount();
    priv = wifToPrivateKey(funded.wif);
    pub = secp256k1.getPublicKey(priv, true);
    xonly = pub.subarray(1, 33);
    paymentAddress = btc.p2wpkh(pub, scure).address!;
    ordinalsAddress = btc.p2tr(xonly, undefined, scure, true).address!;

    // Fund the payment address from the regtest node's wallet.
    rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', paymentAddress, '1');
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);

    // --- REAL ports (electrs / cat21-ord / local key / bitcoind) ---
    utxos = {
      spendableUtxos: async (addr) =>
        (await getUtxos(addr)).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value })),
    };
    scanned = [];
    // The SHIPPING funding-safety scanner against the LIVE indexes —
    // UtxoContentScanner + classifyUtxoContent parse real /output JSON
    // from stock ord (inscriptions/runes) and cat21-ord (cats). A field
    // rename in either server (precedent: the cat21-ord serde rename this
    // repo documents) breaks HERE instead of only in production. The thin
    // wrapper records which outpoints the selection actually scanned.
    const scanner = new UtxoContentScanner({
      mempoolApiUrl: ELECTRS_URL,
      cat21ApiUrl: '',
      ordApiUrl: ORD_STOCK_URL,
      cat21OrdApiUrl: ORD_URL,
    });
    scan = {
      classify: async (outpoint) => {
        scanned.push(outpoint);
        return scanner.classify(outpoint);
      },
    };
    sign = {
      sign: async (psbt, indexes) => {
        const tx = btc.Transaction.fromPSBT(psbt);
        const idxs = indexes === 'all' ? Array.from({ length: tx.inputsLength }, (_, i) => i) : indexes;
        for (const i of idxs) tx.signIdx(priv, i, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
        tx.finalize();
        return { hex: tx.hex, weight: tx.weight };
      },
    };
    broadcast = {
      broadcast: async (hex) => ({ txid: await postTx(hex), channel: 'mempool' }),
    };
  }, 60_000);

  it('executeMint: real select → fee → build → sign → broadcast → cat21-ord confirms the cat', async () => {
    const out = await executeMint(
      {
        walletType: KnownOrdinalWalletType.cat21wallet,
        network: net,
        paymentPublicKey: pub,
        paymentAddress,
        recipientAddress: ordinalsAddress,
        feeRatePerVbyte: 2,
      },
      { utxos, scan, sign, broadcast },
    );
    expect(out.txid).toMatch(/^[0-9a-f]{64}$/);
    // The safe-auto selection actually scanned the covering funding coin.
    expect(scanned.length).toBeGreaterThan(0);

    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);

    // cat21-ord indexes the mint tx as cat inscription <txid>i0 at the recipient.
    const insc = await waitForCatAtAddress(`${out.txid}i0`, ordinalsAddress);
    expect(insc.address).toBe(ordinalsAddress);
    mintTxid = out.txid;
  }, 90_000);

  it('executeTransfer: moves the minted cat; cat21-ord confirms it at the recipient', async () => {
    // Recipient = a distinct taproot address (not our own), so "moved" is real.
    const recipientXonly = secp256k1.getPublicKey(new Uint8Array(32).fill(7), true).subarray(1, 33);
    const recipientAddress = btc.p2tr(recipientXonly, undefined, scure, true).address!;

    const out = await executeTransfer(
      {
        walletType: KnownOrdinalWalletType.cat21wallet,
        network: net,
        ordinalsPublicKey: xonly,
        ordinalsAddress,
        paymentPublicKey: pub,
        paymentAddress,
        catUtxo: { txid: mintTxid, vout: 0, value: 546 },
        recipientAddress,
        feeRatePerVbyte: 2,
      },
      { utxos, scan, sign, broadcast },
    );
    expect(out.txid).toMatch(/^[0-9a-f]{64}$/);

    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);

    // The ORIGINAL cat (<mintTxid>i0) is now at the new recipient — it moved.
    const insc = await waitForCatAtAddress(`${mintTxid}i0`, recipientAddress);
    expect(insc.address).toBe(recipientAddress);
  }, 90_000);

  // The shared gate for the change-headroom fix (a9ffd7e): on a REAL chain, a
  // wallet holding a dust-cliff coin (covers the mint but is too tight to emit
  // an above-dust change) alongside headroom coins must auto-pick a headroom
  // coin, so the ON-CHAIN realised fee-rate lands on the typed rate instead of
  // the 7-13% over-pay (the leftover absorbed into the fee). Best-fit-by-value
  // alone would take the SMALLEST dust-cliff coin; the preferred-target bias
  // must skip it.
  //
  // ABSOLUTE sats (NOT self-calibrated): this replays cat21-indexer's real
  // regtest pool {13689, 99301, 100000} @ rate 100 as a genuine
  // true-positive-control. A self-calibrated variant (sizing the dust-cliff
  // coin off the internal fee F) is consistent-by-construction and would pass
  // even if `withChangeVsize` were mis-measured as the no-change size; fixed
  // sats + a fixed rate pin the real outcome: pre-fix best-fit picks 13689
  // (vsize 122, rate ~107.73); the fix picks a headroom coin (rate == 100).
  it('mixed pool {13689, 99301, 100000} @ rate 100: picks a headroom coin, on-chain realised rate == 100', async () => {
    const RATE = 100;
    // Fresh account so the 3-coin pool is fully controlled.
    const mpPriv = secp256k1.utils.randomPrivateKey();
    const mpPub = secp256k1.getPublicKey(mpPriv, true);
    const mpXonly = mpPub.subarray(1, 33);
    const mpPayment = btc.p2wpkh(mpPub, scure).address!;
    const mpOrdinals = btc.p2tr(mpXonly, undefined, scure, true).address!;
    const mpSign: SignPort = {
      sign: async (psbt, indexes) => {
        const tx = btc.Transaction.fromPSBT(psbt);
        const idxs = indexes === 'all' ? Array.from({ length: tx.inputsLength }, (_, i) => i) : indexes;
        for (const i of idxs) tx.signIdx(mpPriv, i, [btc.SigHash.DEFAULT, btc.SigHash.ALL]);
        tx.finalize();
        return { hex: tx.hex, weight: tx.weight };
      },
    };
    const params = {
      walletType: KnownOrdinalWalletType.cat21wallet,
      network: net,
      paymentPublicKey: mpPub,
      paymentAddress: mpPayment,
      recipientAddress: mpOrdinals,
      feeRatePerVbyte: RATE,
    };
    const simPorts = { utxos, scan };
    const execPorts = { utxos, scan, sign: mpSign, broadcast };

    // Fund the exact 3-coin pool: one dust-cliff coin + two headroom coins.
    for (const amt of ['0.00013689', '0.00099301', '0.00100000']) {
      rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', mpPayment, amt);
    }
    await waitForElectrsSync(mineBlocks(1));

    // The auto-pick MUST take a headroom coin (99301/100000), not the smaller
    // (best-fit-by-value) 13689 dust-cliff coin.
    const sim = await simulateMint(params, simPorts);
    expect(sim.status).toBe('ready');
    expect(sim.fundingUtxo?.value).not.toBe(13689);
    expect([99301, 100000]).toContain(sim.fundingUtxo?.value);
    expect(Math.abs(sim.feeSats! / sim.vsize! - RATE)).toBeLessThan(1);

    // Execute + broadcast + measure the ON-CHAIN realised rate.
    const out = await executeMint(params, execPorts);
    expect(out.txid).toMatch(/^[0-9a-f]{64}$/);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    const tx = await getTx(out.txid);
    const onchainVsize = Math.ceil(tx.weight / 4);
    expect(Math.abs(tx.fee / onchainVsize - RATE)).toBeLessThan(1);

    // The dust-cliff coin was NOT spent — a headroom coin was preferred.
    const remaining = await getUtxos(mpPayment);
    expect(remaining.some((u) => u.value === 13689)).toBe(true);
  }, 120_000);
  it('funding safety vs the LIVE index: a cat-bearing coin is scanned, classified by the SHIPPING scanner, and NEVER auto-spent', async () => {
    // Seed a 5 000-sat nLockTime=21 cat directly onto the PAYMENT
    // address: small enough to be the best-fit (smallest covering)
    // candidate for the next mint, so the safe-auto selection would
    // spend it if the content scan lied. This is the first e2e that
    // proves the EXCLUSION side of the funding-safety layer against a
    // real cat21-ord index through the shipping classify path (the
    // mocked unit specs and the previous inline scan port could not
    // catch an ord-server field rename).
    const funding = (await getUtxos(paymentAddress)).sort((a, b) => b.value - a.value)[0];
    const seedTx = new btc.Transaction({ lockTime: 21 });
    seedTx.addInput({
      txid: funding.txid,
      index: funding.vout,
      witnessUtxo: { script: btc.p2wpkh(pub, scure).script, amount: BigInt(funding.value) },
      sequence: 0xfffffffe,
    });
    seedTx.addOutputAddress(paymentAddress, 5_000n, scure);
    seedTx.addOutputAddress(paymentAddress, BigInt(funding.value - 5_000 - 400), scure);
    seedTx.sign(priv);
    seedTx.finalize();
    const seedTxid = await postTx(seedTx.hex);
    const catOutpoint = `${seedTxid}:0`;
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    await waitForOrdSync(tip);

    scanned.length = 0;
    const out = await executeMint(
      {
        walletType: KnownOrdinalWalletType.cat21wallet,
        network: net,
        paymentPublicKey: pub,
        paymentAddress,
        recipientAddress: ordinalsAddress,
        feeRatePerVbyte: 2,
      },
      { utxos, scan, sign, broadcast },
    );
    expect(out.txid).toMatch(/^[0-9a-f]{64}$/);

    // The selection CONSIDERED the cat coin (it was the smallest covering
    // candidate, so the scan ran against the live index)...
    expect(scanned).toContain(catOutpoint);

    // ...and the broadcast mint did NOT spend it: chain-truth from
    // electrs, not from selection-internal state.
    const mintTx = await getTx(out.txid);
    const spentOutpoints = (mintTx.vin as { txid: string; vout: number }[]).map(v => `${v.txid}:${v.vout}`);
    expect(spentOutpoints).not.toContain(catOutpoint);
    // Exactly one funding input: the mint spends the single clean pick.
    expect(spentOutpoints.length).toBe(1);
  });

});
