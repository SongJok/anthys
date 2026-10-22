import {mkdtemp,writeFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {configureCompanyData,companyDataConfigurationSchema} from '../../packages/company/src/data-configuration.js';
import {companyDataContractHash,companyDataToolSchemaHash} from '../../packages/company/src/data-contracts.js';
import {companyDataBindingHash} from '../../packages/company/src/data.js';
import {loadDataTemplates} from '../../packages/company/src/data-templates.js';
import {canonical} from '../../packages/gateway/src/index.js';
import {hash} from '../../packages/storage/src/crypto.js';
const templateDirectory=fileURLToPath(new URL('../../config/data-templates',import.meta.url));
it('absent explicit data configuration or absent formal data approval performs no credential or network operation',async()=>{
 let count=0;const fetcher:typeof fetch=async()=>{count++;throw Error('UNEXPECTED_NETWORK');},gateway={} as Parameters<typeof configureCompanyData>[0];
 expect((await configureCompanyData(gateway,{COMPANY_DATA_MCP_CONFIG_FILE:''},fetcher)).enabled).toBe(false);
 expect((await configureCompanyData(gateway,{AIDER_AI_DD_CHAT_MCP:'https://company.example',COMPANY_DATA_MCP_CONFIG_FILE:'/not-a-data-config'},fetcher,[])).enabled).toBe(false);
 expect((await configureCompanyData(gateway,{COMPANY_DATA_MCP_CONFIG_FILE:'/must-not-be-read'},fetcher,[])).enabled).toBe(false);expect(count).toBe(0);
});
it.each(['EXACT','WRONG_BINDING','WRONG_VERSION','WRONG_ID','WRONG_SERVER'] as const)('native HTTP SDK initialization requires the independently reviewed data binding: %s',async mode=>{
 const templates=await loadDataTemplates(templateDirectory),dir=await mkdtemp(join(tmpdir(),'oa-data-config-')),tokenPath=join(dir,'token'),path=join(dir,'config.json'),token='synthetic-data-token-012345678901234567890';let connection:Awaited<ReturnType<typeof configureCompanyData>>|undefined;
 try{
  await writeFile(tokenPath,token,{mode:0o600});const config=companyDataConfigurationSchema.parse({schemaVersion:1,connectorId:'synthetic-data',transport:'STREAMABLE_HTTP',server:{name:'synthetic-data-proxy',version:'1.0.0'},endpoint:'https://data.example/mcp',allowedOrigin:'https://data.example',contractHash:companyDataContractHash,tool:{name:'chat',inputSchemaHash:companyDataToolSchemaHash},templateMode:'INLINE_DEFINITION',templatesDirectory:templateDirectory,templateRegistryHash:templates.registryHash,reviewed:true,readOnlyReviewRef:'synthetic-data-readonly',actorResourceReviewRef:'synthetic-data-actor-resource',rowScopeReviewRef:'synthetic-data-row-scope',templateRegistryReviewRef:'synthetic-data-registry',auth:{mode:'API_KEY',tokenFile:tokenPath},timeoutMs:1000,maxConcurrent:2});await writeFile(path,JSON.stringify(config),{mode:0o600});
  const binding=companyDataBindingHash(config.connectorId,hash(canonical({config,credentialHash:hash(token)})),config.tool.name,config.tool.inputSchemaHash,templates.registryHash),approved=[{id:mode==='WRONG_ID'?'company.logs.query':'company.data.query',version:mode==='WRONG_VERSION'?'2.0.0':'1.0.0',bindingHash:mode==='WRONG_BINDING'?hash('wrong'):binding}],requests:string[]=[],caps:string[]=[];
  const fetcher:typeof fetch=async(input,init)=>{requests.push(String(input));expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+token);expect(init?.redirect).toBe('error');const body=JSON.parse(init!.body as string);if(body.method==='notifications/initialized')return new Response(null,{status:202});expect(body.method).toBe('initialize');return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{protocolVersion:body.params.protocolVersion,capabilities:{tools:{}},serverInfo:mode==='WRONG_SERVER'?{name:'other',version:'9'}:config.server}}),{headers:{'content-type':'application/json'}});};
  const gateway={register:(c:{id:string})=>caps.push(c.id)} as unknown as Parameters<typeof configureCompanyData>[0];
  if(mode==='WRONG_SERVER')await expect(configureCompanyData(gateway,{COMPANY_DATA_MCP_CONFIG_FILE:path},fetcher,approved)).rejects.toMatchObject({code:'COMPANY_DATA_CONNECTION_UNAVAILABLE'});
  else {connection=await configureCompanyData(gateway,{COMPANY_DATA_MCP_CONFIG_FILE:path},fetcher,approved);expect(connection.enabled).toBe(mode==='EXACT');expect(connection.client!==undefined).toBe(mode==='EXACT');}
  expect(caps).toEqual(mode==='EXACT'?['company.data.query']:[]);expect(requests.length).toBe(mode==='EXACT'||mode==='WRONG_SERVER'?2:0);
 }finally{await connection?.close();await rm(dir,{recursive:true,force:true});}
});
it('malformed private configuration, unsafe token permissions, changed tool schema and changed template registry fail closed',async()=>{
 const templates=await loadDataTemplates(templateDirectory),dir=await mkdtemp(join(tmpdir(),'oa-data-invalid-')),path=join(dir,'config.json'),tokenPath=join(dir,'token');try{
  const gateway={} as Parameters<typeof configureCompanyData>[0],fetcher:typeof fetch=async()=>{throw Error('UNEXPECTED_NETWORK');},base={schemaVersion:1,connectorId:'synthetic-data',transport:'STREAMABLE_HTTP',server:{name:'synthetic-data-proxy',version:'1.0.0'},endpoint:'https://data.example/mcp',allowedOrigin:'https://data.example',contractHash:companyDataContractHash,tool:{name:'chat',inputSchemaHash:companyDataToolSchemaHash},templateMode:'KEY_ONLY',templatesDirectory:templateDirectory,templateRegistryHash:templates.registryHash,reviewed:true,readOnlyReviewRef:'synthetic-data-readonly',actorResourceReviewRef:'synthetic-data-actor-resource',rowScopeReviewRef:'synthetic-data-row-scope',templateRegistryReviewRef:'synthetic-data-registry',auth:{mode:'API_KEY',tokenFile:tokenPath},timeoutMs:1000,maxConcurrent:2};
  await writeFile(path,'{"SYNTHETIC_PRIVATE_DATA_CONFIG": malformed',{mode:0o600});await expect(configureCompanyData(gateway,{COMPANY_DATA_MCP_CONFIG_FILE:path},fetcher)).rejects.toMatchObject({code:'COMPANY_DATA_CONFIGURATION_INVALID'});
  await writeFile(tokenPath,'synthetic-data-token-012345678901234567890',{mode:0o600});await chmod(tokenPath,0o644);await writeFile(path,JSON.stringify(base));await expect(configureCompanyData(gateway,{COMPANY_DATA_MCP_CONFIG_FILE:path},fetcher)).rejects.toMatchObject({code:'COMPANY_DATA_CONFIGURATION_INVALID'});
  await chmod(tokenPath,0o600);await writeFile(path,JSON.stringify({...base,tool:{name:'chat',inputSchemaHash:'0'.repeat(64)}}));await expect(configureCompanyData(gateway,{COMPANY_DATA_MCP_CONFIG_FILE:path},fetcher)).rejects.toMatchObject({code:'COMPANY_DATA_CONFIGURATION_INVALID'});
  await writeFile(path,JSON.stringify({...base,templateRegistryHash:'0'.repeat(64)}));await expect(configureCompanyData(gateway,{COMPANY_DATA_MCP_CONFIG_FILE:path},fetcher)).rejects.toMatchObject({code:'COMPANY_DATA_CONFIGURATION_INVALID'});
  await writeFile(path,JSON.stringify({...base,endpoint:'http://data.example/mcp'}));await expect(configureCompanyData(gateway,{COMPANY_DATA_MCP_CONFIG_FILE:path},fetcher)).rejects.toMatchObject({code:'COMPANY_DATA_CONFIGURATION_INVALID'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
