import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configureCompanyCode,companyConfigurationSchema} from '../../packages/company/src/configuration.js';
import {companyCodeBindingHash} from '../../packages/company/src/code.js';
import {companyContractHash} from '../../packages/company/src/contracts.js';
import {canonical} from '../../packages/gateway/src/index.js';
import {hash} from '../../packages/storage/src/crypto.js';
it.each(['EMPTY','WRONG_ID','WRONG_VERSION','WRONG_BINDING','EXACT'] as const)('company MCP checks exact formal approval before HTTP initialization: %s',async mode=>{
 const dir=await mkdtemp(join(tmpdir(),'oa-formal-company-')),tokenPath=join(dir,'token'),path=join(dir,'config.json'),token='synthetic-local-token-01234567890123456789';
 try{
  await writeFile(tokenPath,token,{mode:0o600});const config=companyConfigurationSchema.parse({schemaVersion:1,connectorId:'synthetic-company',transport:'STREAMABLE_HTTP',server:{name:'synthetic-company',version:'1.0.0'},endpoint:'https://company.example/mcp',allowedOrigin:'https://company.example',contractHash:companyContractHash,reviewed:true,readOnlyReviewRef:'synthetic-readonly',actorResourceReviewRef:'synthetic-actor-resource',auth:{mode:'API_KEY',tokenFile:tokenPath},timeoutMs:1000,maxConcurrent:2});await writeFile(path,JSON.stringify(config));
  const binding=companyCodeBindingHash('company.code.search',config.connectorId,hash(canonical({config,credentialHash:hash(token)}))),approved=mode==='EMPTY'?[]:[{id:mode==='WRONG_ID'?'company.unknown':'company.code.search',version:mode==='WRONG_VERSION'?'9.0.0':'1.0.0',bindingHash:mode==='WRONG_BINDING'?hash('wrong'):binding}],requests:string[]=[],registered:string[]=[];
  const fetcher:typeof fetch=async(input,init)=>{requests.push(String(input));expect(mode).toBe('EXACT');expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+token);const body=JSON.parse(init!.body as string);if(body.method==='notifications/initialized')return new Response(null,{status:202});expect(body.method).toBe('initialize');return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{protocolVersion:body.params.protocolVersion,capabilities:{tools:{}},serverInfo:config.server}}),{headers:{'content-type':'application/json'}});};
  const gateway={register:(c:{id:string})=>registered.push(c.id)} as unknown as Parameters<typeof configureCompanyCode>[0],connection=await configureCompanyCode(gateway,{COMPANY_MCP_CONFIG_FILE:path},fetcher,approved);expect(connection.enabled).toBe(mode==='EXACT');expect(requests.length).toBe(mode==='EXACT'?2:0);expect(registered).toEqual(mode==='EXACT'?['company.code.search','company.code.read']:[]);await connection.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});
