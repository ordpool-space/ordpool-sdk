import { describeWalletRejection, REFUSED_WITH_DETAIL } from './wallet-rejection';

// The three payloads Wizz has actually produced for one underlying state
// (fixture-absent P2TR), captured from CI runs. They must all read as the same
// refusal, because pinning which one arrived is what made the cell red three
// times on outcomes that meant the same thing.
const OBSERVED_REFUSALS = [
  { ok: false, code: -32603, err: 'Connection error, please try again' },
  { ok: false, code: 4001, err: 'User rejected the request.' },
  { ok: false, code: 'timeout', err: 'wizz.requestAccounts hung 30s — configs.wizz.cash route aborted, SW stuck waiting for session-init handshake' },
];

describe('describeWalletRejection', () => {
  it.each(OBSERVED_REFUSALS)('reads a real refusal as refused-with-detail: %j', (outcome) => {
    expect(describeWalletRejection(outcome)).toEqual(REFUSED_WITH_DETAIL);
  });

  it('does not read a granted account as a refusal', () => {
    expect(describeWalletRejection({ ok: true, accs: ['bc1p…'] })).toEqual({
      refused: false,
      carriesCode: false,
      carriesMessage: false,
      handedOutAccounts: true,
    });
  });

  it('does not read a bare failure as refused-with-detail', () => {
    // A wallet that rejects with nothing, or a probe that lost the error, is
    // NOT the same observation as a wallet that said why.
    expect(describeWalletRejection({ ok: false })).toEqual({
      refused: true,
      carriesCode: false,
      carriesMessage: false,
      handedOutAccounts: false,
    });
  });

  it('does not accept an empty message as a message', () => {
    expect(describeWalletRejection({ ok: false, code: 4001, err: '' }).carriesMessage).toBe(false);
  });

  it('does not accept an arbitrary string code', () => {
    // `timeout` is OUR sentinel from the in-page race. Any other string means
    // the shape was invented somewhere, not received from the wallet.
    expect(describeWalletRejection({ ok: false, code: 'oops', err: 'x' }).carriesCode).toBe(false);
  });
});
