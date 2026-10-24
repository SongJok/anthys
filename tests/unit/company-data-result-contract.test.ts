import {companyDataResultContract} from '../../packages/company/src/data-result-contract.js';
import {parseCapabilityResult} from '../../packages/contracts/src/result-contract.js';
const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',sha='a'.repeat(64),drifted='b'.repeat(64),key='payments.success_rate_daily',version='1.0.0';
// The reviewed projection emitted by company.data.query; every field below is
// the same synthetic shape the output-contract manifest test already accepts.
const projection=()=>({
 source:{scopeId:id,scopeVersion:1,sourceRevision:'synthetic-data',templateKey:key,templateVersion:version,templateHash:sha,queryId:id,watermark:'2026-10-13T16:00:00.000Z',observedAt:'2026-10-13T16:05:00.000Z',completeness:'COMPLETE',rowScopeHash:sha,classification:'CONFIDENTIAL'},
 query:{templateKey:key,templateVersion:version,start:'2026-10-12T16:00:00.000Z',end:'2026-10-13T16:00:00.000Z'},
 template:{key,version,hash:sha},
 queryId:id,
 watermark:'2026-10-13T16:00:00.000Z',
 observedAt:'2026-10-13T16:05:00.000Z',
 completeness:'COMPLETE',
 window:{start:'2026-10-12T16:00:00.000Z',end:'2026-10-13T16:00:00.000Z',interval:'[start,end)'},
 rowScope:{tenant:'TENANT_A',department:'d_pay'},
 metrics:{attempts:'5',successes:'3',successRate:'0.6',byChannel:[{channel:'app',attempts:'3',successes:'2',successRate:'0.666666666667'},{channel:'web',attempts:'2',successes:'1',successRate:'0.5'}]},
 untrustedContent:true,
 upstreamCertification:'UNVERIFIED'
});
const rawIssues=(value:unknown)=>{const parsed=companyDataResultContract.resultSchema.safeParse(value);return parsed.success?[]:parsed.error.issues.map(issue=>issue.path.join('.')+':'+issue.message);};
const issues=(data:unknown)=>rawIssues({status:'OK',evidenceIds:[],completeness:'COMPLETE',data});
const rejects=(data:unknown,expected:string)=>expect(issues(data),JSON.stringify(issues(data))).toContain(expected);
const withSource=(patch:object)=>({...projection(),source:{...projection().source,...patch}});
const withWindow=(patch:object)=>({...projection(),window:{...projection().window,...patch}});
it('accepts the reviewed projection and requires data only when the envelope claims OK',()=>{
 const envelope={status:'OK' as const,evidenceIds:[],completeness:'COMPLETE' as const,data:projection()};
 expect(parseCapabilityResult(companyDataResultContract,envelope).data).toEqual(projection());
 expect(rawIssues({status:'OK',evidenceIds:[],completeness:'COMPLETE'})).toContain('data:SUCCESS_DATA_REQUIRED');
});
it('rejects a query id that disagrees with the source receipt',()=>rejects({...projection(),queryId:other},'data.queryId:QUERY_ID_MISMATCH'));
it('rejects template identity drift against either the query or the source receipt',()=>{
 for(const patch of [{key:'payments.success_rate_weekly'},{version:'1.0.1'},{hash:drifted}])rejects({...projection(),template:{...projection().template,...patch}},'data.template:TEMPLATE_MISMATCH');
 for(const patch of [{templateKey:'payments.success_rate_weekly'},{templateVersion:'1.0.1'},{templateHash:drifted}])rejects(withSource(patch),'data.template:TEMPLATE_MISMATCH');
});
it('rejects a source receipt that disagrees with projected watermark, observation time or completeness',()=>{
 rejects(withSource({watermark:'2026-10-13T16:01:00.000Z'}),'data.source:SOURCE_RECEIPT_MISMATCH');
 rejects(withSource({observedAt:'2026-10-13T16:06:00.000Z'}),'data.source:SOURCE_RECEIPT_MISMATCH');
 rejects(withSource({completeness:'SAMPLED'}),'data.source:SOURCE_RECEIPT_MISMATCH');
});
it('rejects a window that is not exactly the queried half-open interval',()=>{
 rejects(withWindow({start:'2026-10-12T15:59:59.000Z'}),'data.window:WINDOW_MISMATCH');
 rejects(withWindow({end:'2026-10-13T15:59:59.000Z'}),'data.window:WINDOW_MISMATCH');
 expect(issues(withWindow({interval:'[start,end]'})).some(issue=>issue.startsWith('data.window.interval:'))).toBe(true);
});
it('refuses private extras and any claim of upstream certification',()=>{
 for(const value of [{...projection(),privateLeak:'must-not-escape'},{...projection(),untrustedContent:false},{...projection(),upstreamCertification:'VERIFIED'}])expect(issues(value)).not.toEqual([]);
});
