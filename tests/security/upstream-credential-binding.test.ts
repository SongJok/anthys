import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Gateway, canonical} from '../../packages/gateway/src/index.js';
import type {RuntimeStore} from '../../packages/runtime/src/store.js';
import {hash} from '../../packages/storage/src/crypto.js';
import {companyContractHash} from '../../packages/company/src/contracts.js';
import {companyCodeBindingHash} from '../../packages/company/src/code.js';
import {configureCompanyCode} from '../../packages/company/src/configuration.js';

const endpoint='https://code.example/mcp',origin='https://code.example';
const reviewedToken='synthetic-t081-reviewed-token-0123456789',foreignToken='synthetic-t081-foreign-service-token-0123456789';
const server={name:'synthetic-company-scoped-proxy',version:'1.0.0'};
interface Seen{url:string;method:string;authorization:string|null;rpc:string}
interface Upstream{seen:Seen[];fetcher:typeof fetch}

/** A synthetic upstream that records every request the connector makes. It
 * answers the MCP handshake and can also refuse, redirect or impersonate. */
function upstream(mode:'ok'|'unauthorized'|'redirect'|'foreign-server'='ok'):Upstream{
 const seen:Seen[]=[];
 const fetcher:typeof fetch=async(input,init)=>{
  const url=String(input instanceof Request?input.url:input);
  const body=init?.body?JSON.parse(init.body as string) as {id:string|number;method:string;params:{protocolVersion?:string}}:undefined;
  const rpc=body?.method??'GET';
  seen.push({url,method:(init?.method??'GET').toUpperCase(),authorization:new Headers(init?.headers).get('authorization'),rpc});
  if(mode==='unauthorized')return new Response(JSON.stringify({error:'invalid_token'}),{status:401,headers:{'content-type':'application/json','www-authenticate':'Bearer resource_metadata="https://code.example/.well-known/oauth-protected-resource", scope="company.code.read"'}});
  if(mode==='redirect')return new Response(null,{status:302,headers:{location:'https://other-service.example/mcp'}});
  if(rpc==='notifications/initialized')return new Response(null,{status:202});
  const result=rpc==='initialize'?{protocolVersion:body!.params.protocolVersion,capabilities:{tools:{}},serverInfo:mode==='foreign-server'?{name:'synthetic-other-proxy',version:'1.0.0'}:server}:rpc==='tools/list'?{tools:[{name:'chat',inputSchema:{type:'object',properties:{message:{type:'string'}},required:['message'],additionalProperties:false}}]}:null;
  if(!result)throw Error('SYNTHETIC_UNEXPECTED_RPC');
  return new Response(JSON.stringify({jsonrpc:'2.0',id:body!.id,result}),{headers:{'content-type':'application/json'}});
 };
 return{seen,fetcher};
}

let directory:string,tokenFile:string,configFile:string,gateway:Gateway;
beforeEach(async()=>{
 directory=await mkdtemp(join(tmpdir(),'oa-t081-'));tokenFile=join(directory,'token');configFile=join(directory,'code.json');
 gateway=new Gateway({} as RuntimeStore);
});
afterEach(async()=>{if(directory)await rm(directory,{recursive:true,force:true});});

async function writeConfiguration(overrides:Record<string,unknown>={},token=reviewedToken){
 await writeFile(tokenFile,token,{mode:0o600});
 const config={schemaVersion:1,connectorId:'synthetic-t081-code',transport:'STREAMABLE_HTTP',server,endpoint,allowedOrigin:origin,contractHash:companyContractHash,reviewed:true,readOnlyReviewRef:'SYNTHETIC_T081_READ_ONLY_REVIEW',actorResourceReviewRef:'SYNTHETIC_T081_ACTOR_RESOURCE_REVIEW',auth:{mode:'API_KEY',tokenFile},timeoutMs:1000,maxConcurrent:2,...overrides};
 await writeFile(configFile,JSON.stringify(config),{mode:0o600});
 return config;
}
/** The host approval that the formal profile carries: it names the reviewed
 * endpoint, the connector identity and the reviewed credential together. */
const approvalFor=(config:Record<string,unknown>,token:string)=>[{id:'company.code.read',version:'1.0.0',bindingHash:companyCodeBindingHash('company.code.read',String(config['connectorId']),hash(canonical({config,credentialHash:hash(token)})))}];
const registered=()=>gateway.describeCapability('company.code.read','1.0.0');

