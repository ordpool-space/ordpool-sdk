import { describe, expect, it, beforeAll } from '@jest/globals';
import { secp256k1 } from '@noble/curves/secp256k1';
import { base58 } from '@scure/base';
import * as btc from '@scure/btc-signer';

// The HIGH-LEVEL orchestrated flow, on-chain, over REAL ports — the proof the
// pyramid was missing. The framework-agnostic core (no Angular, no JIT shim)
// runs its real content-checked selection + fee + build + sign + broadcast
// against the live regtest stack, and cat21-ord confirms the cat.
import { executeMint } from '../../src/cat21-core/mint.core';
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
});
