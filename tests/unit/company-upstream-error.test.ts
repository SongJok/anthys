import {randomUUID} from 'node:crypto';
import {classifyUpstreamError,upstreamErrorBody,upstreamErrorFrom,upstreamErrorResult,CompanyUpstreamError} from '../../packages/company/src/upstream-error.js';
import {companyContractHash} from '../../packages/company/src/contracts.js';
import {companyLogsContractHash} from '../../packages/company/src/log-contracts.js';
import {companyDataContractHash} from '../../packages/company/src/data-contracts.js';
const binding=()=>({contractHash:companyContractHash,nonce:randomUUID(),tenantId:randomUUID(),actorId:randomUUID(),scopeId:randomUUID()});
const envelope=(b:ReturnType<typeof binding>,kind:'MISSING_SCOPES'|'RESOURCE_ACCESS_DENIED'|'APPLICATION_UNAVAILABLE',requiredScopes?:string[])=>({...b,kind,...(requiredScopes?{requiredScopes}:{})});
const text=(value:unknown)=>({content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value)}]});
it('T026 component: an upstream refusal is classified only when it is bound to this exact call',()=>{
 const b=binding();
 expect(classifyUpstreamError(envelope(b,'MISSING_SCOPES',['scope.a','scope.b']),b)).toEqual({kind:'MISSING_SCOPES',requiredScopes:['scope.a','scope.b']});
 expect(classifyUpstreamError(envelope(b,'RESOURCE_ACCESS_DENIED'),b)).toEqual({kind:'RESOURCE_ACCESS_DENIED'});
 expect(classifyUpstreamError(envelope(b,'APPLICATION_UNAVAILABLE'),b)).toEqual({kind:'APPLICATION_UNAVAILABLE'});
 for(const field of ['contractHash','nonce','tenantId','actorId','scopeId'] as const){
  const other=binding(),foreign={...b,[field]:field==='contractHash'?'0'.repeat(64):other[field]};
  expect(classifyUpstreamError(envelope(foreign,'MISSING_SCOPES',['scope.a']),b),field).toEqual({kind:'UNKNOWN'});
 }
 // A different contract hash is a different upstream contract, not this one.
 expect(classifyUpstreamError({...envelope(b,'MISSING_SCOPES',['scope.a']),contractHash:companyLogsContractHash},b)).toEqual({kind:'UNKNOWN'});
 expect(classifyUpstreamError({...envelope(b,'MISSING_SCOPES',['scope.a']),contractHash:companyDataContractHash},b)).toEqual({kind:'UNKNOWN'});
});
it('T026 component: only the scopes the upstream named are reported, deduplicated and bounded',()=>{
 const b=binding();
 expect(classifyUpstreamError(envelope(b,'MISSING_SCOPES',['scope.b','scope.a','scope.b']),b)).toEqual({kind:'MISSING_SCOPES',requiredScopes:['scope.b','scope.a']});
 expect(classifyUpstreamError(envelope(b,'MISSING_SCOPES'),b)).toEqual({kind:'MISSING_SCOPES',requiredScopes:[]});
 expect(classifyUpstreamError(envelope(b,'MISSING_SCOPES',['scope.'.repeat(200)]),b)).toEqual({kind:'UNKNOWN'});
 expect(classifyUpstreamError({...envelope(b,'MISSING_SCOPES',['scope.a']),kind:'SOMETHING_ELSE'},b)).toEqual({kind:'UNKNOWN'});
});
it('T026 component: a missing scope refusal becomes a permission request for exactly the named scopes',()=>{
 const b=binding(),error=upstreamErrorFrom(text(envelope(b,'MISSING_SCOPES',['scope.read','scope.write'])),b);
 expect(error).toBeInstanceOf(CompanyUpstreamError);
 expect(error.code).toBe('COMPANY_UPSTREAM_MISSING_SCOPES');
 expect(upstreamErrorResult(error)).toEqual({status:'NEEDS_AUTH',evidenceIds:[],completeness:'UNKNOWN',remediation:{kind:'UPSTREAM_MISSING_SCOPES',requiredScopes:['scope.read','scope.write']}});
});
it('T026 component: a refusal that names no scope never becomes a permission request',()=>{
 const b=binding(),error=upstreamErrorFrom(text(envelope(b,'MISSING_SCOPES')),b);
 expect(upstreamErrorResult(error)).toEqual({status:'DENIED',evidenceIds:[],completeness:'UNKNOWN',remediation:{kind:'UPSTREAM_MISSING_SCOPES_UNKNOWN'}});
 expect(upstreamErrorResult(error)?.remediation?.requiredScopes).toBeUndefined();
});
it('T027 component: an upstream resource denial and an unavailable application stay distinct refusals',()=>{
 const b=binding();
 expect(upstreamErrorResult(upstreamErrorFrom(text(envelope(b,'RESOURCE_ACCESS_DENIED')),b))).toEqual({status:'DENIED',evidenceIds:[],completeness:'UNKNOWN',remediation:{kind:'UPSTREAM_RESOURCE_ACCESS_DENIED'}});
 expect(upstreamErrorResult(upstreamErrorFrom(text(envelope(b,'APPLICATION_UNAVAILABLE')),b))).toEqual({status:'PERMANENT_ERROR',evidenceIds:[],completeness:'UNKNOWN',remediation:{kind:'UPSTREAM_APPLICATION_UNAVAILABLE'}});
 expect(upstreamErrorResult(upstreamErrorFrom(text(envelope(b,'APPLICATION_UNAVAILABLE')),b))?.remediation?.requiredScopes).toBeUndefined();
});
it('T027 component: prose, oversized, multi-block and unbound refusals are never parsed into a classification',()=>{
 const b=binding();
 for(const reply of [text('SYNTHETIC_PROVIDER_DENIED_PRIVATE_SENTINEL'),text(''),{content:[{type:'text',text:JSON.stringify(envelope(b,'MISSING_SCOPES',['scope.a']))},{type:'text',text:'extra'}]},{content:[{type:'image',data:'x'}]},{content:[{type:'text',text:'x'.repeat(96001)}]}]){
  expect(upstreamErrorBody(reply as {content:{type:string;text?:string}[]}),JSON.stringify(reply).slice(0,80)).toBeNull();
  const result=upstreamErrorResult(upstreamErrorFrom(reply as {content:{type:string;text?:string}[]},b));
  expect(result).toEqual({status:'DENIED',evidenceIds:[],completeness:'UNKNOWN',remediation:{kind:'UPSTREAM_ERROR_UNKNOWN'}});
  expect(result?.status).not.toBe('NEEDS_AUTH');
 }
});
it('T027 component: an unbound refusal bound to another nonce is not trusted even when it names scopes',()=>{
 const b=binding(),foreign={...envelope(b,'MISSING_SCOPES',['scope.a']),nonce:randomUUID()};
 const result=upstreamErrorResult(upstreamErrorFrom(text(foreign),b));
 expect(result).toEqual({status:'DENIED',evidenceIds:[],completeness:'UNKNOWN',remediation:{kind:'UPSTREAM_ERROR_UNKNOWN'}});
});
it('T027 component: a failure that is not an upstream refusal keeps its own classification',()=>{
 expect(upstreamErrorResult(new Error('SYNTHETIC_TRANSPORT'))).toBeNull();
 expect(upstreamErrorResult(undefined)).toBeNull();
 expect(upstreamErrorResult({code:'COMPANY_SOURCE_ERROR'})).toBeNull();
});
