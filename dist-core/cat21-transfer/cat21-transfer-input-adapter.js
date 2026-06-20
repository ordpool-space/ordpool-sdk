"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prepareTransferCatInput = prepareTransferCatInput;
exports.prepareTransferFundingInput = prepareTransferFundingInput;
const base_1 = require("@scure/base");
const dummy_keypair_1 = require("../cat21-fee/dummy-keypair");
const network_1 = require("../network");
const address_format_1 = require("../cat21-script/address-format");
const build_input_script_1 = require("../cat21-script/build-input-script");
function prepareTransferCatInput(args) {
    return prepareInput(args);
}
function prepareTransferFundingInput(args) {
    return prepareInput(args);
}
function prepareInput(args) {
    const scureNetwork = (0, network_1.toScureNetwork)(args.network);
    const { scriptData, tapInternalKey } = (0, build_input_script_1.buildInputScript)({
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
    if (!(0, address_format_1.isSegWit)(args.paymentAddress)) {
        if (args.isSimulation) {
            const dummyTx = (0, dummy_keypair_1.getDummyLegacyTransaction)(args.utxo, scureNetwork);
            result.txid = dummyTx.id;
            result.nonWitnessUtxo = base_1.hex.decode(dummyTx.hex);
        }
        else if (args.utxo.transactionHex) {
            result.nonWitnessUtxo = base_1.hex.decode(args.utxo.transactionHex);
        }
        else {
            throw new Error('Missing transaction hex for legacy UTXO input');
        }
    }
    return result;
}
//# sourceMappingURL=cat21-transfer-input-adapter.js.map