it('T081 refuses a credential issued for another service and never sends it upstream',async()=>{
 const config=await writeConfiguration(),approved=approvalFor(config,reviewedToken);
 // The operator repoints the reviewed configuration at a credential that was
 // issued for a different service or audience.
 await writeFile(tokenFile,foreignToken,{mode:0o600});
 const up=upstream();
 const connection=await configureCompanyCode(gateway,{COMPANY_MCP_CONFIG_FILE:configFile},up.fetcher,approved);
 expect(connection.enabled).toBe(false);
 expect(registered()).toBeNull();
 expect(up.seen).toEqual([]);
 await connection.close();
});

it('T081 refuses the reviewed credential under another service identity',async()=>{
 const config=await writeConfiguration(),approved=approvalFor(config,reviewedToken);
 const other=await writeConfiguration({connectorId:'synthetic-other-service'});
 expect(other['connectorId']).not.toBe(config['connectorId']);
 const up=upstream();
 const connection=await configureCompanyCode(gateway,{COMPANY_MCP_CONFIG_FILE:configFile},up.fetcher,approved);
 expect(connection.enabled).toBe(false);
 expect(registered()).toBeNull();
 expect(up.seen).toEqual([]);
 await connection.close();
});

it('T081 refuses an unreviewed OAuth configuration instead of authenticating another way',async()=>{
 await writeConfiguration({auth:{mode:'OAUTH',tokenFile}});
 const up=upstream();
 await expect(configureCompanyCode(gateway,{COMPANY_MCP_CONFIG_FILE:configFile},up.fetcher)).rejects.toThrow();
 expect(up.seen).toEqual([]);
 expect(registered()).toBeNull();
});

it('T081 sends exactly the reviewed credential and refuses a server that is not the reviewed one',async()=>{
 const config=await writeConfiguration(),up=upstream();
 const connection=await configureCompanyCode(gateway,{COMPANY_MCP_CONFIG_FILE:configFile},up.fetcher,approvalFor(config,reviewedToken));
 try{
  expect(connection.enabled).toBe(true);
  expect(registered()).toMatchObject({id:'company.code.read',version:'1.0.0',provider:'MCP'});
  expect(up.seen.length).toBeGreaterThan(0);
  for(const request of up.seen)expect(request.authorization).toBe('Bearer '+reviewedToken);
 }finally{await connection.close();}
 const foreign=upstream('foreign-server');
 await expect(configureCompanyCode(gateway,{COMPANY_MCP_CONFIG_FILE:configFile},foreign.fetcher,approvalFor(config,reviewedToken))).rejects.toThrow('COMPANY_CONNECTION_UNAVAILABLE');
 expect(foreign.seen.length).toBeGreaterThan(0);
 for(const request of foreign.seen)expect(request.authorization).toBe('Bearer '+reviewedToken);
});

it('T081 treats an upstream authentication refusal as terminal without discovery, registration or a second credential',async()=>{
 const config=await writeConfiguration(),up=upstream('unauthorized');
 let failure:unknown;
 try{await configureCompanyCode(gateway,{COMPANY_MCP_CONFIG_FILE:configFile},up.fetcher,approvalFor(config,reviewedToken));}catch(error){failure=error;}
 expect(failure).toBeInstanceOf(Error);
 expect((failure as Error).message).toBe('COMPANY_CONNECTION_UNAVAILABLE');
 expect((failure as Error).message).not.toContain(reviewedToken);
 expect(registered()).toBeNull();
 // One reviewed request, no OAuth discovery, no client registration and no
 // second credential: the refusal ends the connection.
 expect(up.seen).toHaveLength(1);
 expect(up.seen[0]).toMatchObject({url:endpoint,method:'POST',rpc:'initialize',authorization:'Bearer '+reviewedToken});
 expect(up.seen.some(request=>request.method==='GET')).toBe(false);
 expect(up.seen.some(request=>request.url.includes('oauth-protected-resource')||request.url.includes('.well-known')||request.url.includes('register'))).toBe(false);
});

it('T081 never carries the credential to a redirect target of another service',async()=>{
 const config=await writeConfiguration(),up=upstream('redirect');
 await expect(configureCompanyCode(gateway,{COMPANY_MCP_CONFIG_FILE:configFile},up.fetcher,approvalFor(config,reviewedToken))).rejects.toThrow('COMPANY_CONNECTION_UNAVAILABLE');
 expect(registered()).toBeNull();
 expect(up.seen.every(request=>request.url===endpoint)).toBe(true);
 expect(up.seen.every(request=>request.authorization==='Bearer '+reviewedToken)).toBe(true);
});
