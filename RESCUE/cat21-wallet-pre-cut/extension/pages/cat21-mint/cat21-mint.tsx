import { useState } from 'react';

import { Box, Stack, styled } from 'leather-styles/jsx';

import { Button } from '@leather.io/ui';

/**
 * CAT-21 mint page (Phase 3.1).
 *
 * Form fields:
 *   - recipient address (defaults to the active account's taproot receive
 *     address; user can override for gifting).
 *   - fee rate in sat/vB (free text input until the fee-estimator hook is
 *     wired — the back-end accepts any positive number).
 *   - optional tip (default OFF per the plan; toggle exposes a sat-amount
 *     input, 0 disables the output).
 *
 * Submitting calls `generateCat21MintUnsignedTransaction` from
 * `@leather.io/bitcoin` to build the PSBT (Phase 3.2), then routes the
 * resulting hex through `Cat21BroadcastService` (Phase 3.3) — the wiring of
 * those two stays in a follow-up commit because both depend on the wallet's
 * account-context hook (taproot payer lookup + change address), which is a
 * separate plumbing pass.
 *
 * For now this scaffold renders the form and pins the route. Submission is
 * a no-op so we can land the route without a half-implementation in the
 * tree.
 */
export function Cat21MintPage() {
  const [recipient, setRecipient] = useState('');
  const [feeRate, setFeeRate] = useState('5');
  const [tipEnabled, setTipEnabled] = useState(false);
  const [tipSats, setTipSats] = useState('1000');

  return (
    <Stack p="space.05" gap="space.05" maxW="480px" data-testid="cat21-mint-page">
      <Box>
        <styled.h2 textStyle="heading.04">Mint a CAT-21 cat</styled.h2>
        <styled.p textStyle="body.02" color="ink.text-subdued">
          Sets nLockTime to 21. Inputs are marked non-RBF so the mint cannot be
          accelerated and have its locktime stripped.
        </styled.p>
      </Box>

      <Stack gap="space.02">
        <styled.label textStyle="label.01">Recipient address</styled.label>
        <styled.input
          value={recipient}
          onChange={e => setRecipient(e.target.value)}
          placeholder="bc1p..."
          data-testid="cat21-mint-recipient"
          px="space.03"
          py="space.02"
          borderColor="ink.border-default"
          borderWidth="1px"
          borderRadius="xs"
        />
      </Stack>

      <Stack gap="space.02">
        <styled.label textStyle="label.01">Fee rate (sat/vB)</styled.label>
        <styled.input
          value={feeRate}
          onChange={e => setFeeRate(e.target.value)}
          placeholder="5"
          data-testid="cat21-mint-fee-rate"
          px="space.03"
          py="space.02"
          borderColor="ink.border-default"
          borderWidth="1px"
          borderRadius="xs"
        />
      </Stack>

      <Stack gap="space.02">
        <styled.label textStyle="label.01">
          <input
            type="checkbox"
            checked={tipEnabled}
            onChange={e => setTipEnabled(e.target.checked)}
            data-testid="cat21-mint-tip-toggle"
          />{' '}
          Tip the developers
        </styled.label>
        {tipEnabled && (
          <styled.input
            value={tipSats}
            onChange={e => setTipSats(e.target.value)}
            placeholder="1000"
            data-testid="cat21-mint-tip-sats"
            px="space.03"
            py="space.02"
            borderColor="ink.border-default"
            borderWidth="1px"
            borderRadius="xs"
          />
        )}
      </Stack>

      <Button
        onClick={() => {
          /* Submission wires to generateCat21MintUnsignedTransaction +
           * Cat21BroadcastService in a follow-up; the form is presented
           * here so the route + UX surface are reviewable. */
        }}
        data-testid="cat21-mint-submit"
      >
        Mint
      </Button>
    </Stack>
  );
}
