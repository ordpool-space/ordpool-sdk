/**
 * Inscribe operation validation gate. Parallel to
 * `validateCat21Operation` from `cat21-validation/`, separate by
 * design (different protocol, different consumer set). See the
 * types file for the full rationale.
 */
import { InscribeOperation, InscribeOperationGateConfig, InscribeOperationGateResult } from './inscribe-operation-gate.types';
export declare function validateInscribeOperation(args: {
    config: InscribeOperationGateConfig;
    operation: InscribeOperation;
}): InscribeOperationGateResult;
//# sourceMappingURL=inscribe-operation-gate.d.ts.map