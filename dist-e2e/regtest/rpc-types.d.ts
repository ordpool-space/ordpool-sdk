/**
 * Typed readers for the `bitcoin-cli` responses this family's harnesses parse.
 *
 * `rpc()` correctly returns `string`, a raw CLI wrapper. The untyped surface is
 * the line AFTER it: every caller writes `JSON.parse(rpc(...)) as {...}` with
 * its own hand-written shape, or omits the cast and reads `any`. A shape that
 * drifts then fails nothing, because nothing ever typechecked the assumption.
 *
 * Every field below was captured from a live Bitcoin Core v30 regtest node
 * rather than transcribed from the docs, and the interfaces are deliberately
 * PARTIAL: they carry what a harness reads, and an unlisted field is absent
 * from the type rather than guessed at.
 */
/** `getrawtransaction <txid> true`. */
export interface RpcRawTransaction {
    txid: string;
    hash: string;
    version: number;
    size: number;
    vsize: number;
    weight: number;
    locktime: number;
    hex: string;
    vin: RpcVin[];
    vout: RpcVout[];
    /** Absent while the transaction is unconfirmed. */
    blockhash?: string;
    confirmations?: number;
    time?: number;
    blocktime?: number;
}
export interface RpcVin {
    sequence: number;
    /** Present on a coinbase input; `txid`/`vout` are absent there. */
    coinbase?: string;
    txid?: string;
    vout?: number;
    txinwitness?: string[];
    scriptSig?: {
        asm: string;
        hex: string;
    };
}
export interface RpcVout {
    /** BTC, not sats: `bitcoin-cli` reports a decimal here. */
    value: number;
    n: number;
    scriptPubKey: RpcScriptPubKey;
}
export interface RpcScriptPubKey {
    asm: string;
    hex: string;
    type: string;
    desc?: string;
    /** Absent for a script type Core cannot render as an address. */
    address?: string;
}
/** One entry of `listunspent`. */
export interface RpcUnspent {
    txid: string;
    vout: number;
    address: string;
    /** BTC, not sats. */
    amount: number;
    confirmations: number;
    scriptPubKey: string;
    spendable: boolean;
    solvable: boolean;
    safe: boolean;
    label?: string;
    desc?: string;
}
/** `getaddressinfo <address>`. */
export interface RpcAddressInfo {
    address: string;
    scriptPubKey: string;
    ismine: boolean;
    iswatchonly: boolean;
    isscript: boolean;
    iswitness: boolean;
    /** Absent for a script address, which has no single pubkey. */
    pubkey?: string;
    desc?: string;
    witness_version?: number;
    witness_program?: string;
    hdkeypath?: string;
}
//# sourceMappingURL=rpc-types.d.ts.map