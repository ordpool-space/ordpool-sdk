"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDummyLegacyTransaction = exports.getDummyKeypair = exports.toXOnly = exports.isSegWit = exports.getMinimumUtxoSize = exports.getAddressFormat = void 0;
exports.createTransaction = createTransaction;
const cat21_postage_1 = require("../cat21-protocol/cat21-postage");
const address_format_1 = require("../cat21-script/address-format");
const cat21_mint_helper_1 = require("./cat21-mint.helper");
const cat21_mint_input_adapter_1 = require("./cat21-mint-input-adapter");
// Re-export from the new locations so existing consumers keep working
// while the v2 ecosystem migrates to the canonical import paths.
// Bitcoin / per-wallet script helpers live in `src/cat21-script/`;
// fee-simulation dummy material lives in `src/cat21-fee/`.
var address_format_2 = require("../cat21-script/address-format");
Object.defineProperty(exports, "getAddressFormat", { enumerable: true, get: function () { return address_format_2.getAddressFormat; } });
Object.defineProperty(exports, "getMinimumUtxoSize", { enumerable: true, get: function () { return address_format_2.getMinimumUtxoSize; } });
Object.defineProperty(exports, "isSegWit", { enumerable: true, get: function () { return address_format_2.isSegWit; } });
Object.defineProperty(exports, "toXOnly", { enumerable: true, get: function () { return address_format_2.toXOnly; } });
var dummy_keypair_1 = require("../cat21-fee/dummy-keypair");
Object.defineProperty(exports, "getDummyKeypair", { enumerable: true, get: function () { return dummy_keypair_1.getDummyKeypair; } });
Object.defineProperty(exports, "getDummyLegacyTransaction", { enumerable: true, get: function () { return dummy_keypair_1.getDummyLegacyTransaction; } });
/**
 * Layer-4 orchestration entry: adapts cat21.space-shaped args to
 * `prepareMintInputForWallet` (Layer 2) + `buildCat21MintPsbt`
 * (Layer 1). One PSBT-assembly path for cat21.space and
 * cat21-wallet's autonomous flow.
 *
 * Change below the per-address-type dust limit is absorbed into
 * the miner fee; above it, a second output is added.
 */
function createTransaction(walletType, recipientAddress, paymentOutput, paymentPublicKey, paymentAddress, transactionFee, isSimulation, network) {
    const fundingInput = (0, cat21_mint_input_adapter_1.prepareMintInputForWallet)(paymentOutput, paymentPublicKey, paymentAddress, isSimulation, network);
    let built;
    try {
        built = (0, cat21_mint_helper_1.buildCat21MintPsbt)({
            walletType,
            network,
            fundingInput,
            destinations: {
                recipientAddress,
                senderChangeAddress: paymentAddress,
            },
            feeSats: Number(transactionFee),
            // cat21.space's per-address-type dust floor (P2TR 330, P2WPKH 294,
            // P2SH 540). Default 546 if not supplied.
            changeDustLimitSats: (0, address_format_1.getMinimumUtxoSize)(paymentAddress),
        });
    }
    catch (err) {
        // The builder throws `Mint funding insufficient: …`; the cat21.space
        // call sites checked the legacy `Insufficient funds for transaction`
        // string. Translate so the UI keeps working.
        if (err instanceof Error && /Mint funding insufficient/.test(err.message)) {
            throw new Error('Insufficient funds for transaction');
        }
        throw err;
    }
    return {
        tx: built.tx,
        amountToRecipient: BigInt(cat21_postage_1.CAT21_POSTAGE_SATS), // always 546
        singleInputAmount: BigInt(paymentOutput.value),
        changeAmount: BigInt(built.changeSats),
        finalTransactionFee: BigInt(built.finalFeeSats),
    };
}
//# sourceMappingURL=cat21.service.helper.js.map