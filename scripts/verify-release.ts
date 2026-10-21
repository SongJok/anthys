import {readFile,access} from 'node:fs/promises';
import {z} from 'zod';
export const releaseReportSchema=z.object({profile:z.enum(['BASE','ENTERPRISE_DWS']),codeCommit:z.string().regex(/^[a-f0-9]{40}$/),requiredTests:z.array(z.object({testId:z.string().regex(/^T\d{3}$/),status:z.enum(['PASS','FAIL','NOT_RUN','SKIP','BLOCKED_EXTERNAL','FLAKY']),environment:z.string(),evidenceRefs:z.array(z.string()).min(1)})),defects:z.array(z.object({severity:z.enum(['SEV0','SEV1','SEV2','SEV3']),description:z.string()})),requirementsComplete:z.boolean(),versionsLocked:z.boolean(),restoreDrillPassed:z.boolean(),secretsScanPassed:z.boolean(),coveragePassed:z.boolean(),mutationPassed:z.boolean(),modelEvalPassed:z.boolean(),redTeamPassed:z.boolean(),loadSoakPassed:z.boolean(),dwsCoreVerified:z.boolean(),enabledCapabilities:z.array(z.object({id:z.string(),isExternal:z.boolean(),verificationState:z.enum(['UNVERIFIED','SYSTEM_VERIFIED','LIVE_VERIFIED']),evidenceRefs:z.array(z.string()).min(1)}))}).strict();
export function releaseReasons(input:unknown,profile:'BASE'|'ENTERPRISE_DWS'):string[] {
 const parsed=releaseReportSchema.safeParse(input);if(!parsed.success)return ['INVALID_OR_MISSING_VERIFICATION_REPORT'];const r=parsed.data,errors:string[]=[];
 if(r.profile!==profile)errors.push('PROFILE_MISMATCH');
 const ids=r.requiredTests.map(t=>t.testId);if(ids.length!==130||new Set(ids).size!==130)errors.push('BASELINE_TESTS_MISSING_OR_DUPLICATED');
 for(let i=1;i<=130;i++){const id=`T${String(i).padStart(3,'0')}`,t=r.requiredTests.find(t=>t.testId===id);if(!t||t.status!=='PASS')errors.push(`${id}:${t?.status??'NOT_RUN'}`);}
 for(const id of ['T020','T069','T070','T071','T082','T096']) {const t=r.requiredTests.find(t=>t.testId===id);if(t && (!t.environment.startsWith('LIVE')||/MOCK|FIXTURE/i.test(t.environment)))errors.push(`${id}:LIVE_EVIDENCE_REQUIRED`);}
 for(const key of ['requirementsComplete','versionsLocked','restoreDrillPassed','secretsScanPassed','coveragePassed','mutationPassed','modelEvalPassed','redTeamPassed','loadSoakPassed'] as const)if(!r[key])errors.push(key);
 if(r.defects.some(d=>['SEV0','SEV1'].includes(d.severity)))errors.push('BLOCKING_DEFECTS');
 for(const c of r.enabledCapabilities)if(c.verificationState!==(c.isExternal?'LIVE_VERIFIED':'SYSTEM_VERIFIED'))errors.push(`${c.id}:UNVERIFIED`);
 for(const id of ['glm.native','dingtalk.messages','company.code','company.logs','data.templates','search','artifacts','schedules',...(profile==='ENTERPRISE_DWS'?['dws.identity','dws.contact','dws.todo','dws.calendar','dws.doc','dws.drive','dws.aitable','dingtalk.cards']:[])])if(!r.enabledCapabilities.some(c=>c.id===id))errors.push(`${id}:MISSING_CAPABILITY`);
 if(profile==='ENTERPRISE_DWS'&&!r.dwsCoreVerified)errors.push('DWS_CORE_NOT_LIVE_VERIFIED');return errors;
}
if(import.meta.url===`file://${process.argv[1]}`){const i=process.argv.indexOf('--profile'),profile=z.enum(['BASE','ENTERPRISE_DWS']).parse(i>=0?process.argv[i+1]:'ENTERPRISE_DWS');let raw:unknown;
 try{raw=JSON.parse(await readFile('reports/enterprise-verification.json','utf8'));}catch{raw=null;}
 const reasons=releaseReasons(raw,profile),parsed=releaseReportSchema.safeParse(raw);
 if(parsed.success)for(const ref of [...parsed.data.requiredTests.flatMap(t=>t.evidenceRefs),...parsed.data.enabledCapabilities.flatMap(c=>c.evidenceRefs)])try{await access(ref);}catch{reasons.push('EVIDENCE_MISSING:'+ref);}
 console.log(JSON.stringify({profile,status:reasons.length?'FAIL':'PASS',reasons},null,2));if(reasons.length)process.exitCode=1;
}
