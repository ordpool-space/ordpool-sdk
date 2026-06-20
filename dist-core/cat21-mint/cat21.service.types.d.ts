import * as btc from '@scure/btc-signer';
/**
 * Esplora-API `status` shape on a UTXO record. Mirrors the field set
 * mempool/electrs returns; inlined here so the SDK doesn't reach back
 * into the frontend's `interfaces/electrs.interface.ts`.
 */
export interface TxnOutputStatus {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
}
export interface TxnOutput {
    txid: string;
    vout: number;
    status: TxnOutputStatus;
    value: number;
    transactionHex?: string;
}
export interface LeatherSignPsbtRequestParams {
    hex: string;
    allowedSighash?: any[];
    signAtIndex?: number | number[];
    network?: 'mainnet' | 'testnet' | 'signet' | 'sbtcDevenv' | 'devnet';
    account?: number;
    broadcast?: boolean;
}
export interface LeatherPSBTBroadcastResponse {
    jsonrpc: string;
    id: string;
    result: {
        hex: string;
    };
}
export interface DummyKeypairResult {
    dummyPrivateKey: Uint8Array;
    dummyPublicKey: Uint8Array;
    xOnlyDummyPublicKey: Uint8Array;
    /**
     * "Legacy" Pay-to-Public-Key-Hash (P2PKH)
     */
    addressP2PKH: string;
    /**
     * Nested Segwit (P2SH-P2WPKH)
     */
    addressP2SH_P2WPKH: string;
    /**
     * Native Seqwit (P2WPKH)
     */
    addressP2WPKH: string;
    /**
     * TapRoot (P2TR)
     */
    addressP2TR: string;
}
export interface CreateTransactionResult {
    tx: btc.Transaction;
    amountToRecipient: bigint;
    singleInputAmount: bigint;
    changeAmount: bigint;
    finalTransactionFee: bigint;
}
export interface SimulateTransactionResult extends CreateTransactionResult {
    vsize: number;
}
/**
 * Trimmed shape of a mempool transaction as returned by electrs
 * (`/api/address/:addr/txs/mempool`). Only the fields the pendingMints
 * helper needs are declared — electrs returns more (vin, scriptpubkey
 * details, weight breakdowns), all ignored.
 */
export interface MempoolTx {
    txid: string;
    locktime: number;
    weight: number;
    fee: number;
    vout: Array<{
        scriptpubkey_address?: string;
        value: number;
    }>;
}
/**
 * A CAT-21 mint we've spotted in the mempool addressed to one of the
 * wallet's queried addresses. `seenAt` is the ISO timestamp of the
 * first poll that included this txid — stable across re-emissions in
 * the same polling session, so a UI can render "in mempool for 2m".
 */
export interface PendingMint {
    txid: string;
    vsize: number;
    fee: number;
    feeRate: number;
    recipientAddress: string;
    seenAt: string;
}
/**
 * Shape of the mempool-framework `/api/v1/fees/recommended` response
 * (api.ordpool.space proxies/serves it). Five tiers in sat/vB —
 * fastest within ~10 minutes, halfHour, hour, economy, and the
 * mempool minimum that would be accepted at all. The fee picker in
 * both consumers renders the three middle tiers as quick-pick
 * buttons; minimumFee is used as a lower-bound validation hint.
 */
export interface RecommendedFees {
    fastestFee: number;
    halfHourFee: number;
    hourFee: number;
    economyFee: number;
    minimumFee: number;
}
//# sourceMappingURL=cat21.service.types.d.ts.map