// Shared BIP-39 test vector + per-wallet onboarding password for the wallet
// E2E specs AND the local regtest wallet-runner. Centralized so the seed and
// password aren't re-declared at the top of ~40 spec files.
//
// The well-known abandon×11 + about vector; deliberately unsuited for real use
// (anyone with the seed observes the wallet).
export const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const TEST_MNEMONIC_WORDS = TEST_MNEMONIC.split(' ');

// Most wallets accept a simple password; the Leather family (leather +
// cat21wallet, which is a Leather fork) runs a zxcvbn strength meter that
// rejects it, so it needs a strong one.
export const SIMPLE_PASSWORD = 'TestPassword123!';
export const LEATHER_FAMILY_PASSWORD = 'correct-horse-battery-staple-Tr0ub4dor-9876';

export const PASSWORD_BY_WALLET: Record<string, string> = {
  xverse: SIMPLE_PASSWORD,
  unisat: SIMPLE_PASSWORD,
  wizz: SIMPLE_PASSWORD,
  okx: SIMPLE_PASSWORD,
  phantom: SIMPLE_PASSWORD,
  alby: SIMPLE_PASSWORD,
  leather: LEATHER_FAMILY_PASSWORD,
  cat21wallet: LEATHER_FAMILY_PASSWORD,
};
