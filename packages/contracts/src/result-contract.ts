import {isDeepStrictEqual} from 'node:util';
import {z,type ZodType} from 'zod';
import {toolResultSchema,type ToolResult} from './index.js';
/** Complete wire-result schema. Business data is validated without coercion. */
export function dataResultContract(data:ZodType){
 const resultSchema=toolResultSchema.extend({data:data.optional()}).superRefine((value,ctx)=>{if(value.status==='OK'&&value.data===undefined)ctx.addIssue({code:'custom',path:['data'],message:'SUCCESS_DATA_REQUIRED'});});
 return {resultSchema,outputSchema:z.toJSONSchema(resultSchema)};
}
export class CapabilityOutputError extends Error{constructor(){super('CAPABILITY_OUTPUT_INVALID');this.name='CapabilityOutputError';}}
export interface ResultContract {resultSchema:ZodType;outputSchema:Record<string,unknown>}
export function parseCapabilityResult(contract:ResultContract,value:unknown):ToolResult{
 // Parse the common envelope first; a capability cannot redefine OK/UNKNOWN or
 // add authority-bearing transport fields through its business schema.
 const envelope=toolResultSchema.safeParse(value);if(!envelope.success)throw new CapabilityOutputError();
 const result=contract.resultSchema.safeParse(envelope.data);if(!result.success)throw new CapabilityOutputError();
 // Output contracts are validators, not redactors. A stripping/coercing parser
 // must not conceal extra private fields or silently rewrite the provider data.
 if(!isDeepStrictEqual(result.data,envelope.data))throw new CapabilityOutputError();
 return envelope.data;
}
