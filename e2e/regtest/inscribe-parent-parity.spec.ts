/**
 * Parent/child parity with `ord wallet inscribe --parent <ID>`.
 *
 * The child flow was already proven to be INDEXED as a child by ord
 * (inscribe-child-roundtrip). That is a weaker claim than byte-parity, and
 * the comments there said "exactly like ord's own `wallet inscribe --parent`"
 * without any test driving ord with `--parent`. This one does.
 *
 * Read from both sources, and pinned here: ord's child reveal spends the
 * PARENT at input 0 (key path, one witness item) and the envelope commit at
 * input 1 (script path, three witness items), and pays the parent back at
 * output 0 and the child at output 1. Input order decides FIFO, so it decides
 * which output the child lands on; getting it backwards would put the child
 * on the parent's return output.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { ORD_TAGS, buildInscriptionEnvelope } from '../../src/inscribe/inscription-envelope';
import { synthesizeEnvelopeFields } from '../../src/inscribe/inscription.service.helper';
import type { CreateInscribeTransactionsArgs } from '../../src/inscribe/inscription.service.helper';
import {
  mineBlocks,
  ordStockCreateWallet,
  ordStockWalletInscribe,
  rpc,
  waitForElectrsSync,
  waitForOrdStockReady,
  waitForOrdStockSync,
  writeOrdStockFile,
} from './regtest-helpers';

const ORD_WALLET = 'parity-parent-stock';
const TXT = 'text/plain;charset=utf-8';

interface DecodedTx {
  vin: { txinwitness?: string[] }[];
  vout: { value: number }[];
}

describe('inscribe with a parent → parity with `ord wallet inscribe --parent`', () => {
  let parentId: string;

  beforeAll(async () => {
    await waitForOrdStockReady(60_000);
    const ordAddr = ordStockCreateWallet(ORD_WALLET);
    rpc('generatetoaddress', '110', ordAddr);
    const tip = Number(rpc('getblockcount'));
    await waitForElectrsSync(tip);
    await waitForOrdStockSync(tip);

    writeOrdStockFile('/tmp/parity-parent.txt', new TextEncoder().encode('the parent'));
    const { reveal } = ordStockWalletInscribe(ORD_WALLET, '/tmp/parity-parent.txt', 5);
    parentId = `${reveal}i0`;
    await waitForOrdStockSync(mineBlocks(1));
  }, 240_000);

  it('the child envelope, parent tag included, is byte-identical to ord', async () => {
    const body = new TextEncoder().encode('parity: a child');
    writeOrdStockFile('/tmp/parity-child.txt', body);
    const { reveal } = ordStockWalletInscribe(ORD_WALLET, '/tmp/parity-child.txt', 5, [
      '--parent', parentId,
    ]);
    await waitForOrdStockSync(mineBlocks(1));

    const tx = btc.Transaction.fromRaw(hex.decode(rpc('getrawtransaction', reveal)));
    // The envelope is on INPUT 1 for a child, not input 0.
    const ordEnvelope = hex.encode(tx.getInput(1).finalScriptWitness![1]).slice(68);

    const fields = synthesizeEnvelopeFields({ parent: parentId } as unknown as CreateInscribeTransactionsArgs);
    expect(fields.map(f => f.tag)).toContain(ORD_TAGS.parent);
    const sdkEnvelope = hex.encode(buildInscriptionEnvelope({
      revealPubkeyXonly: new Uint8Array(32).fill(7),
      contentType: TXT,
      body,
      fields,
    })).slice(68);

    expect(sdkEnvelope).toBe(ordEnvelope);
  }, 120_000);

  it('ord spends the parent at input 0 and the envelope at input 1, parent back at output 0', async () => {
    // Pins the topology the SDK's child reveal must match. If ord ever
    // changed it, this fails first and points at the reason.
    const body = new TextEncoder().encode('parity: child topology');
    writeOrdStockFile('/tmp/parity-child-topo.txt', body);
    const { reveal } = ordStockWalletInscribe(ORD_WALLET, '/tmp/parity-child-topo.txt', 5, [
      '--parent', parentId,
    ]);
    await waitForOrdStockSync(mineBlocks(1));

    const t = JSON.parse(rpc('getrawtransaction', reveal, 'true')) as DecodedTx;
    expect(t.vin).toHaveLength(2);
    expect(t.vin[0].txinwitness).toHaveLength(1); // parent: key path
    expect(t.vin[1].txinwitness).toHaveLength(3); // envelope: sig, script, control block
    expect(t.vout).toHaveLength(2);
  }, 120_000);
});
