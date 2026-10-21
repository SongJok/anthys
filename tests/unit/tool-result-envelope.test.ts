import {toolResultSchema,blocked,type ToolResult} from '../../packages/contracts/src/index.js';

const base={status:'PARTIAL' as const,data:{rows:[{id:'synthetic-row'}]},evidenceIds:['synthetic-evidence'],completeness:'TRUNCATED' as const};
it('preserves opaque pagination and explicit source coverage without upgrading a partial result',()=>{
 const result={...base,nextCursor:'opaque:%2Fpage-2==',coverage:{from:'2026-10-16T00:00:00Z',to:'2026-10-17T00:00:00Z',source:'synthetic-reviewed-log-service',gaps:['one shard unavailable']}};
 expect(toolResultSchema.parse(result)).toEqual(result);expect(result.status).toBe('PARTIAL');expect(result.completeness).toBe('TRUNCATED');
});
it('retains a retry delay and remediation action reference without turning UNKNOWN into a safe retry',()=>{
 const result={...blocked('UNKNOWN','RECONCILIATION_REQUIRED'),retryAfterMs:1200,remediation:{kind:'RECONCILIATION_REQUIRED',requiredScopes:['synthetic.scope'],actionId:'synthetic-action-reference'}};
 expect(toolResultSchema.parse(result)).toEqual(result);expect(toolResultSchema.parse({...result,retryAfterMs:0}).status).toBe('UNKNOWN');
});
it('supports coverage with an open bound and preserves a typed data projection',()=>{
 const typed:ToolResult<{rows:{id:string}[]}>=base;expect(toolResultSchema.parse({...typed,coverage:{source:'synthetic-source',gaps:[]}}).coverage).toEqual({source:'synthetic-source',gaps:[]});
});
it.each([-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'1000',null])('rejects invalid retry delay %s',retryAfterMs=>{expect(toolResultSchema.safeParse({...base,retryAfterMs}).success).toBe(false);});
it.each([null,{}, {source:'s'}, {source:1,gaps:[]}, {source:'s',gaps:'none'}, {source:'s',gaps:[1]}, {source:'s',gaps:[],from:1}, {source:'s',gaps:[],to:null}, {source:'s',gaps:[],verified:true}])('rejects malformed coverage %#',coverage=>{expect(toolResultSchema.safeParse({...base,coverage}).success).toBe(false);});
it.each([42,null,{}])('rejects non-string pagination %#',nextCursor=>{expect(toolResultSchema.safeParse({...base,nextCursor}).success).toBe(false);});
it('rejects nested authority claims and invalid remediation references',()=>{
 for(const remediation of [{kind:'AUTH',actionId:42},{kind:'AUTH',actionId:null},{kind:'AUTH',actionId:'id',approved:true}])expect(toolResultSchema.safeParse({...base,remediation}).success).toBe(false);
 expect(toolResultSchema.safeParse({...base,approved:true}).success).toBe(false);
});
it('preserves the existing minimal blocked and verified response shapes',()=>{
 const denial=blocked('DENIED','RESOURCE_DENIED');expect(toolResultSchema.parse(denial)).toEqual(denial);
 const verified={...base,status:'OK',completeness:'COMPLETE',verification:{state:'VERIFIED',method:'SYNTHETIC_READ_BACK'},externalRequestId:'synthetic-request',externalResourceId:'synthetic-resource'};expect(toolResultSchema.parse(verified)).toEqual(verified);
});
