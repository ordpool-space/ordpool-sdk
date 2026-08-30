import { describe, expect, it, beforeAll } from '@jest/globals';
import { secp256k1 } from '@noble/curves/secp256k1';
import { base58 } from '@scure/base';
import * as btc from '@scure/btc-signer';

// The HIGH-LEVEL orchestrated flow, on-chain, over REAL ports — the proof the
// pyramid was missing. The framework-agnostic core (no Angular, no JIT shim)
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
import {
  getFundedAccount,
  getTx,
  getUtxos,
  mineBlocks,
  postTx,
  rpc,
  waitForCatAtAddress,
  waitForElectrsSync,
} from './regtest-helpers';

const ORD_URL = process.env.REGTEST_ORD_URL ?? 'http://localhost:8080';

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
    scan = {
      classify: async (outpoint) => {
        scanned.push(outpoint);
        const res = await fetch(`${ORD_URL}/output/${outpoint}`, { headers: { Accept: 'application/json' } });
        if (!res.ok) return 'clean';
        const body = (await res.json()) as { cats?: unknown[]; inscriptions?: unknown[] };
        const hasAssets =
          (Array.isArray(body.cats) && body.cats.length > 0) ||
          (Array.isArray(body.inscriptions) && body.inscriptions.length > 0);
        return hasAssets ? 'has-assets' : 'clean';
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
  // wallet holding BOTH a dust-cliff coin (covers the mint but is too tight to
  // emit an above-dust change) AND a headroom coin must auto-pick the headroom
  // coin, so the ON-CHAIN realised fee-rate lands on the typed rate instead of
  // the 7-13% over-pay (the leftover absorbed into the fee). Best-fit-by-value
  // alone would take the SMALLER dust-cliff coin; the preferred-target bias
  // must skip it. Self-calibrated: the with-change fee F is learned from a real
  // simulate against the headroom coin, then the dust-cliff coin is sized into
  // the band [F, F + 546) so its change is provably sub-dust.
  it('mixed pool: dust-cliff coin + headroom coin => auto-picks headroom, on-chain realised rate == typed', async () => {
    const RATE = 100;
    // Fresh account so the 2-coin pool is fully controlled.
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

    const HEADROOM_SATS = 100_000;

    // 1) Fund the headroom coin; learn the with-change fee F from a real simulate.
    rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', mpPayment, '0.001');
    await waitForElectrsSync(mineBlocks(1));
    const F = (await simulateMint(params, simPorts)).feeSats;
    if (F === null) throw new Error('calibration simulate returned no fee');
    expect(F).toBeGreaterThan(0);

    // 2) Fund a dust-cliff coin: budget in [F, F + 546) => its would-be change
    //    is sub-dust => absorbed into the fee (over-pay) IF it were picked.
    //    546 = CAT21_POSTAGE_SATS (the mint's fixed output).
    const dustCliffSats = 546 + F + 200;
    rpc('-rpcwallet=ordpool-e2e', 'sendtoaddress', mpPayment, (dustCliffSats / 1e8).toFixed(8));
    await waitForElectrsSync(mineBlocks(1));

    // 3) Simulate the mixed pool: the auto-pick MUST take the headroom coin, not
    //    the smaller (best-fit-by-value) dust-cliff coin.
    const sim = await simulateMint(params, simPorts);
    expect(sim.status).toBe('ready');
    expect(sim.fundingUtxo?.value).toBe(HEADROOM_SATS);
    expect(Math.abs(sim.feeSats! / sim.vsize! - RATE)).toBeLessThan(1);

    // 4) Execute + broadcast + measure the ON-CHAIN realised rate.
    const out = await executeMint(params, execPorts);
    expect(out.txid).toMatch(/^[0-9a-f]{64}$/);
    const tip = mineBlocks(1);
    await waitForElectrsSync(tip);
    const tx = await getTx(out.txid);
    const onchainVsize = Math.ceil(tx.weight / 4);
    expect(Math.abs(tx.fee / onchainVsize - RATE)).toBeLessThan(1);

    // 5) The dust-cliff coin was NOT spent — the headroom coin was preferred.
    const remaining = await getUtxos(mpPayment);
    expect(remaining.some((u) => u.value === dustCliffSats)).toBe(true);
  }, 120_000);
});
