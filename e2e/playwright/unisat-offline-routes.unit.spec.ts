import { decodeUnisatPsbt, installUnisatOfflineRoutes, UNISAT_WALLET_API, unisatOfflineAnswer } from './unisat-offline-routes';

// Two `POST /v5/tx/decode2` exchanges captured from wallet-api.unisat.space on
// 2026-10-10, UniSat v1.7.15 signing for the unisat-* specs on regtest: the
// PSBT the wallet sent and the server's `data`.
//   MINT_CAPTURE  one taproot funding input, two outputs, no RBF (mint)
//   OFFER_CAPTURE seller cat input plus a pre-signed buyer input carrying
//                 SIGHASH_ALL, sequence 0xfffffffd (create-offer)
const MINT_CAPTURE = {
  psbtHex: '70736274ff010089020000000140e229cdd110887d99a2503fa5d25e1cabc921f9e31f0fa27fdaabb35b5882be0100000000feffffff022202000000000000225120a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684ca27e010000000000225120a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c150000000001012ba086010000000000225120a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c011720cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115000000',
  data: {"inputInfos":[{"txid":"be82585bb3abda7fa20f1fe3f921c9ab1c5ed2a53f50a2997d8810d1cd29e240","vout":1,"address":"bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr","value":100000,"inscriptions":[],"atomicals":[],"alkanes":[],"runes":[],"onchain":false,"utxoStatus":{"utxoFound":false,"atomicalsChecked":false,"isConfirmed":false,"inscriptionDoubleChecked":false,"runesChecked":false,"indexerChecked":false,"unlocked":false},"brc20Count":0}],"outputInfos":[{"address":"bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr","value":546,"inscriptions":[],"atomicals":[],"runes":[],"alkanes":[],"isOpReturn":false},{"address":"bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr","value":97954,"inscriptions":[],"atomicals":[],"runes":[],"alkanes":[],"isOpReturn":false}],"feeRate":"≈9.8","fee":1500,"isCompleted":true,"risks":[],"features":{"rbf":false},"inscriptions":{},"recommendedFeeRate":1,"shouldWarnFeeRate":true},
};
const OFFER_CAPTURE = {
  psbtHex: '70736274ff0100c502000000023a20f32809a07e8fda624aebb725b2951854c40a7efee2d5a2734854d5f3a6df0000000000fdfffffff056ec65e0083805e4fb262444e71caf8240d800b60a1daa4be7e1711c45d8620100000000fdffffff032202000000000000160014fa0810a824d13cb2731d2d2b40eb6d867e0e78b572c5000000000000225120a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c52bb000000000000160014fa0810a824d13cb2731d2d2b40eb6d867e0e78b5150000000001012b2202000000000000225120a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c011720cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc1150001011fa086010000000000160014fa0810a824d13cb2731d2d2b40eb6d867e0e78b52202039f0adc57caa2ff66d7c10ce9817e345b66fb80f385ee1c63a59c589ca15d92a9483045022100d78a37fb4281e1adf7e20e01d5defe9c4a78ca85eb45e5a42bb82cb4b14b4d7e022018e7deb5f570ca90592264989b3d77db29fffdde9213c6d15595e9d50a920ead010103040100000000000000',
  data: {"inputInfos":[{"txid":"dfa6f3d5544873a2d5e2fe7e0ac4541895b225b7eb4a62da8f7ea00928f3203a","vout":0,"address":"bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr","value":546,"inscriptions":[],"atomicals":[],"alkanes":[],"runes":[],"onchain":false,"utxoStatus":{"utxoFound":false,"atomicalsChecked":false,"isConfirmed":false,"inscriptionDoubleChecked":false,"runesChecked":false,"indexerChecked":false,"unlocked":false},"brc20Count":0},{"txid":"62d8451c71e1e74baa1d0ab600d84082af1ce7442426fbe4053808e065ec56f0","vout":1,"address":"bc1qlgypp2py6y7tyuca9545p6mdselqu794qvex48","value":100000,"inscriptions":[],"atomicals":[],"alkanes":[],"runes":[],"sighashType":1,"onchain":false,"utxoStatus":{"utxoFound":false,"atomicalsChecked":false,"isConfirmed":false,"inscriptionDoubleChecked":false,"runesChecked":false,"indexerChecked":false,"unlocked":false},"brc20Count":0}],"outputInfos":[{"address":"bc1qlgypp2py6y7tyuca9545p6mdselqu794qvex48","value":546,"inscriptions":[],"atomicals":[],"runes":[],"alkanes":[],"isOpReturn":false},{"address":"bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr","value":50546,"inscriptions":[],"atomicals":[],"runes":[],"alkanes":[],"isOpReturn":false},{"address":"bc1qlgypp2py6y7tyuca9545p6mdselqu794qvex48","value":47954,"inscriptions":[],"atomicals":[],"runes":[],"alkanes":[],"isOpReturn":false}],"feeRate":"≈6.3","fee":1500,"isCompleted":true,"risks":[],"features":{"rbf":true},"inscriptions":{},"recommendedFeeRate":1,"shouldWarnFeeRate":false},
};

/** The server's fee-rate fields depend on its own size estimate and mempool. */
function withoutFeeRateDisplay(data: Record<string, unknown>): Record<string, unknown> {
  const { feeRate: _feeRate, shouldWarnFeeRate: _warn, ...rest } = data;
  return rest;
}

