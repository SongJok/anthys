import {createHash} from 'node:crypto';
import {z} from 'zod';
import requiredMigrations from './required-migrations.json' with {type:'json'};
const digest=z.string().regex(/^[a-f0-9]{64}$/),parsed=z.object({schemaVersion:z.literal(1),compatibility:z.literal('EXACT_SET'),lastMigration:z.string(),contractHash:digest,migrations:z.array(z.object({name:z.string().regex(/^\d{3}_[a-z0-9_]+\.sql$/),hash:digest}).strict()).min(1).max(999)}).strict().safeParse(requiredMigrations);
if(!parsed.success)throw Error('REQUIRED_SCHEMA_CONTRACT_INVALID');
export const requiredSchema=parsed.data;
if(requiredSchema.migrations.some((m,i)=>Number(m.name.slice(0,3))!==i+1)||requiredSchema.migrations.at(-1)!.name!==requiredSchema.lastMigration||createHash('sha256').update(requiredSchema.migrations.map(m=>m.name+'\0'+m.hash+'\0').join('')).digest('hex')!==requiredSchema.contractHash)throw Error('REQUIRED_SCHEMA_CONTRACT_INVALID');
export function matchesRequiredSchema(rows:readonly {name:string;hash:string}[]):boolean{if(rows.length!==requiredSchema.migrations.length)return false;const observed=new Map(rows.map(row=>[row.name,row.hash]));return observed.size===rows.length&&requiredSchema.migrations.every(m=>observed.get(m.name)===m.hash);}
