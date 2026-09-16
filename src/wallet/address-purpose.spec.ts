import { AddressPurpose as SatsConnectAddressPurpose } from 'sats-connect';

import { AddressPurpose } from './address-purpose';

/**
 * The local `AddressPurpose` is a hand-copy of sats-connect's enum, made so
 * that importing it does not drag the sats-connect cluster into every
 * connector. A hand-copy of a wire protocol is only safe while something
 * compares it to the original.
 *
 * Nothing did. Corrupting `Ordinals` to `'ordinalz'` left the whole suite
 * green, which means a typo here would have shipped and Xverse address
 * resolution would have failed by finding nothing, silently.
 *
 * This compares against the REAL enum, imported from the package. It is not a
 * tautology: the two are different objects from different files, so it catches
 * a typo in our copy AND an upstream value change on a sats-connect bump.
 */
describe('AddressPurpose (local redeclaration of sats-connect\'s enum)', () => {

  it('every member matches the value sats-connect declares', () => {
    expect(AddressPurpose.Ordinals).toBe(SatsConnectAddressPurpose.Ordinals);
    expect(AddressPurpose.Payment).toBe(SatsConnectAddressPurpose.Payment);
    expect(AddressPurpose.Stacks).toBe(SatsConnectAddressPurpose.Stacks);
  });

  it('spells the two purposes the SDK actually compares against', () => {
    // Pinned literally as well, so the spec still says what the wire looks
    // like if sats-connect is ever swapped out.
    expect(AddressPurpose.Ordinals).toBe('ordinals');
    expect(AddressPurpose.Payment).toBe('payment');
  });

  it('covers every member of the upstream enum, so a new purpose cannot go unnoticed', () => {
    // A new member upstream (Starknet and Spark arrived this way) means our
    // copy is incomplete. Comparing key sets is what makes that loud.
    expect(Object.keys(AddressPurpose).sort())
      .toEqual(Object.keys(SatsConnectAddressPurpose).sort());
  });
});
