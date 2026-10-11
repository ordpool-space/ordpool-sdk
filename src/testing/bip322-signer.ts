import { schnorr } from '@noble/curves/secp256k1';
import { base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';

import { Network, toScureNetwork } from '../network.js';

/**
 * The P2TR (key path, no script tree) address of a test key on `network`, the
 * address `signTestBip322Message` signs for.
 */
export function testTaprootAddress(privateKey: Uint8Array, network: Network = Network.Mainnet): string {
  const address = btc.p2tr(schnorr.getPublicKey(privateKey), undefined, toScureNetwork(network)).address;
  if (!address) throw new Error('p2tr payment has no address');
  return address;
}

/**
 * A BIP-322 "simple" signature over `message` for the P2TR address of
 * `privateKey`, in the shape Xverse and Leather return it: the serialized
 * `to_sign` witness (one item, a 64-byte schnorr signature, SIGHASH_DEFAULT),
 * base64.
 *
 * Built from the BIP's recipe and not from `verifyBip322Signature`'s code, so
 * a spec that verifies it checks the verifier against the BIP:
 * `to_spend` spends the all-zero outpoint (index 0xffffffff) with scriptSig
 * `OP_0 <tagged_hash("BIP0322-signed-message", message)>` to the signer's
 * script; `to_sign` spends `to_spend:0` to a single `OP_RETURN`. Both are
 * version 0, lock time 0, sequence 0.
 *
 * Test keys only. Pure `@scure` and `@noble`: runs unchanged in Node and in a
 * browser.
 */
export function signTestBip322Message(args: {
  privateKey: Uint8Array;
  message: string;
  network?: Network;
}): string {
  const script = btc.p2tr(
    schnorr.getPublicKey(args.privateKey),
    undefined,
    toScureNetwork(args.network ?? Network.Mainnet),
  ).script;
  const messageHash = schnorr.utils.taggedHash('BIP0322-signed-message', new TextEncoder().encode(args.message));

  const toSpend = new btc.Transaction({ version: 0, lockTime: 0, allowUnknownInputs: true, allowUnknownOutputs: true });
  // Output first: @scure treats an input carrying finalScriptSig as signed and
  // refuses outputs added after it.
  toSpend.addOutput({ script, amount: 0n });
  toSpend.addInput({
    txid: new Uint8Array(32),
    index: 0xffffffff,
    sequence: 0,
    finalScriptSig: btc.Script.encode(['OP_0', messageHash]),
  });

  const toSign = new btc.Transaction({ version: 0, lockTime: 0, allowUnknownOutputs: true });
  toSign.addInput({
    txid: toSpend.id,
    index: 0,
    sequence: 0,
    witnessUtxo: { script, amount: 0n },
    tapInternalKey: schnorr.getPublicKey(args.privateKey),
  });
  toSign.addOutput({ script: btc.Script.encode(['RETURN']), amount: 0n });
  toSign.signIdx(args.privateKey, 0);
  const sig = toSign.getInput(0).tapKeySig;
  if (!sig) throw new Error('to_sign input 0 carries no taproot key signature');
  return base64.encode(new Uint8Array([0x01, sig.length, ...sig]));
}
