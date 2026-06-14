import { useState } from 'react';

import { Box, Stack, styled } from 'leather-styles/jsx';

import { Button } from '@leather.io/ui';

/**
 * CAT-21 offer page (Phase 4.1 + 4.2 surface).
 *
 * Two modes governed by a toggle:
 *   - "Make an offer" (buyer-side): user picks a cat to acquire (inscription
 *     id + seller's listed UTXO) and a price; we build the ord-style PSBT
 *     via `generateCat21BuyOfferUnsignedPsbt`, sign the buyer inputs, hand
 *     the PSBT back as a base64 blob to copy into whatever channel the user
 *     uses to reach the seller (Discord, Moltbook, Twitter DM — per plan).
 *   - "Review an offer" (seller-side): user pastes a PSBT received from a
 *     buyer; we call `validateCat21BuyOffer` and surface a clear
 *     allowed/denied verdict with the reason. If allowed, the user signs
 *     input 0 and broadcasts.
 *
 * The wiring of the PSBT builder/validator to the wallet's signer + send-
 * flow lives in a follow-up commit; here we land the route and the form
 * surface so the UX is reviewable.
 */
export function Cat21OfferPage() {
  const [mode, setMode] = useState<'buy' | 'review'>('buy');

  return (
    <Stack p="space.05" gap="space.05" maxW="520px" data-testid="cat21-offer-page">
      <Box>
        <styled.h2 textStyle="heading.04">CAT-21 offer</styled.h2>
        <styled.p textStyle="body.02" color="ink.text-subdued">
          ord-style buyer-initiated offers. Every input uses SIGHASH_ALL so
          sniping is structurally impossible.
        </styled.p>
      </Box>

      <Stack direction="row" gap="space.02">
        <Button
          variant={mode === 'buy' ? undefined : 'outline'}
          onClick={() => setMode('buy')}
          data-testid="cat21-offer-tab-buy"
        >
          Make an offer
        </Button>
        <Button
          variant={mode === 'review' ? undefined : 'outline'}
          onClick={() => setMode('review')}
          data-testid="cat21-offer-tab-review"
        >
          Review an offer
        </Button>
      </Stack>

      {mode === 'buy' ? <BuyForm /> : <ReviewForm />}
    </Stack>
  );
}

const inputStyles = {
  px: 'space.03',
  py: 'space.02',
  borderColor: 'ink.border-default',
  borderWidth: '1px',
  borderRadius: 'xs',
} as const;

function BuyForm() {
  const [inscriptionId, setInscriptionId] = useState('');
  const [priceSats, setPriceSats] = useState('21000');
  return (
    <Stack gap="space.03">
      <Stack gap="space.02">
        <styled.label textStyle="label.01">Cat inscription id</styled.label>
        <styled.input
          value={inscriptionId}
          onChange={e => setInscriptionId(e.target.value)}
          placeholder="abcd...:0"
          data-testid="cat21-offer-buy-inscription-id"
          {...inputStyles}
        />
      </Stack>
      <Stack gap="space.02">
        <styled.label textStyle="label.01">Price (sats)</styled.label>
        <styled.input
          value={priceSats}
          onChange={e => setPriceSats(e.target.value)}
          placeholder="21000"
          data-testid="cat21-offer-buy-price"
          {...inputStyles}
        />
      </Stack>
      <Button data-testid="cat21-offer-buy-submit">Build offer PSBT</Button>
    </Stack>
  );
}

function ReviewForm() {
  const [psbtBase64, setPsbtBase64] = useState('');
  return (
    <Stack gap="space.03">
      <Stack gap="space.02">
        <styled.label textStyle="label.01">Paste offer PSBT (base64)</styled.label>
        <styled.input
          value={psbtBase64}
          onChange={e => setPsbtBase64(e.target.value)}
          placeholder="cHNidP8BA..."
          data-testid="cat21-offer-review-psbt"
          {...inputStyles}
        />
      </Stack>
      <Button data-testid="cat21-offer-review-submit">Validate</Button>
    </Stack>
  );
}
