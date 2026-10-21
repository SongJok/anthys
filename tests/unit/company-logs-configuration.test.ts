import {mkdtemp,writeFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configureCompanyLogs,companyLogConfigurationSchema} from '../../packages/company/src/log-configuration.js';
import {companyLogsContractHash} from '../../packages/company/src/log-contracts.js';
import {companyLogsBindingHash} from '../../packages/company/src/logs.js';
import {companyContractHash} from '../../packages/company/src/contracts.js';
import {canonical} from '../../packages/gateway/src/index.js';
import {hash} from '../../packages/storage/src/crypto.js';
it('absent explicit log configuration or absent formal log approval performs no credential or network operation',async()=>{
 let count=0;const fetcher:typeof fetch=async()=>{count++;throw Error('UNEXPECTED_NETWORK');},gateway={} as Parameters<typeof configureCompanyLogs>[0];
 expect((await configureCompanyLogs(gateway,{AIDER_AI_DD_CHAT_MCP:'https://company.example',COMPANY_MCP_CONFIG_FILE:'/not-a-log-config'},fetcher)).enabled).toBe(false);
 expect((await configureCompanyLogs(gateway,{COMPANY_LOGS_MCP_CONFIG_FILE:'/must-not-be-read'},fetcher,[])).enabled).toBe(false);expect(count).toBe(0);
});
it.each(['EXACT','WRONG_BINDING','WRONG_VERSION','WRONG_ID','WRONG_SERVER'] as const)('native HTTP SDK initialization requires the independently reviewed log binding: %s',async mode=>{
 const dir=await mkdtemp(join(tmpdir(),'oa-logs-config-')),tokenPath=join(dir,'token'),path=join(dir,'config.json'),token='synthetic-log-token-012345678901234567890';let connection:Awaited<ReturnType<typeof configureCompanyLogs>>|undefined;
 try{
  await writeFile(tokenPath,token,{mode:0o600});const config=companyLogConfigurationSchema.parse({schemaVersion:1,connectorId:'synthetic-logs',transport:'STREAMABLE_HTTP',server:{name:'synthetic-logs-proxy',version:'1.0.0'},endpoint:'https://logs.example/mcp',allowedOrigin:'https://logs.example',contractHash:companyLogsContractHash,reviewed:true,readOnlyReviewRef:'synthetic-read-only',actorResourceReviewRef:'synthetic-actor-resource',redactionPolicyReviewRef:'synthetic-fields-redaction-egress',auth:{mode:'API_KEY',tokenFile:tokenPath},timeoutMs:1000,maxConcurrent:2});await writeFile(path,JSON.stringify(config),{mode:0o600});
  const binding=companyLogsBindingHash(config.connectorId,hash(canonical({config,credentialHash:hash(token)}))),approved=[{id:mode==='WRONG_ID'?'company.code.read':'company.logs.query',version:mode==='WRONG_VERSION'?'2.0.0':'1.0.0',bindingHash:mode==='WRONG_BINDING'?hash('wrong'):binding}],requests:string[]=[],caps:string[]=[];
  const fetcher:typeof fetch=async(input,init)=>{requests.push(String(input));expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+token);expect(init?.redirect).toBe('error');const body=JSON.parse(init!.body as string);if(body.method==='notifications/initialized')return new Response(null,{status:202});expect(body.method).toBe('initialize');return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{protocolVersion:body.params.protocolVersion,capabilities:{tools:{}},serverInfo:mode==='WRONG_SERVER'?{name:'other',version:'9'}:config.server}}),{headers:{'content-type':'application/json'}});};
  const gateway={register:(c:{id:string})=>caps.push(c.id)} as unknown as Parameters<typeof configureCompanyLogs>[0];
  if(mode==='WRONG_SERVER')await expect(configureCompanyLogs(gateway,{COMPANY_LOGS_MCP_CONFIG_FILE:path},fetcher,approved)).rejects.toMatchObject({code:'COMPANY_LOG_CONNECTION_UNAVAILABLE'});
  else {connection=await configureCompanyLogs(gateway,{COMPANY_LOGS_MCP_CONFIG_FILE:path},fetcher,approved);expect(connection.enabled).toBe(mode==='EXACT');}
  expect(caps).toEqual(mode==='EXACT'?['company.logs.query']:[]);expect(requests.length).toBe(mode==='EXACT'||mode==='WRONG_SERVER'?2:0);expect(companyContractHash).toBe('54dcabdb09e9e5fc945ccb246dfc3b6366a02669a2d14b1c89572e97c7041361');
 }finally{await connection?.close();await rm(dir,{recursive:true,force:true});}
});
it('malformed private configuration and unsafe token permissions fail with a fixed redacted error',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'oa-log-invalid-')),path=join(dir,'config.json'),tokenPath=join(dir,'token');try{
  await writeFile(path,'{"SYNTHETIC_PRIVATE_LOG_CONFIG": malformed',{mode:0o600});const gateway={} as Parameters<typeof configureCompanyLogs>[0],fetcher:typeof fetch=async()=>{throw Error('UNEXPECTED_NETWORK');};
  await expect(configureCompanyLogs(gateway,{COMPANY_LOGS_MCP_CONFIG_FILE:path},fetcher)).rejects.toMatchObject({code:'COMPANY_LOG_CONFIGURATION_INVALID'});
  await writeFile(tokenPath,'synthetic-log-token-012345678901234567890',{mode:0o600});await chmod(tokenPath,0o644);await writeFile(path,JSON.stringify({schemaVersion:1,connectorId:'synthetic-logs',transport:'STREAMABLE_HTTP',server:{name:'synthetic',version:'1'},endpoint:'https://logs.example/mcp',allowedOrigin:'https://logs.example',contractHash:companyLogsContractHash,reviewed:true,readOnlyReviewRef:'synthetic-read-only',actorResourceReviewRef:'synthetic-actor-resource',redactionPolicyReviewRef:'synthetic-redaction',auth:{mode:'API_KEY',tokenFile:tokenPath},timeoutMs:1000,maxConcurrent:2}));
  await expect(configureCompanyLogs(gateway,{COMPANY_LOGS_MCP_CONFIG_FILE:path},fetcher)).rejects.toMatchObject({code:'COMPANY_LOG_CONFIGURATION_INVALID'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
