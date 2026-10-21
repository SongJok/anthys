import {z} from 'zod';
export const runtimeBudgetSchema=z.object({
 schemaVersion:z.literal(1),
 maxTurns:z.number().int().min(0).max(64),
 maxTools:z.number().int().min(0).max(120),
 maxActiveMs:z.number().int().min(1).max(1800000)
}).strict();
export type RuntimeBudget=z.infer<typeof runtimeBudgetSchema>;
export class BudgetError extends Error {
 constructor(readonly code:string,readonly retryable=false,readonly retryAfterMs:number|null=null){super(code);this.name='BudgetError';}
}
