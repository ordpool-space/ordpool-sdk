/**
 * The typed errors an inscribe UI surfaces: each carries a stable code, a
 * message written for a person, and the numbers behind it. The developer
 * message stays what it was, so logs and error handling are unchanged.
 */

import { describe, expect, it } from '@jest/globals';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';

import { Network, toScureNetwork } from '../network';

import { InscribeInputError, inscribeUserMessage } from './inscribe-errors';
import { createInscribeTransactions } from './inscription.service.helper';
import type { CreateInscribeTransactionsArgs } from './inscription.service.helper';
import { packInscriptionProperties } from './inscription-properties';

const NETWORK = Network.Mainnet;
const scureNetwork = toScureNetwork(NETWORK);
const PAYMENT_PRIV = new Uint8Array(32).fill(0xab);
const paymentAddress = btc.p2tr(schnorr.getPublicKey(PAYMENT_PRIV), undefined, scureNetwork, true).address!;

function build(overrides: Partial<CreateInscribeTransactionsArgs>) {
  return createInscribeTransactions({
    paymentOutput: { txid: 'd'.repeat(64), vout: 0, value: 100_000, status: { confirmed: true } },
    paymentPublicKey: secp256k1.getPublicKey(PAYMENT_PRIV, true),
    paymentAddress,
    recipientAddress: paymentAddress,
    body: new TextEncoder().encode('x'),
    contentType: 'text/plain',
    feeRatePerVbyte: 3,
    network: NETWORK,
    ...overrides,
  });
}

/** The error a call threw, typed. */
function caught(fn: () => unknown): InscribeInputError {
  try {
    fn();
  } catch (err) {
    if (err instanceof InscribeInputError) return err;
    throw err;
  }
  throw new Error('expected an InscribeInputError');
}

describe('InscribeInputError', () => {
  it('a malformed gallery id: code, a message naming the id, and the id in details', () => {
    const e = caught(() => build({ gallery: ['not-an-id'] }));
    expect(e.code).toBe('invalid-inscription-id');
    expect(e.userMessage).toContain('"not-an-id" is not an inscription id');
    expect(e.details).toEqual({ inscriptionId: 'not-an-id' });
    // The developer message is unchanged.
    expect(e.message).toContain('expected 64 lowercase hex');
  });

  it('a sat below the dust limit into its coin: how much padding is needed, as a number', () => {
    const e = caught(() => build({ satOffset: 100 }));
    expect(e.code).toBe('sat-offset-needs-padding');
    expect(e.details).toEqual({ satOffset: 100, dustLimit: 330, neededPaddingSats: 230 });
    expect(e.userMessage).toContain('Add a second coin of at least 230 sats');
  });

  it('a coin that cannot pay names what it holds', () => {
    const e = caught(() => build({ paymentOutput: { txid: 'd'.repeat(64), vout: 0, value: 700, status: { confirmed: true } } }));
    expect(e.code).toBe('insufficient-funds');
    expect(e.details).toEqual({ availableSats: 700 });
    expect(e.userMessage).toBe('This coin (700 sats) does not cover the inscription and its fees.');
  });

  it('neither a file nor a delegate', () => {
    const e = caught(() => build({ body: undefined }));
    expect(e.code).toBe('body-or-delegate-required');
    expect(e.userMessage).toBe('Choose a file to inscribe, or an inscription to delegate to.');
  });

  it('a duplicate trait name, which makes ord drop the whole properties field', () => {
    const e = caught(() => packInscriptionProperties({ traits: [['a', 1], ['a', 2]] }));
    expect(e.code).toBe('duplicate-trait');
    expect(e.details).toEqual({ name: 'a' });
  });

  it('inscribeUserMessage: our message for our errors, the plain one otherwise', () => {
    expect(inscribeUserMessage(caught(() => build({ body: undefined }))))
      .toBe('Choose a file to inscribe, or an inscription to delegate to.');
    expect(inscribeUserMessage(new Error('something else'))).toBe('something else');
  });

  it('is a normal Error, so existing handling keeps working', () => {
    const e = caught(() => build({ gallery: ['not-an-id'] }));
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('InscribeInputError');
  });
});
