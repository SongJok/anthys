import {releaseReasons,releaseReportSchema,releaseEvidenceRefs,missingReleaseEvidence} from '../../scripts/verify-release.js';
type ReleaseReport=ReturnType<typeof releaseReportSchema.parse>;
it('T127 missing reports, empty mandatory test arrays, blocked and mock live results cannot release',()=>{
 expect(releaseReasons(null,'ENTERPRISE_DWS')).toEqual(['INVALID_OR_MISSING_VERIFICATION_REPORT']);
 const report={profile:'ENTERPRISE_DWS',codeCommit:'a'.repeat(40),requiredTests:[],defects:[],requirementsComplete:true,versionsLocked:true,restoreDrillPassed:true,secretsScanPassed:true,coveragePassed:true,mutationPassed:true,modelEvalPassed:true,redTeamPassed:true,loadSoakPassed:true,dwsCoreVerified:false,enabledCapabilities:[]};
 const reasons=releaseReasons(report,'ENTERPRISE_DWS');expect(reasons).toContain('BASELINE_TESTS_MISSING_OR_DUPLICATED');expect(reasons).toContain('T001:NOT_RUN');expect(reasons).toContain('DWS_CORE_NOT_LIVE_VERIFIED');expect(reasons).toContain('dws.todo:MISSING_CAPABILITY');
 const tests=Array.from({length:130},(_,i)=>({testId:`T${String(i+1).padStart(3,'0')}`,status:i===70?'BLOCKED_EXTERNAL':'PASS',environment:'E2E_MOCK',evidenceRefs:['synthetic-fixture']}));expect(releaseReasons({...report,requiredTests:tests},'ENTERPRISE_DWS')).toContain('T071:BLOCKED_EXTERNAL');expect(releaseReasons({...report,requiredTests:tests},'ENTERPRISE_DWS')).toContain('T082:LIVE_EVIDENCE_REQUIRED');
});
const liveTests=new Set(['T020','T069','T070','T071','T082','T096']);
const baseCapabilities=['glm.native','dingtalk.messages','company.code','company.logs','data.templates','search','artifacts','schedules'],dwsCapabilities=['dws.identity','dws.contact','dws.todo','dws.calendar','dws.doc','dws.drive','dws.aitable','dingtalk.cards'];
const releaseReport=(profile:'BASE'|'ENTERPRISE_DWS'):ReleaseReport=>({profile,codeCommit:'a'.repeat(40),requiredTests:Array.from({length:130},(_,i)=>{const id=`T${String(i+1).padStart(3,'0')}`;return {testId:id,status:'PASS',environment:liveTests.has(id)?'LIVE_ENTERPRISE':'LOCAL',evidenceRefs:['reports/enterprise-verification.json']};}),defects:[],requirementsComplete:true,versionsLocked:true,restoreDrillPassed:true,secretsScanPassed:true,coveragePassed:true,mutationPassed:true,modelEvalPassed:true,redTeamPassed:true,loadSoakPassed:true,dwsCoreVerified:profile==='ENTERPRISE_DWS',enabledCapabilities:[...baseCapabilities,...(profile==='ENTERPRISE_DWS'?dwsCapabilities:[])].map(id=>({id,isExternal:true,verificationState:'LIVE_VERIFIED',evidenceRefs:['reports/enterprise-verification.json']}))});
const reasonsFor=(mutate:(report:ReleaseReport)=>void,profile:'BASE'|'ENTERPRISE_DWS'='ENTERPRISE_DWS')=>{const r=releaseReport(profile);mutate(r);return releaseReasons(r,profile);};
it('a complete enterprise report with live evidence releases with no reason, while the base profile needs no DWS evidence',()=>{
 expect(releaseReasons(releaseReport('ENTERPRISE_DWS'),'ENTERPRISE_DWS')).toEqual([]);
 expect(releaseReasons(releaseReport('BASE'),'BASE')).toEqual([]);
 const baseAsEnterprise=releaseReasons(releaseReport('BASE'),'ENTERPRISE_DWS');expect(baseAsEnterprise).toContain('DWS_CORE_NOT_LIVE_VERIFIED');expect(baseAsEnterprise).toContain('dws.todo:MISSING_CAPABILITY');
 const enterpriseAsBase=releaseReasons(releaseReport('ENTERPRISE_DWS'),'BASE');expect(enterpriseAsBase).toEqual(['PROFILE_MISMATCH']);
});
it('every mandatory declaration and every blocking defect fails release on its own',()=>{
 for(const key of ['requirementsComplete','versionsLocked','restoreDrillPassed','secretsScanPassed','coveragePassed','mutationPassed','modelEvalPassed','redTeamPassed','loadSoakPassed'] as const)expect(reasonsFor(r=>{(r as unknown as Record<string,boolean>)[key]=false;})).toEqual([key]);
 expect(reasonsFor(r=>{r.defects=[{severity:'SEV0',description:'data loss'}];})).toEqual(['BLOCKING_DEFECTS']);
 expect(reasonsFor(r=>{r.defects=[{severity:'SEV1',description:'security'}];})).toEqual(['BLOCKING_DEFECTS']);
 expect(reasonsFor(r=>{r.defects=[{severity:'SEV2',description:'minor'},{severity:'SEV3',description:'cosmetic'}];})).toEqual([]);
});
it('an external capability must be live verified, an internal one system verified, and none may be silently dropped',()=>{
 expect(reasonsFor(r=>{r.enabledCapabilities[0]={...r.enabledCapabilities[0]!,verificationState:'SYSTEM_VERIFIED'};})).toEqual(['glm.native:UNVERIFIED']);
 expect(reasonsFor(r=>{r.enabledCapabilities[0]={...r.enabledCapabilities[0]!,isExternal:false};})).toEqual(['glm.native:UNVERIFIED']);
 expect(reasonsFor(r=>{r.enabledCapabilities=r.enabledCapabilities.filter(c=>c.id!=='company.logs');})).toEqual(['company.logs:MISSING_CAPABILITY']);
 expect(reasonsFor(r=>{r.enabledCapabilities=r.enabledCapabilities.filter(c=>c.id!=='dws.drive');})).toEqual(['dws.drive:MISSING_CAPABILITY']);
 expect(reasonsFor(r=>{for(const c of r.enabledCapabilities)c.verificationState=c.isExternal?'LIVE_VERIFIED':'SYSTEM_VERIFIED';})).toEqual([]);
});
it('the six external-asset rows need a real live environment, not a mock, fixture or any other label',()=>{
 for(const id of liveTests){
  expect(reasonsFor(r=>{const t=r.requiredTests.find(t=>t.testId===id)!;t.environment='E2E_MOCK';})).toEqual([`${id}:LIVE_EVIDENCE_REQUIRED`]);
  expect(reasonsFor(r=>{const t=r.requiredTests.find(t=>t.testId===id)!;t.environment='LIVE_FIXTURE';})).toEqual([`${id}:LIVE_EVIDENCE_REQUIRED`]);
  expect(reasonsFor(r=>{const t=r.requiredTests.find(t=>t.testId===id)!;t.environment='LOCAL_E2E';})).toEqual([`${id}:LIVE_EVIDENCE_REQUIRED`]);
 }
 expect(reasonsFor(r=>{const t=r.requiredTests.find(t=>t.testId==='T001')!;t.environment='LOCAL_E2E';})).toEqual([]);
});
it('the report schema is fail-closed on unknown top-level keys, malformed ids, empty evidence and unknown enums',()=>{
 const valid=releaseReport('ENTERPRISE_DWS'),invalid=(patch:Record<string,unknown>)=>releaseReasons({...valid,...patch},'ENTERPRISE_DWS');
 for(const patch of [{unexpected:true},{profile:'STAGING'},{codeCommit:'abc'},{defects:[{severity:'SEV4',description:'unknown'}]}])expect(invalid(patch)).toEqual(['INVALID_OR_MISSING_VERIFICATION_REPORT']);
 for(const tester of [(t:ReleaseReport['requiredTests'][number])=>({...t,testId:'T1'}),(t:ReleaseReport['requiredTests'][number])=>({...t,evidenceRefs:[]}),(t:ReleaseReport['requiredTests'][number])=>({...t,status:'DONE'})])expect(invalid({requiredTests:valid.requiredTests.map((t,i)=>i===0?tester(t):t)})).toEqual(['INVALID_OR_MISSING_VERIFICATION_REPORT']);
 expect(invalid({enabledCapabilities:valid.enabledCapabilities.map((c,i)=>i===0?{...c,verificationState:'TRUSTED'}:c)})).toEqual(['INVALID_OR_MISSING_VERIFICATION_REPORT']);
 expect(invalid({requiredTests:valid.requiredTests.slice(0,129)})).toEqual(['BASELINE_TESTS_MISSING_OR_DUPLICATED','T130:NOT_RUN']);
});
it('the CLI evidence check inspects every reference and fails closed one reason per missing file',async()=>{
 const report=releaseReport('ENTERPRISE_DWS'),seen:string[]=[],exists=(allow:(path:string)=>boolean)=>async(path:string)=>{seen.push(path);return allow(path);};
 expect(releaseEvidenceRefs(report)).toHaveLength(146);
 expect(await missingReleaseEvidence(report,exists(()=>true))).toEqual([]);
 expect(seen).toHaveLength(146);
 report.requiredTests[0]!.evidenceRefs=['reports/absent-test.json'];report.enabledCapabilities[0]!.evidenceRefs=['reports/absent-capability.json'];
 expect(await missingReleaseEvidence(report,exists(path=>!path.startsWith('reports/absent')))).toEqual(['EVIDENCE_MISSING:reports/absent-test.json','EVIDENCE_MISSING:reports/absent-capability.json']);
 expect(await missingReleaseEvidence(report,exists(()=>false))).toHaveLength(146);
});
