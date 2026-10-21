import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {z} from 'zod';

const maxStringBytes=4096,maxInputBytes=8192;
type Scalar=string|boolean|null|number;
/** Already-parsed, bounded JSON data only; never invoke user accessors/toJSON.
 * Reject Proxy before reflective operations, and all arrays/custom prototypes. */
function snapshot(raw:unknown):Record<string,Scalar>{
 if(raw===null||typeof raw!=='object'||types.isProxy(raw)||Array.isArray(raw))throw Error('WATCH_DATA_INVALID');
 const prototype=Object.getPrototypeOf(raw);if(prototype!==Object.prototype&&prototype!==null)throw Error('WATCH_DATA_INVALID');
 const keys=Reflect.ownKeys(raw);if(keys.length>6)throw Error('WATCH_DATA_INVALID');
 const result=Object.create(null) as Record<string,Scalar>;
 for(const key of keys){
  if(typeof key!=='string'||key.length>32)throw Error('WATCH_DATA_INVALID');
  const descriptor=Object.getOwnPropertyDescriptor(raw,key);
  if(!descriptor||!descriptor.enumerable||!('value' in descriptor))throw Error('WATCH_DATA_INVALID');
  const value:unknown=descriptor.value;
  if(value!==null&&typeof value!=='boolean'&&typeof value!=='string'&&!(typeof value==='number'&&Number.isSafeInteger(value)))throw Error('WATCH_DATA_INVALID');
  if(typeof value==='string'&&Buffer.byteLength(value,'utf8')>maxStringBytes)throw Error('WATCH_DATA_INVALID');
  result[key]=typeof value==='number'&&Object.is(value,-0)?0:value as Scalar;
 }
 if(Buffer.byteLength(JSON.stringify(result),'utf8')>maxInputBytes)throw Error('WATCH_DATA_INVALID');return result;
}
function data(code:string){return z.unknown().transform((raw,ctx)=>{try{return snapshot(raw);}catch{ctx.addIssue({code:'custom',message:code});return z.NEVER;}});}
const scalar=z.union([z.string().refine(value=>Buffer.byteLength(value,'utf8')<=maxStringBytes),z.boolean(),z.null(),z.number().int().safe()]);
const instant=z.string().max(35).pipe(z.iso.datetime({offset:true})).refine(value=>Number.isFinite(Date.parse(value))).transform(value=>new Date(value).toISOString());
const sourceHash=z.string().regex(/^[a-f0-9]{64}$/);
const predicateShape=z.object({schemaVersion:z.literal(1),operator:z.enum(['EQ','NE','GT','GTE','LT','LTE']),expected:scalar}).strict();
export const watchPredicateSchema=data('WATCH_PREDICATE_INVALID').pipe(predicateShape).transform(value=>Object.freeze(value));
export type WatchPredicate=z.infer<typeof watchPredicateSchema>;
const common={schemaVersion:z.literal(1),asOf:instant,sourceHash};
const observationShape=z.discriminatedUnion('state',[
 z.object({...common,state:z.literal('OBSERVED'),value:scalar}).strict(),
 z.object({...common,state:z.literal('UNKNOWN'),reason:z.enum(['NOT_OBSERVED','INCOMPLETE_RESULT'])}).strict(),
 z.object({...common,state:z.literal('UNAVAILABLE'),reason:z.enum(['SOURCE_UNAVAILABLE','SOURCE_ERROR'])}).strict(),
]);
export const watchObservationSchema=data('WATCH_OBSERVATION_INVALID').pipe(observationShape).transform(value=>Object.freeze(value));
export type WatchObservation=z.infer<typeof watchObservationSchema>;
export type WatchPredicateReason='COMPARISON_MATCH'|'COMPARISON_NO_MATCH'|'OBSERVATION_UNKNOWN'|'OBSERVATION_UNAVAILABLE'|'TYPE_MISMATCH'|'ORDER_REQUIRES_SAFE_INTEGERS';
export type WatchPredicateResult=Readonly<{state:'MATCH'|'NO_MATCH'|'UNKNOWN';predicateHash:string;valueHash:string|null;sourceHash:string;asOf:string;reason:WatchPredicateReason}>;
const digest=(domain:string,value:unknown)=>createHash('sha256').update(domain+'\0'+JSON.stringify(value)).digest('hex');
const kind=(value:Scalar)=>value===null?'null':typeof value;
/** Deterministic scalar comparison, not source verification or authorization.
 * asOf is caller-supplied observation time; no freshness/clock/I/O checks occur.
 * No absent value is converted to observed null, zero, false or empty string. */
export function evaluateWatchPredicate(rawPredicate:unknown,rawObservation:unknown):WatchPredicateResult{
 const checkedPredicate=watchPredicateSchema.safeParse(rawPredicate);if(!checkedPredicate.success)throw Error('WATCH_PREDICATE_INVALID');
 const checkedObservation=watchObservationSchema.safeParse(rawObservation);if(!checkedObservation.success)throw Error('WATCH_OBSERVATION_INVALID');
 const predicate=checkedPredicate.data,observation=checkedObservation.data;
 const summary={predicateHash:digest('open_aider.watch.predicate.v1',predicate),valueHash:observation.state==='OBSERVED'?digest('open_aider.watch.value.v1',observation.value):null,sourceHash:observation.sourceHash,asOf:observation.asOf};
 const result=(state:WatchPredicateResult['state'],reason:WatchPredicateReason):WatchPredicateResult=>Object.freeze({state,...summary,reason});
 if(observation.state!=='OBSERVED')return result('UNKNOWN',observation.state==='UNKNOWN'?'OBSERVATION_UNKNOWN':'OBSERVATION_UNAVAILABLE');
 const actual=observation.value,expected=predicate.expected;
 if(kind(actual)!==kind(expected))return result('UNKNOWN','TYPE_MISMATCH');
 let match:boolean;
 if(predicate.operator==='EQ'||predicate.operator==='NE')match=predicate.operator==='EQ'?actual===expected:actual!==expected;
 else{
  if(typeof actual!=='number'||typeof expected!=='number')return result('UNKNOWN','ORDER_REQUIRES_SAFE_INTEGERS');
  switch(predicate.operator){case 'GT':match=actual>expected;break;case 'GTE':match=actual>=expected;break;case 'LT':match=actual<expected;break;case 'LTE':match=actual<=expected;break;}
 }
 return result(match?'MATCH':'NO_MATCH',match?'COMPARISON_MATCH':'COMPARISON_NO_MATCH');
}
