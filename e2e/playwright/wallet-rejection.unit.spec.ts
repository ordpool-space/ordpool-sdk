import { describeWalletRejection, REFUSED_WITH_DETAIL, WALLET_PROBE_TIMEOUT_CODE } from './wallet-rejection';

// Two payloads Wizz has produced for one underlying state (fixture-absent
// P2TR), captured from CI runs. They must read as the same refusal, because
// pinning which one arrived turns the cell red on outcomes that mean the same
// thing.
const OBSERVED_REFUSALS = [
  { ok: false, code: -32603, err: 'Connection error, please try again' },
  { ok: false, code: 4001, err: 'User rejected the request.' },
];

// What the wizz-matrix P2TR probe resolves with when its own 30s timer wins
// the race against `wizz.requestAccounts`.
const PROBE_TIMEOUT_SENTINEL = {
  ok: false,
  code: WALLET_PROBE_TIMEOUT_CODE,
  err: 'wizz.requestAccounts did not settle within 30s',
};

describe('describeWalletRejection', () => {
  it.each(OBSERVED_REFUSALS)('reads a real refusal as refused-with-detail: %j', (outcome) => {
    expect(describeWalletRejection(outcome)).toEqual(REFUSED_WITH_DETAIL);
  });

  it('reads our own timeout sentinel as a hang, not as a refusal', () => {
    // A wallet that never answers has said nothing. The sentinel's code and
    // message are ours, so neither counts as wallet detail.
    expect(describeWalletRejection(PROBE_TIMEOUT_SENTINEL)).toEqual({
      refused: false,
      timedOut: true,
      carriesCode: false,
      carriesMessage: false,
      handedOutAccounts: false,
    });
  });

  it('does not read a granted account as a refusal', () => {
    expect(describeWalletRejection({ ok: true, accs: ['bc1p…'] })).toEqual({
      refused: false,
      timedOut: false,
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
      timedOut: false,
      carriesCode: false,
      carriesMessage: false,
      handedOutAccounts: false,
    });
  });

  it('does not accept an empty message as a message', () => {
    expect(describeWalletRejection({ ok: false, code: 4001, err: '' }).carriesMessage).toBe(false);
  });

  it('does not accept a string code', () => {
    // Wallet codes are numeric (EIP-1193 / JSON-RPC). A string code was
    // invented somewhere, not received from the wallet.
    expect(describeWalletRejection({ ok: false, code: 'oops', err: 'x' }).carriesCode).toBe(false);
  });
});
