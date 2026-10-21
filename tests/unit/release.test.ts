import {releaseReasons} from '../../scripts/verify-release.js';
it('T127 missing reports, empty mandatory test arrays, blocked and mock live results cannot release',()=>{
 expect(releaseReasons(null,'ENTERPRISE_DWS')).toEqual(['INVALID_OR_MISSING_VERIFICATION_REPORT']);
 const report={profile:'ENTERPRISE_DWS',codeCommit:'a'.repeat(40),requiredTests:[],defects:[],requirementsComplete:true,versionsLocked:true,restoreDrillPassed:true,secretsScanPassed:true,coveragePassed:true,mutationPassed:true,modelEvalPassed:true,redTeamPassed:true,loadSoakPassed:true,dwsCoreVerified:false,enabledCapabilities:[]};
 const reasons=releaseReasons(report,'ENTERPRISE_DWS');expect(reasons).toContain('BASELINE_TESTS_MISSING_OR_DUPLICATED');expect(reasons).toContain('T001:NOT_RUN');expect(reasons).toContain('DWS_CORE_NOT_LIVE_VERIFIED');expect(reasons).toContain('dws.todo:MISSING_CAPABILITY');
 const tests=Array.from({length:130},(_,i)=>({testId:`T${String(i+1).padStart(3,'0')}`,status:i===70?'BLOCKED_EXTERNAL':'PASS',environment:'E2E_MOCK',evidenceRefs:['synthetic-fixture']}));expect(releaseReasons({...report,requiredTests:tests},'ENTERPRISE_DWS')).toContain('T071:BLOCKED_EXTERNAL');expect(releaseReasons({...report,requiredTests:tests},'ENTERPRISE_DWS')).toContain('T082:LIVE_EVIDENCE_REQUIRED');
});
