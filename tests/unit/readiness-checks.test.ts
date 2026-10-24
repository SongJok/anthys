import {socketIsolation,brokerCredentialLeaks,endpointFailures,heartbeatHealthy,migrationAgreement,overallStatus,type Check} from '../../scripts/readiness-checks.js';
const mount=(target:string)=>({target,source:'/host/path'});
const view=(mounts:string[],envNames:string[]=[])=>({mounts:mounts.map(mount),envNames});
const check=(id:string,result:Check['result']):Check=>({id,result,detail:'',evidence:{}});
it('passes socket isolation only when the broker is the sole socket owner',()=>{
 const brokerOnly=socketIsolation({api:view([]),worker:view([]),postgres:view([]),'sandbox-broker':view(['/var/run/docker.sock'])});
 expect(brokerOnly).toEqual({isolated:true,owners:['sandbox-broker'],mounts:{api:[],worker:[],postgres:[],'sandbox-broker':['/var/run/docker.sock']}});
 const shared=socketIsolation({api:view(['/var/run/docker.sock']),'sandbox-broker':view(['/var/run/docker.sock'])});
 expect(shared.isolated).toBe(false);expect(shared.owners).toEqual(['api','sandbox-broker']);
 const none=socketIsolation({api:view([]),'sandbox-broker':view([])});
 expect(none.isolated).toBe(false);expect(none.owners).toEqual([]);
 expect(socketIsolation({api:null,'sandbox-broker':view([],[])})).toEqual({isolated:false,owners:[],mounts:{'sandbox-broker':[]}});
});
it('names any broker secret mount or environment variable that carries a provider credential',()=>{
 expect(brokerCredentialLeaks(['ANTHYS_DATABASE_URL','ANTHYS_MASTER_KEY','SANDBOX_BROKER_AUTH_TOKEN'],['PATH','HOME','ANTHYS_BROKER_PUBLIC_KEY'])).toEqual([]);
 expect(brokerCredentialLeaks(['dingtalk-app-secret'],['GLM_API_KEY','COMPANY_MCP_TOKEN','DWS_ACCESS_TOKEN'])).toEqual(['dingtalk-app-secret','GLM_API_KEY','COMPANY_MCP_TOKEN','DWS_ACCESS_TOKEN']);
 expect(brokerCredentialLeaks([],['ANTHYS_DATABASE_URL'])).toEqual([]);
});
it('treats a transport error or any status other than 200 as a failed endpoint',()=>{
 expect(endpointFailures({api_live:{status:200},api_ready:{status:200},broker_ready:{status:200}})).toEqual([]);
 expect(endpointFailures({api_live:{status:200},api_ready:{status:503},broker_ready:{error:'BROKER_PROBE_FAILED'}})).toEqual(['api_ready','broker_ready']);
});
it('requires the live heartbeat to be fresh while both the stale and missing controls stay stale',()=>{
 expect(heartbeatHealthy({live:true,stale:false,missing:false})).toBe(true);
 expect(heartbeatHealthy({live:true,stale:true,missing:false})).toBe(false);
 expect(heartbeatHealthy({live:true,stale:false,missing:true})).toBe(false);
 expect(heartbeatHealthy({live:false,stale:false,missing:false})).toBe(false);
 expect(heartbeatHealthy({error:'MODULE_NOT_FOUND'})).toBe(false);
 expect(heartbeatHealthy({})).toBe(false);
});
it('accepts the migration contract only when both images and the database agree exactly',()=>{
 const contract={count:116,last:'0116_sandbox_broker'};
 expect(migrationAgreement(contract,contract,116,'0116_sandbox_broker')).toBe(true);
 expect(migrationAgreement(contract,contract,115,'0116_sandbox_broker')).toBe(false);
 expect(migrationAgreement(contract,{...contract,count:115},116,'0116_sandbox_broker')).toBe(false);
 expect(migrationAgreement(contract,contract,116,'0115_previous')).toBe(false);
 expect(migrationAgreement(contract,contract,null,null)).toBe(false);
 expect(migrationAgreement(null,contract,116,'0116_sandbox_broker')).toBe(false);
 expect(migrationAgreement(contract,null,116,'0116_sandbox_broker')).toBe(false);
});
it('reports an overall PASS only when every individual check passed',()=>{
 expect(overallStatus([check('a','PASS'),check('b','PASS')])).toBe('PASS');
 expect(overallStatus([check('a','PASS'),check('b','FAIL')])).toBe('FAIL');
 expect(overallStatus([check('a','PASS'),check('b','ABSENT')])).toBe('FAIL');
 expect(overallStatus([])).toBe('PASS');
});