describe('decodeUnisatPsbt', () => {
  it.each([
    ['mint', MINT_CAPTURE],
    ['create-offer', OFFER_CAPTURE],
  ])('answers the %s PSBT field for field as the server did', (_name, capture) => {
    const decoded = decodeUnisatPsbt(capture.psbtHex) as Record<string, unknown>;
    expect(withoutFeeRateDisplay(decoded)).toEqual(withoutFeeRateDisplay(capture.data));
  });

  it('reports the fee over the unsigned size as display text', () => {
    // MINT_CAPTURE: 100000 in, 546 + 97954 out, unsigned size 137 bytes.
    expect(decodeUnisatPsbt(MINT_CAPTURE.psbtHex)).toEqual(expect.objectContaining({
      fee: 1500,
      feeRate: '≈10.9',
      shouldWarnFeeRate: false,
    }));
  });
});

describe('unisatOfflineAnswer', () => {
  const api = (path: string) => new URL(`https://wallet-api.unisat.space${path}`);

  it('clears the requesting site, which is what mounts the Connect button', () => {
    expect(unisatOfflineAnswer(api('/v5/default/check-website'), '{"website":"http://localhost:4500"}'))
      .toEqual({ isScammer: false, warning: '', allowQuickMultiSign: false });
  });

  it('answers multi-assets with one zero entry per queried address', () => {
    const answer = unisatOfflineAnswer(api('/v5/address/multi-assets?addresses=bc1qa%2C37b%2Cbc1pc')) as unknown[];
    expect(answer).toHaveLength(3);
    expect(answer[2]).toEqual(expect.objectContaining({ totalSatoshis: 0, inscriptionCount: 0, runesCount: 0 }));
  });

  it('echoes the queried version in the version detail', () => {
    expect(unisatOfflineAnswer(api('/v5/version/detail?version=1.7.19'))).toEqual(
      { version: '1.7.19', title: 'A new version v1.7.19 is available', notice: '', changelogs: [] },
    );
  });

  it('decodes the PSBT posted to decode2', () => {
    const answer = unisatOfflineAnswer(api('/v5/tx/decode2'), JSON.stringify({ psbtHex: MINT_CAPTURE.psbtHex, website: 'http://localhost:4500' }));
    expect(answer).toEqual(decodeUnisatPsbt(MINT_CAPTURE.psbtHex));
  });

  it('has no answer for an endpoint nobody captured', () => {
    expect(unisatOfflineAnswer(api('/v5/brc20/list?address=bc1q'))).toBeNull();
  });
});

describe('UNISAT_WALLET_API', () => {
  it.each([
    'https://wallet-api.unisat.space/v5/default/config',
    'https://wallet-api.unisat.io/v5/phishing-detect/hotlist',
    'https://wallet-api-testnet.unisat.io/v5/default/config',
    'https://wallet-api-fractal.unisat.space/v5/default/config',
  ])('covers %s', (url) => {
    expect(UNISAT_WALLET_API.test(url)).toBe(true);
  });

  it.each([
    'https://static.unisat.space/content/abc',
    'https://raw.githubusercontent.com/unisat-wallet/phishing-detect/master/phishing_sites.json',
    'http://localhost:4500/',
  ])('leaves %s alone', (url) => {
    expect(UNISAT_WALLET_API.test(url)).toBe(false);
  });
});

describe('installUnisatOfflineRoutes', () => {
  type Fulfil = { status: number; contentType: string; body: string };
  function fakeRoute(url: string, postData: string | null = null) {
    const calls: { fulfilled?: Fulfil; aborted?: string } = {};
    return {
      calls,
      route: {
        request: () => ({ url: () => url, postData: () => postData }),
        fulfill: async (r: Fulfil) => { calls.fulfilled = r; },
        abort: async (reason: string) => { calls.aborted = reason; },
      },
    };
  }

  async function installed() {
    const routes: { matcher: RegExp; handler: (route: unknown) => Promise<void> }[] = [];
    const context = { route: async (matcher: RegExp, handler: (route: unknown) => Promise<void>) => { routes.push({ matcher, handler }); } };
    await installUnisatOfflineRoutes(context as unknown as Parameters<typeof installUnisatOfflineRoutes>[0]);
    expect(routes).toHaveLength(1);
    return routes[0];
  }

  it('fulfils an answered endpoint inside UniSat\'s { code, msg, data } envelope', async () => {
    const { handler } = await installed();
    const { route, calls } = fakeRoute('https://wallet-api.unisat.space/v5/default/check-website', '{"website":"http://localhost:4500"}');
    await handler(route);
    expect(calls.fulfilled?.status).toBe(200);
    expect(JSON.parse(calls.fulfilled?.body ?? '')).toEqual({
      code: 0, msg: 'ok', data: { isScammer: false, warning: '', allowQuickMultiSign: false },
    });
  });

  it('aborts an endpoint with no answer instead of passing it to the server', async () => {
    const { handler } = await installed();
    const { route, calls } = fakeRoute('https://wallet-api.unisat.space/v5/brc20/list?address=bc1q');
    await handler(route);
    expect(calls).toEqual({ aborted: 'failed' });
  });
});
