import { describe, expect, it, beforeAll } from '@jest/globals';
import { secp256k1 } from '@noble/curves/secp256k1';
import { base58 } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { execSync } from 'node:child_process';

import { createTransaction } from '../../src/cat21-mint/cat21.service.helper';
import { TxnOutput } from '../../src/cat21-mint/cat21.service.types';
import { Network } from '../../src/network';
import { KnownOrdinalWalletType } from '../../src/wallet/wallet.service.types';
import {
  ElectrsUtxo,
  FundedAccount,
  getFundedAccount,
  getTxHex,
  getTxStatus,
  getUtxos,
  mineBlocks,
  postTx,
  waitForElectrsSync,
} from './regtest-helpers';


/**
 * Decode a regtest WIF (Wallet Import Format) into the raw 32-byte
 * private key + compressed flag. Regtest WIFs use version byte 0xef
 * (same as testnet — bitcoind treats regtest as a flavour of testnet
 * for address/key encoding).
 */
function wifToPrivateKey(wif: string): { privateKey: Uint8Array; compressed: boolean } {
  const decoded = base58.decode(wif);
  // [version (1)] [privkey (32)] [compressed flag (1, optional)] [checksum (4)]
  const payload = decoded.slice(0, -4);
  const privateKey = payload.slice(1, 33);
  const compressed = payload.length === 34;
  return { privateKey, compressed };
}


describe('cat21 mint roundtrip on regtest', () => {

  let funded: FundedAccount;
  let funderPrivateKey: Uint8Array;
  let funderPublicKey: Uint8Array;
  let funderWpkhAddress: string;

  beforeAll(async () => {
    funded = getFundedAccount();
    const { privateKey } = wifToPrivateKey(funded.wif);
    funderPrivateKey = privateKey;
    funderPublicKey = secp256k1.getPublicKey(privateKey, true);
    // Mint a CAT-21 from a SegWit input — derive a P2WPKH address
    // from the same key and fund it by sending from the bootstrap's
    // legacy coinbase wallet.
    funderWpkhAddress = btc.p2wpkh(funderPublicKey, btc.TEST_NETWORK).address!;

    const sendCmd = `docker exec ordpool-e2e-bitcoind bitcoin-cli -regtest -rpcuser=ordpool -rpcpassword=ordpool -rpcwallet=ordpool-e2e sendtoaddress ${funderWpkhAddress} 1.0`;
    execSync(sendCmd, { encoding: 'utf8' });
    const tipAfterMine = mineBlocks(1);
    await waitForElectrsSync(tipAfterMine);
  });

  it('builds + signs + broadcasts a CAT-21 mint tx, and electrs reports it confirmed after mining', async () => {

    // --- 1. fetch a real UTXO via the same Esplora API the SDK uses ---
    const utxos: ElectrsUtxo[] = await getUtxos(funderWpkhAddress);
    expect(utxos.length).toBeGreaterThan(0);
    const utxo = utxos[0];
    expect(utxo.value).toBe(100_000_000); // 1 BTC

    // --- 2. construct a CAT-21 mint via the SDK's pure helper ---
    const recipientPubkey = funderPublicKey; // mint to ourselves
    const recipientTaprootAddress = btc.p2tr(
      recipientPubkey.subarray(1, 33), // x-only
      undefined, btc.TEST_NETWORK, true
    ).address!;

    const paymentOutput: TxnOutput = {
      txid: utxo.txid,
      vout: utxo.vout,
      value: utxo.value,
      status: utxo.status,
    };

    const { tx, finalTransactionFee } = createTransaction(
      KnownOrdinalWalletType.leather, // P2WPKH path
      recipientTaprootAddress,
      paymentOutput,
      funderPublicKey,
      funderWpkhAddress,
      BigInt(2_000), // 2000 sats fee
      false,         // not a simulation
      Network.Regtest,
    );

    expect(tx.lockTime).toBe(21); // CAT-21 invariant
    expect(finalTransactionFee).toBe(BigInt(2_000));

    // --- 3. sign with the funder's real private key ---
    tx.signIdx(funderPrivateKey, 0, [btc.SigHash.ALL]);
    tx.finalize();
    const finalizedHex = tx.hex;
    const finalizedTxid = tx.id;

    // --- 4. broadcast via electrs (same POST /tx the SDK does) ---
    const broadcastedTxid = await postTx(finalizedHex);
    expect(broadcastedTxid).toBe(finalizedTxid);

    // --- 5. mine it into a block + wait for electrs to index ---
    const tipAfterMine = mineBlocks(1);
    await waitForElectrsSync(tipAfterMine);

    // --- 6. verify the tx is confirmed via electrs (same status endpoint shape) ---
    const status = await getTxStatus(finalizedTxid);
    expect(status.confirmed).toBe(true);
    expect(status.block_height).toBe(tipAfterMine);

    // --- 7. and the raw hex is retrievable + identical ---
    const retrievedHex = await getTxHex(finalizedTxid);
    expect(retrievedHex).toBe(finalizedHex);
  });
});
