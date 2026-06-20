"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prepareMintInputForWallet = prepareMintInputForWallet;
const base_1 = require("@scure/base");
const network_1 = require("../network");
const build_input_script_1 = require("../cat21-script/build-input-script");
const address_format_1 = require("../cat21-script/address-format");
const dummy_keypair_1 = require("../cat21-fee/dummy-keypair");
/**
 * Layer-2 input adapter for the CAT-21 mint pipeline.
 *
 * Takes a raw funding UTXO (`TxnOutput`) plus the wallet's payment
 * details and produces the full `Cat21MintFundingInput` shape that
 * `buildCat21MintPsbt` consumes.
 *
 * Address-format-driven via `buildInputScript`. The wallet identity
 * is irrelevant — only the payment address shape matters.
 *
 * Pure function. No I/O, no Angular.
 */
function prepareMintInputForWallet(paymentOutput, paymentPublicKey, paymentAddress, isSimulation, network) {
    const scureNetwork = (0, network_1.toScureNetwork)(network);
    const { scriptData, tapInternalKey } = (0, build_input_script_1.buildInputScript)({
        paymentAddress,
        paymentPublicKey,
        isSimulation,
        network: scureNetwork,
    });
    const result = {
        txid: paymentOutput.txid,
        vout: paymentOutput.vout,
        value: paymentOutput.value,
        scriptPubKey: scriptData.script,
    };
    if (scriptData.redeemScript) {
        result.redeemScript = scriptData.redeemScript;
    }
    if (tapInternalKey) {
        result.tapInternalKey = tapInternalKey;
    }
    if (!(0, address_format_1.isSegWit)(paymentAddress)) {
        // Legacy P2PKH path. Scure refuses witnessUtxo on legacy inputs;
        // the full previous-tx bytes go via nonWitnessUtxo.
        if (isSimulation) {
            const dummyTx = (0, dummy_keypair_1.getDummyLegacyTransaction)(paymentOutput, scureNetwork);
            result.txid = dummyTx.id;
            result.nonWitnessUtxo = base_1.hex.decode(dummyTx.hex);
        }
        else if (paymentOutput.transactionHex) {
            result.nonWitnessUtxo = base_1.hex.decode(paymentOutput.transactionHex);
        }
        else {
            throw new Error('Missing transaction hex for legacy UTXO input');
        }
    }
    return result;
}
//# sourceMappingURL=cat21-mint-input-adapter.js.map