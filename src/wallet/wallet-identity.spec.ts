import { sameWallet, walletIdentity } from './wallet-identity.js';

const w = {
  type: 'xverse',
  ordinalsAddress: 'bc1p-ord',
  paymentAddress: 'bc1q-pay',
  paymentPublicKey: '02aa',
};

describe('sameWallet', () => {
  it('a re-emission of the same wallet is the same wallet', () => {
    expect(sameWallet(w, { ...w })).toBe(true);
  });

  it.each([
    ['type', { ...w, type: 'unisat' }],
    ['ordinalsAddress', { ...w, ordinalsAddress: 'bc1p-other' }],
    ['paymentAddress', { ...w, paymentAddress: 'bc1q-other' }],
    ['paymentPublicKey', { ...w, paymentPublicKey: '02bb' }],
  ])('a different %s is a different wallet', (_field, other) => {
    // Comparing one address only is how a real change reads as a re-emission:
    // the flow keeps state belonging to the previous wallet.
    expect(sameWallet(w, other)).toBe(false);
  });

  it('null and a wallet are never the same, in either order', () => {
    expect([sameWallet(null, w), sameWallet(w, null), sameWallet(null, null)]).toEqual([false, false, true]);
  });

  it('two different wallets cannot produce the same identity string', () => {
    // A fixed-arity join collides when the separator sits at a FIELD BOUNDARY:
    // ('A|', 'B') and ('A', '|B') both render "A||B". Addresses never contain
    // one, but an identity comparison should not rest on the charset of its
    // inputs, and a test that only tries values a join happens to survive is
    // not testing the property.
    const a = { ...w, ordinalsAddress: 'bc1p|', paymentAddress: 'bc1q' };
    const b = { ...w, ordinalsAddress: 'bc1p', paymentAddress: '|bc1q' };
    expect(walletIdentity(a)).not.toBe(walletIdentity(b));
    expect(sameWallet(a, b)).toBe(false);
  });
});

describe('walletIdentity covers the ordinals public key', () => {
  // A transfer signs the CAT INPUT with this key. A wallet re-reporting the
  // same addresses with a resolved or re-encoded ordinals key must NOT be
  // treated as a re-emission, or the stale key signs the input spending a cat.
  const base = {
    type: 'xverse',
    ordinalsAddress: 'bc1pord',
    paymentAddress: 'bc1qpay',
    paymentPublicKey: '02aa',
    ordinalsPublicKey: 'bb'.repeat(32),
  };

  it('treats a changed ordinalsPublicKey as a DIFFERENT wallet', () => {
    expect(sameWallet(base, { ...base, ordinalsPublicKey: 'cc'.repeat(32) })).toBe(false);
  });

  it('treats an absent-then-filled ordinalsPublicKey as a DIFFERENT wallet', () => {
    expect(sameWallet({ ...base, ordinalsPublicKey: undefined }, base)).toBe(false);
  });

  it('still treats an unchanged full tuple as the same wallet', () => {
    expect(sameWallet(base, { ...base })).toBe(true);
  });
});
