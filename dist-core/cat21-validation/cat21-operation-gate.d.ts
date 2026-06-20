/**
 * Bulletproof validation gate for the four cat21 mutating operations.
 *
 * Single entry: `validateCat21Operation({ config, operation })`.
 *
 * Failure mode is a typed discriminated union — no exceptions, no
 * phantom `Validated<I>` brand. The success branch hands back
 * pre-decoded resources (scriptPubKey, parsed catId pieces) so
 * downstream code never re-decodes.
 *
 * Spec coverage is exhaustive: every member of `Cat21GateRejectReason`
 * has a dedicated test in `cat21-operation-gate.spec.ts`.
 */
import type { Cat21Operation, Cat21OperationGateConfig, Cat21OperationGateResult } from './cat21-operation-gate.types';
export declare function validateCat21Operation(args: {
    config: Cat21OperationGateConfig;
    operation: Cat21Operation;
}): Cat21OperationGateResult;
//# sourceMappingURL=cat21-operation-gate.d.ts.map