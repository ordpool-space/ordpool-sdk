/**
 * @test-kind unit
 * Real:   the footer component
 * Faked:  ordpool-sdk -> hand-written object
 * Proves: a hand-written SDK replacement is reported
 */
jest.mock('ordpool-sdk', () => ({
  FAMILY_LINKS: [],
}));

import { footer } from './footer';

it('renders', () => {
  expect(footer()).toBe('');
});
