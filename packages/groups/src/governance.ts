import {z} from 'zod';
import type pg from 'pg';
export const groupGovernanceSchema=z.discriminatedUnion('mode',[
 z.object({mode:z.literal('NO_DELEGATION'),allowed:z.literal(true)}).strict(),
 z.object({mode:z.literal('DENIED'),allowed:z.literal(false)}).strict(),
 z.object({mode:z.literal('CONTRACT'),allowed:z.boolean(),administratorId:z.uuid(),id:z.uuid(),version:z.number().int().positive().safe(),hash:z.string().regex(/^[a-f0-9]{64}$/),deadline:z.iso.datetime({offset:true}),currency:z.enum(['CNY','USD']),maxAmountMinor:z.number().int().nonnegative().safe()}).strict()
]);
export async function groupGovernance(c:pg.PoolClient,groupId:string){return groupGovernanceSchema.parse((await c.query('SELECT public.oa_group_contract_runtime($1) value',[groupId])).rows[0].value);}
