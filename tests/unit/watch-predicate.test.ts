import {describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {evaluateWatchPredicate,watchObservationSchema,watchPredicateSchema,type WatchPredicate} from '../../packages/watches/src/predicate.js';
const sourceHash='a'.repeat(64),asOf='2026-10-20T00:00:00.000Z';
const predicate=(operator:WatchPredicate['operator']='EQ',expected:unknown=3)=>({schemaVersion:1,operator,expected});
const observed=(value:unknown=3)=>({schemaVersion:1,state:'OBSERVED',value,asOf,sourceHash});
const check=(operator:WatchPredicate['operator'],actual:unknown,expected:unknown)=>evaluateWatchPredicate(predicate(operator,expected),observed(actual));
const digest=(domain:string,json:string)=>createHash('sha256').update(domain+'\0'+json).digest('hex');
describe('pure bounded watch scalar predicate, not monitoring execution',()=>{
 it.each([
  ['EQ',3,3,'MATCH'],['EQ',2,3,'NO_MATCH'],['NE',2,3,'MATCH'],['NE',3,3,'NO_MATCH'],
  ['GT',4,3,'MATCH'],['GT',3,3,'NO_MATCH'],['GTE',3,3,'MATCH'],['GTE',2,3,'NO_MATCH'],
  ['LT',2,3,'MATCH'],['LT',3,3,'NO_MATCH'],['LTE',3,3,'MATCH'],['LTE',4,3,'NO_MATCH'],
 ] as const)('%s actual=%i expected=%i returns %s', (operator,actual,expected,state)=>{
  const result=check(operator,actual,expected);expect(result.state).toBe(state);expect(result.reason).toBe(state==='MATCH'?'COMPARISON_MATCH':'COMPARISON_NO_MATCH');expect(Object.isFrozen(result)).toBe(true);
 });
 it('uses exact string/boolean/null equality, never coercing or Unicode/case normalizing',()=>{
  for(const value of ['',false,true,null,'中文','é','é']){expect(check('EQ',value,value).state).toBe('MATCH');expect(check('NE',value,value).state).toBe('NO_MATCH');}
  for(const [a,b] of [['A','a'],['é','é'],[false,true],['','0']]){expect(check('EQ',a,b).state).toBe('NO_MATCH');expect(check('NE',a,b).state).toBe('MATCH');}
 });
 it('cross-type EQ and NE are UNKNOWN, including null/0/false/empty-string distinctions',()=>{
  for(const actual of [null,0,false,''])for(const expected of [null,0,false,''])if(actual!==expected)for(const op of ['EQ','NE'] as const){const result=check(op,actual,expected);expect(result.state).toBe('UNKNOWN');expect(result.reason).toBe('TYPE_MISMATCH');}
 });
 it('ordering requires safe integers on both sides; strings/booleans/null never become numbers',()=>{
  for(const op of ['GT','GTE','LT','LTE'] as const){
   for(const value of ['10',true,false,null])expect(check(op,value,value)).toMatchObject({state:'UNKNOWN',reason:'ORDER_REQUIRES_SAFE_INTEGERS'});
   expect(check(op,'10',10)).toMatchObject({state:'UNKNOWN',reason:'TYPE_MISMATCH'});
  }
  expect(check('GT',Number.MAX_SAFE_INTEGER,Number.MIN_SAFE_INTEGER).state).toBe('MATCH');expect(check('LT',Number.MIN_SAFE_INTEGER,Number.MAX_SAFE_INTEGER).state).toBe('MATCH');
 });
 it.each([
  ['UNKNOWN','NOT_OBSERVED','OBSERVATION_UNKNOWN'],['UNKNOWN','INCOMPLETE_RESULT','OBSERVATION_UNKNOWN'],
  ['UNAVAILABLE','SOURCE_UNAVAILABLE','OBSERVATION_UNAVAILABLE'],['UNAVAILABLE','SOURCE_ERROR','OBSERVATION_UNAVAILABLE'],
 ] as const)('%s/%s never matches or invents a value', (state,reason,resultReason)=>{
  for(const operator of ['EQ','NE','GT','GTE','LT','LTE'] as const){const result=evaluateWatchPredicate(predicate(operator,null),{schemaVersion:1,state,reason,asOf,sourceHash});expect(result).toMatchObject({state:'UNKNOWN',valueHash:null,sourceHash,asOf,reason:resultReason});expect(Object.hasOwn(result,'value')).toBe(false);}
 });
 it('missing, unavailable, null and zero remain distinct; unknown branches reject any forged value',()=>{
  expect(watchObservationSchema.safeParse({schemaVersion:1,state:'OBSERVED',asOf,sourceHash}).success).toBe(false);
  for(const state of ['UNKNOWN','UNAVAILABLE'])expect(watchObservationSchema.safeParse({schemaVersion:1,state,reason:state==='UNKNOWN'?'NOT_OBSERVED':'SOURCE_ERROR',value:null,asOf,sourceHash}).success).toBe(false);
  const nil=check('EQ',null,null),zero=check('EQ',0,0);expect(nil.valueHash).not.toBeNull();expect(nil.valueHash).not.toBe(zero.valueHash);
 });
 it('pins domain-separated canonical summaries and immutable primitive-only output',()=>{
  const p=predicate(),o=observed(),result=evaluateWatchPredicate(p,o);
  expect(result).toEqual({state:'MATCH',predicateHash:digest('anthys.watch.predicate.v1','{"schemaVersion":1,"operator":"EQ","expected":3}'),valueHash:digest('anthys.watch.value.v1','3'),sourceHash,asOf,reason:'COMPARISON_MATCH'});
  expect(evaluateWatchPredicate(Object.fromEntries(Object.entries(p).reverse()),Object.fromEntries(Object.entries(o).reverse()))).toEqual(result);
  p.expected=4;o.value=4;expect(result.valueHash).toBe(digest('anthys.watch.value.v1','3'));expect(Object.keys(result).sort()).toEqual(['asOf','predicateHash','reason','sourceHash','state','valueHash']);
  expect(Object.isFrozen(watchPredicateSchema.parse(predicate()))).toBe(true);expect(Object.isFrozen(watchObservationSchema.parse(observed()))).toBe(true);
  expect(evaluateWatchPredicate(predicate('EQ',-0),observed(-0))).toEqual(check('EQ',0,0));expect(check('EQ','3','3').valueHash).not.toBe(result.valueHash);
 });
 it('normalizes ISO offsets to UTC but does not fabricate freshness or inspect the clock',()=>{
  const clock=vi.spyOn(Date,'now').mockImplementation(()=>{throw Error('CLOCK_FORBIDDEN');});
  try{expect(evaluateWatchPredicate(predicate(),{...observed(),asOf:'2026-10-20T08:00:00+08:00'}).asOf).toBe(asOf);expect(evaluateWatchPredicate(predicate(),{...observed(),asOf:'2000-01-01T00:00:00Z'}).state).toBe('MATCH');expect(clock).not.toHaveBeenCalled();}finally{clock.mockRestore();}
 });
 it('rejects nonfinite, fractional, unsafe, BigInt, undefined, boxed, and nonscalar values without truncation',()=>{
  for(const value of [NaN,Infinity,-Infinity,1.25,Number.MAX_SAFE_INTEGER+1,Number.MIN_SAFE_INTEGER-1,1n,undefined,{},[],new Number(3),new String('x')]){
   expect(watchPredicateSchema.safeParse({...predicate(),expected:value}).success).toBe(false);expect(watchObservationSchema.safeParse({...observed(),value}).success).toBe(false);
  }
  for(const value of [Number.MIN_SAFE_INTEGER,Number.MAX_SAFE_INTEGER])expect(check('EQ',value,value).state).toBe('MATCH');
 });
 it('enforces UTF8 scalar and complete JSON byte limits, including escaped characters',()=>{
  expect(check('EQ','a'.repeat(4096),'a'.repeat(4096)).state).toBe('MATCH');expect(check('EQ','中'.repeat(1365),'中'.repeat(1365)).state).toBe('MATCH');
  for(const value of ['a'.repeat(4097),'中'.repeat(1366),'\0'.repeat(1500)]){expect(watchPredicateSchema.safeParse({...predicate(),expected:value}).success).toBe(false);expect(watchObservationSchema.safeParse({...observed(),value}).success).toBe(false);}
 });
 it('requires closed versions/operators/states/reasons, strict keys, canonical hash and real ISO dates',()=>{
  for(const patch of [{schemaVersion:2},{operator:'REGEX'},{operator:'eq'},{path:'/secret'},{expression:'process.exit()'},{expected:undefined}])expect(watchPredicateSchema.safeParse({...predicate(),...patch}).success).toBe(false);
  for(const patch of [{schemaVersion:2},{state:'VERIFIED'},{reason:'SOURCE_ERROR'},{sourceHash:'A'.repeat(64)},{sourceHash:'x'},{asOf:'2026-02-30T00:00:00Z'},{asOf:'2026-10-20'},{asOf:'2026-10-20T00:00:00'},{url:'https://example.invalid'}])expect(watchObservationSchema.safeParse({...observed(),...patch}).success).toBe(false);
  expect(watchObservationSchema.safeParse({schemaVersion:1,state:'UNKNOWN',reason:'SOURCE_ERROR',asOf,sourceHash}).success).toBe(false);
  expect(watchObservationSchema.safeParse({schemaVersion:1,state:'UNAVAILABLE',reason:'NOT_OBSERVED',asOf,sourceHash}).success).toBe(false);
 });
 it('rejects accessors and toJSON without invoking them, even nonenumerable accessors or extra keys',()=>{
  let calls=0;const getter=()=>{calls++;throw Error('UNTRUSTED_GETTER');};
  for(const key of ['expected','toJSON','extra']){const p=predicate();Object.defineProperty(p,key,{get:getter,enumerable:key!=='extra'});expect(watchPredicateSchema.safeParse(p).success).toBe(false);expect(()=>evaluateWatchPredicate(p,observed())).toThrow(/^WATCH_PREDICATE_INVALID$/);}
  const o=observed();Object.defineProperty(o,'value',{get:getter,enumerable:true});expect(watchObservationSchema.safeParse(o).success).toBe(false);expect(()=>evaluateWatchPredicate(predicate(),o)).toThrow(/^WATCH_OBSERVATION_INVALID$/);expect(calls).toBe(0);
  const p={...predicate(),toJSON:()=>{calls++;return predicate();}};expect(watchPredicateSchema.safeParse(p).success).toBe(false);expect(calls).toBe(0);
 });
 it('rejects Proxy before reflection or property traps, plus custom prototypes/classes and sparse arrays',()=>{
  let traps=0;const handler={get(){traps++;throw Error('TRAP');},ownKeys(){traps++;throw Error('TRAP');},getPrototypeOf(){traps++;throw Error('TRAP');},getOwnPropertyDescriptor(){traps++;throw Error('TRAP');}};
  expect(watchPredicateSchema.safeParse(new Proxy(predicate(),handler)).success).toBe(false);expect(watchObservationSchema.safeParse(new Proxy(observed(),handler)).success).toBe(false);expect(traps).toBe(0);
  const revoked=Proxy.revocable(predicate(),{});revoked.revoke();expect(watchPredicateSchema.safeParse(revoked.proxy).success).toBe(false);
  for(const value of [Object.assign(Object.create({inherited:true}),predicate()),new Date(),new Map(),new Set(),new Array(3),[predicate()],Object.assign([],predicate())])expect(watchPredicateSchema.safeParse(value).success).toBe(false);
  const symbol={...predicate(),[Symbol('extra')]:1};expect(watchPredicateSchema.safeParse(symbol).success).toBe(false);
  expect(watchPredicateSchema.safeParse(Object.assign(Object.create(null),predicate())).success).toBe(true);
 });
 it('rejects prototype pollution keys without changing prototypes or executing expression-like scalar text',()=>{
  const polluted=JSON.parse('{"schemaVersion":1,"operator":"EQ","expected":1,"__proto__":{"polluted":true}}');expect(watchPredicateSchema.safeParse(polluted).success).toBe(false);expect(Object.hasOwn(Object.prototype,'polluted')).toBe(false);
  const texts=['process.exit(1)','/danger.*/','https://example.invalid/x','../../private/file','$(echo secret)','<script>throw 1</script>'];for(const value of texts)expect(check('EQ',value,value).state).toBe('MATCH');
  expect(()=>evaluateWatchPredicate({...predicate(),secret:'SYNTHETIC_PRIVATE'},observed())).toThrow(/^WATCH_PREDICATE_INVALID$/);
 });
});
