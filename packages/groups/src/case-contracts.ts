import {z} from 'zod';
import {caseDetails,caseState,caseCommand} from './case-model.js';
const positive=z.number().int().positive().safe();
const completion=z.object({method:z.enum(['UNVERIFIED','OWNER_REPORTED','ADMIN_CONFIRMED']),actorId:z.uuid(),statement:z.string().min(1).max(2000)}).strict().nullable();
export const payloadSchema=caseDetails.extend({state:caseState,ownerId:z.uuid().nullable(),createdBy:z.uuid(),blockedReason:z.string().nullable(),completion}).strict();
export const caseResultSchema=payloadSchema.extend({id:z.uuid(),version:positive,contractVersion:positive,updatedAt:z.iso.datetime({offset:true}),sources:z.array(z.object({id:z.uuid(),kind:z.enum(['MENTION','CARD']),source_event_id:z.uuid().nullable(),submitted_by:z.uuid(),created_at:z.iso.datetime({offset:true})}).strict())}).strict();
export const createCaseInput=z.object({contractVersion:positive,details:caseDetails,source:z.discriminatedUnion('kind',[
 z.object({kind:z.literal('CARD'),shareWithGroup:z.literal(true)}).strict(),
 z.object({kind:z.literal('MENTION'),taskId:z.uuid()}).strict(),
])}).strict();
export const updateCaseInput=z.object({contractVersion:positive,expectedVersion:positive,command:caseCommand}).strict();
export const caseListInput=z.object({from:z.iso.datetime({offset:true}),until:z.iso.datetime({offset:true}),cursor:z.uuid().optional(),limit:z.coerce.number().int().min(1).max(200).default(50)}).strict().refine(q=>Date.parse(q.from)<Date.parse(q.until)&&Date.parse(q.until)-Date.parse(q.from)<=31*86400000);

