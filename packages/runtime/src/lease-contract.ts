import {z} from 'zod';
import {runtimeBudgetSchema} from './budget.js';
export const groupAudienceRef=z.object({id:z.uuid(),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const personaSnapshotRef=z.object({id:z.uuid(),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
/** Immutable audience input, deliberately without a model worker lease/fence. */
export const groupAudienceContextSchema=z.object({runId:z.uuid(),taskId:z.uuid(),goal:z.string(),authEpoch:z.number().int(),policyVersion:z.string(),expiresAt:z.iso.datetime(),budget:runtimeBudgetSchema,audience:z.record(z.string(),z.unknown()),groupAudience:groupAudienceRef});
export type GroupAudienceContext=z.infer<typeof groupAudienceContextSchema>;
export type WaitingGroupAuthority={context:GroupAudienceContext;requestId:string;workerId:string;requestFence:number};
export const leaseSchema=z.object({schemaVersion:z.literal(1),runId:z.uuid(),fence:z.number().int().positive(),workerId:z.string(),taskId:z.uuid(),goal:z.string(),authEpoch:z.number().int(),policyVersion:z.string(),expiresAt:z.iso.datetime(),maxTurns:z.number().int(),maxTools:z.number().int(),maxActiveMs:z.number().int(),remainingActiveMs:z.number().int(),budget:runtimeBudgetSchema,audience:z.record(z.string(),z.unknown()),groupAudience:groupAudienceRef.optional(),nativeCaseAudience:groupAudienceRef.optional(),personaSnapshot:personaSnapshotRef.optional()}).strict().refine(value=>!(value.groupAudience&&value.nativeCaseAudience),'MULTIPLE_GROUP_AUDIENCES');
