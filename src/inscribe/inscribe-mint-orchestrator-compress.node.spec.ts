/**
 * @jest-environment node
 *
 * `compressBody`: the orchestrator compresses the file exactly as
 * `ord wallet inscribe --compress` does, prices the compressed body in the
 * preview, tags `content_encoding`, and reports the saving on the snapshot.
 * Node-only because it reads the shipped wasm off disk.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { of } from 'rxjs';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network } from '../network';
import { KnownOrdinalWalletType } from '../wallet/wallet.service.types';
import { TxnOutput } from '../cat21-mint/cat21.service.types';
import { compressLikeOrd } from './inscribe-compression.helper';
import { createInscribeTransactions } from './inscription.service.helper';
import {
  InscribeContent,
  InscribeMintOrchestrator,
  InscribeOrchestratorDeps,
  InscribeSnapshot,
  InscribeWalletContext,
} from './inscribe-mint-orchestrator';

// The SUT is the orchestrator; `inscribe-orchestrator` is the build/sign/
// broadcast boundary it delegates to. Mocking it makes the arguments mint()
// hands down observable without a browser wallet provider.
jest.mock('./inscribe-orchestrator', () => ({
  inscribeAndBroadcast: jest.fn(),
  inscribeBatchAndBroadcast: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const orchestratorBoundary = require('./inscribe-orchestrator') as {
  inscribeAndBroadcast: jest.Mock;
  inscribeBatchAndBroadcast: jest.Mock;
};

const WASM = new Uint8Array(readFileSync(join(__dirname, '../../wasm/brotli_wasm_bg.wasm')));

const PAYMENT_PUB = '0278875d226dd610b06c41d698c9fe0ea4915c797ddc31a3310299d9acd07ff37b';
const ORDINALS_XONLY = '5df12ac222a1cd78dd4681c7c7a56f3e273884a086b2b6100957d20c73be3c37';
const PAYMENT_ADDR = btc.p2wpkh(hex.decode(PAYMENT_PUB), btc.NETWORK).address!;
const ORDINALS_ADDR = btc.p2tr(hex.decode(ORDINALS_XONLY), undefined, btc.NETWORK).address!;

const wallet: InscribeWalletContext = {
  type: KnownOrdinalWalletType.cat21wallet,
  ordinalsAddress: ORDINALS_ADDR,
  paymentAddress: PAYMENT_ADDR,
  paymentPublicKey: PAYMENT_PUB,
};

/** Highly compressible: 2 000 bytes of repeated markup. */
const HTML = new TextEncoder().encode('<p class="cat">meow</p>\n'.repeat(100));
/** Incompressible: a fixed pseudo-random byte run, so brotli cannot win. */
const NOISE = (() => {
  const out = new Uint8Array(2_000);
  let x = 0x2b21;
  for (let i = 0; i < out.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
})();

const utxo: TxnOutput = { txid: 'c'.repeat(64), vout: 0, value: 200_000, status: { confirmed: true } };

const deps = (over: Partial<InscribeOrchestratorDeps> = {}): InscribeOrchestratorDeps => ({
  getUtxos: async () => [utxo],
  scan: { classify: async () => 'clean' },
  broadcast: async () => 'broadcast-txid',
  network: Network.Mainnet,
  brotliWasm: WASM,
  ...over,
});

function waitFor(o: InscribeMintOrchestrator, pred: (s: InscribeSnapshot) => boolean): Promise<InscribeSnapshot> {
  return new Promise((resolve) => {
    let unsub: () => void = () => {};
    unsub = o.subscribe((s) => {
      if (pred(s)) {
        unsub();
        resolve(s);
      }
    });
  });
}

/** Run the orchestrator to a settled simulation row for `content`. */
async function settle(content: InscribeContent, d = deps()): Promise<InscribeSnapshot> {
  const o = new InscribeMintOrchestrator(d);
  await o.setWallet(wallet);
  o.setContent(content);
  o.setFeeRate(7);
  return waitFor(o, (x) => x.errorMessage !== null || (x.simulations.length > 0 && x.simulations[0].simulation !== null));
}

/** What the builder produces for an explicit body + encoding. */
function build(body: Uint8Array, contentEncoding?: 'br') {
  return createInscribeTransactions({
    body,
    contentType: 'text/html',
    contentEncoding,
    paymentOutput: utxo,
    paymentPublicKey: hex.decode(PAYMENT_PUB),
    paymentAddress: PAYMENT_ADDR,
    recipientAddress: ORDINALS_ADDR,
    feeRatePerVbyte: 7,
    walletType: wallet.type,
    network: Network.Mainnet,
  });
}

describe('InscribeMintOrchestrator: compressBody', () => {
  const file: InscribeContent = { source: { kind: 'file', body: HTML, contentType: 'text/html' } };

  it('reports the saving and prices the compressed body, matching ord\'s own encoder', async () => {
    const ord = await compressLikeOrd(HTML, 'text/html', WASM);
    expect(ord.contentEncoding).toBe('br');

    const s = await settle({ ...file, compressBody: true });
    expect(s.compression).toEqual({
      originalSize: HTML.length,
      compressedSize: ord.body.length,
      savedBytes: HTML.length - ord.body.length,
      contentEncoding: 'br',
    });

    // The row prices the compressed body with its content_encoding tag, byte
    // for byte what the builder writes for those exact bytes.
    const built = build(ord.body, 'br');
    expect(s.simulations[0].simulation!.revealVsize).toBe(built.fees.revealVsize);
    expect(s.simulations[0].simulation!.revealFeeSats).toBe(built.fees.revealFeeSats);
  });

  it('the compressed row is cheaper than the same file uncompressed', async () => {
    const plain = await settle(file);
    const compressed = await settle({ ...file, compressBody: true });
    expect(compressed.simulations[0].simulation!.revealVsize)
      .toBeLessThan(plain.simulations[0].simulation!.revealVsize);
  });

  it('when compressing does not help, the original is inscribed and the snapshot says so', async () => {
    const ord = await compressLikeOrd(NOISE, 'text/html', WASM);
    expect(ord.contentEncoding).toBeUndefined();

    const s = await settle({ source: { kind: 'file', body: NOISE, contentType: 'text/html' }, compressBody: true });
    expect(s.compression).toEqual({
      originalSize: NOISE.length,
      compressedSize: NOISE.length,
      savedBytes: 0,
      contentEncoding: null,
    });
    // No content_encoding tag: the row equals the plain build of the original.
    const built = build(NOISE);
    expect(s.simulations[0].simulation!.revealVsize).toBe(built.fees.revealVsize);
  });

  it('without the toggle nothing is compressed and the snapshot carries no saving', async () => {
    const s = await settle(file);
    expect(s.compression).toBeNull();
    expect(s.simulations[0].simulation!.revealVsize).toBe(build(HTML).fees.revealVsize);
  });

  it('turning the toggle back off clears the saving and restores the uncompressed price', async () => {
    const o = new InscribeMintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setFeeRate(7);
    o.setContent({ ...file, compressBody: true });
    const on = await waitFor(o, (x) => x.compression !== null);
    expect(on.compression!.savedBytes).toBeGreaterThan(0);

    o.setContent(file);
    const off = await waitFor(o, (x) => x.compression === null && x.simulations.length > 0 && x.simulations[0].simulation !== null);
    expect(off.simulations[0].simulation!.revealVsize).toBe(build(HTML).fees.revealVsize);
  });

  it('a delegate has no body to compress', async () => {
    const s = await settle({ source: { kind: 'delegate', delegate: `${'ab'.repeat(32)}i0` }, compressBody: true });
    expect(s.compression).toBeNull();
    expect(s.errorMessage).toBeNull();
  });

  it('without the wasm it says what is missing instead of inscribing uncompressed', async () => {
    const s = await settle({ ...file, compressBody: true }, deps({ brotliWasm: undefined }));
    expect(s.errorMessage).toBe('compressBody needs the brotli wasm: pass brotliWasm in the orchestrator deps');
    expect(s.simulations).toEqual([]);
  });

  it('mint inscribes the compressed bytes with the content_encoding tag', async () => {
    const ord = await compressLikeOrd(HTML, 'text/html', WASM);
    orchestratorBoundary.inscribeAndBroadcast.mockReturnValue(of({ commitTxId: 'a', revealTxId: 'b' }));

    const o = new InscribeMintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setFeeRate(7);
    o.setContent({ ...file, compressBody: true });
    await waitFor(o, (x) => x.fundingRecommendation.status === 'auto');
    await o.mint();

    const args = orchestratorBoundary.inscribeAndBroadcast.mock.calls.at(-1)![0];
    expect(Array.from(args.body as Uint8Array)).toEqual(Array.from(ord.body));
    expect(args.contentEncoding).toBe('br');
  });

  it('a batch reports the total saved over the entries that compress', async () => {
    const ord = await compressLikeOrd(HTML, 'text/html', WASM);
    const o = new InscribeMintOrchestrator(deps());
    await o.setWallet(wallet);
    o.setFeeRate(7);
    o.setBatch({
      mode: 'separate-outputs',
      inscriptions: [
        { source: { kind: 'file', body: HTML, contentType: 'text/html' }, compressBody: true },
        { source: { kind: 'file', body: HTML, contentType: 'text/html' }, compressBody: true },
        { source: { kind: 'file', body: NOISE, contentType: 'text/html' } },
      ],
    });
    const s = await waitFor(o, (x) => x.compression !== null);
    expect(s.compression).toEqual({
      originalSize: HTML.length * 2,
      compressedSize: ord.body.length * 2,
      savedBytes: (HTML.length - ord.body.length) * 2,
      contentEncoding: 'br',
    });
  });
});
