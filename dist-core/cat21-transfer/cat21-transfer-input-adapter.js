import { hex } from '@scure/base';
import { getDummyLegacyTransaction } from '../cat21-fee/dummy-keypair';
import { toScureNetwork } from '../network';
import { isSegWit } from '../cat21-script/address-format';
import { buildInputScript } from '../cat21-script/build-input-script';
export function prepareTransferCatInput(args) {
    return prepareInput(args);
}
export function prepareTransferFundingInput(args) {
    return prepareInput(args);
}
function prepareInput(args) {
    const scureNetwork = toScureNetwork(args.network);
    const { scriptData, tapInternalKey } = buildInputScript({
        paymentAddress: args.paymentAddress,
        paymentPublicKey: args.paymentPublicKey,
        isSimulation: args.isSimulation,
        network: scureNetwork,
    });
    const result = {
        txid: args.utxo.txid,
        vout: args.utxo.vout,
        value: args.utxo.value,
        scriptPubKey: scriptData.script,
    };
    if (scriptData.redeemScript) {
        result.redeemScript = scriptData.redeemScript;
    }
    if (tapInternalKey) {
        result.tapInternalKey = tapInternalKey;
    }
    if (!isSegWit(args.paymentAddress)) {
        if (args.isSimulation) {
            const dummyTx = getDummyLegacyTransaction(args.utxo, scureNetwork);
            result.txid = dummyTx.id;
            result.nonWitnessUtxo = hex.decode(dummyTx.hex);
        }
        else if (args.utxo.transactionHex) {
            result.nonWitnessUtxo = hex.decode(args.utxo.transactionHex);
        }
        else {
            throw new Error('Missing transaction hex for legacy UTXO input');
        }
    }
    return result;
}
//# sourceMappingURL=cat21-transfer-input-adapter.js.map