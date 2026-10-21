import {mkdtemp,writeFile,readFile,readdir,chmod,lstat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer,type Server as HttpsServer} from 'node:https';
import {getCACertificates,setDefaultCACertificates} from 'node:tls';
import type {Duplex} from 'node:stream';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {CallToolRequestSchema,ListToolsRequestSchema,isInitializeRequest} from '@modelcontextprotocol/sdk/types.js';
import {agentChatInputSchemaHash} from '../../packages/company/src/agent-chat.js';

const endpoint='https://127.0.0.1:52339/mcp';
const defaultSchema={type:'object' as const,properties:{message:{type:'string'}},required:['message'],additionalProperties:false};
let trustInUse=false;
export type SyntheticAgentHttpsOptions={token?:string;serverName?:string;serverVersion?:string;inputSchema?:Record<string,unknown>;text?:string;delayMs?:number};
export type SyntheticAgentHttps={endpoint:string;token:string;schema:Record<string,unknown>;server:{name:string;version:string};readonly methods:readonly string[];callCount:()=>number;close:()=>Promise<void>};
const fail=(code:string)=>new Error('SYNTHETIC_HTTPS_'+code);
function ssl(root:string,args:string[]){
  const result=spawnSync('/usr/bin/openssl',args,{cwd:root,env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe'],timeout:5000,maxBuffer:128*1024});
  // Never expose OpenSSL output: private filenames/key material are test-only.
  if(result.status!==0||result.error)throw fail('CERTIFICATE_GENERATION_FAILED');
}
async function credentials(){
  const root=await mkdtemp(join(tmpdir(),'oa-agent-https-'));await chmod(root,0o700);
  try{
    await writeFile(join(root,'ca.conf'),'[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca_ext\n[dn]\nCN=SYNTHETIC LOCAL MCP CA\n[ca_ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n',{mode:0o600,flag:'wx'});
    await writeFile(join(root,'server.conf'),'[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=SYNTHETIC LOCAL MCP SERVER\n[server_ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\nauthorityKeyIdentifier=keyid,issuer\n',{mode:0o600,flag:'wx'});
    const previousMask=process.umask(0o077);
    try{
      ssl(root,['genrsa','-out','ca.key','2048']);
      ssl(root,['req','-new','-x509','-sha256','-days','1','-key','ca.key','-out','ca.crt','-config','ca.conf']);
      ssl(root,['genrsa','-out','server.key','2048']);
      ssl(root,['req','-new','-sha256','-key','server.key','-out','server.csr','-config','server.conf']);
      ssl(root,['x509','-req','-in','server.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-days','1','-sha256','-out','server.crt','-extfile','server.conf','-extensions','server_ext']);
    }finally{process.umask(previousMask);}
    for(const file of await readdir(root)){
      const path=join(root,file),info=await lstat(path);
      if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o777)!==0o600||info.uid!==process.getuid?.())throw fail('CERTIFICATE_FILE_PERMISSIONS');
    }
    const [key,cert,ca]=await Promise.all([readFile(join(root,'server.key')),readFile(join(root,'server.crt')),readFile(join(root,'ca.crt'),'utf8')]);
    return {root,key,cert:Buffer.concat([cert,Buffer.from('\n'+ca)]),ca};
  }catch(error){await rm(root,{recursive:true,force:true});throw error;}
}
async function body(req:IncomingMessage):Promise<unknown>{
  const parts:Buffer[]=[];let size=0;
  for await(const chunk of req){const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=data.length;if(size>80_000)throw fail('REQUEST_LIMIT');parts.push(data);}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw fail('REQUEST_JSON');}
}
function wait(milliseconds:number,signal:AbortSignal):Promise<void>{
  return new Promise((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);reject(fail('HANDLER_ABORTED'));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},milliseconds);
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  });
}

/** Real loopback HTTPS + actual SDK server. No fetch replacement, business credentials or external destination. */
export async function startSyntheticAgentHttps(options:SyntheticAgentHttpsOptions={}):Promise<SyntheticAgentHttps>{
  if(Reflect.get(globalThis,Symbol.for('open_aider.testNetworkGuard'))!==true)throw fail('NETWORK_GUARD_REQUIRED');
  if(process.env['NODE_TLS_REJECT_UNAUTHORIZED']==='0')throw fail('TLS_VERIFICATION_DISABLED');
  if(trustInUse)throw fail('CONCURRENT_TRUST_CHANGE');
  const schema=structuredClone(options.inputSchema??defaultSchema);agentChatInputSchemaHash(schema);
  if(schema['type']!=='object')throw fail('TOOL_SCHEMA_INVALID');
  const token=options.token??'SYNTHETIC_HTTPS_'+randomBytes(24).toString('base64url');
  const server={name:options.serverName??'synthetic-native-https-agent',version:options.serverVersion??'1.0.0'};
  const text=options.text??'SYNTHETIC native HTTPS reply; no enterprise fact verified',delay=options.delayMs??0;
  if(token.length<16||token.length>8192||/[\u0000-\u0020\u007f]/.test(token)||!server.name||server.name.length>256||!server.version||server.version.length>128||!text.startsWith('SYNTHETIC')||Buffer.byteLength(text)>65_536||!Number.isSafeInteger(delay)||delay<0||delay>10_000)throw fail('OPTIONS_INVALID');
  trustInUse=true;
  const previousCAs=getCACertificates('default'),controller=new AbortController(),methods:string[]=[],faults:string[]=[],sockets=new Set<Duplex>();
  const sessions=new Map<string,{server:Server;transport:StreamableHTTPServerTransport}>(),allServers=new Set<Server>(),pending=new Set<Promise<void>>();
  let files:Awaited<ReturnType<typeof credentials>>|undefined,https:HttpsServer|undefined,calls=0,closed=false,closing:Promise<void>|undefined;
  const close=()=>closing??= (async()=>{
    closed=true;controller.abort();
    try{
      await Promise.allSettled([...allServers].map(s=>s.close()));
      if(https){const done=new Promise<void>(resolve=>https!.close(()=>resolve()));https.closeAllConnections();for(const socket of sockets)socket.destroy();await done;}
      await Promise.allSettled([...pending]);
    }finally{
      try{setDefaultCACertificates(previousCAs);}finally{trustInUse=false;if(files){await rm(files.root,{recursive:true,force:true});const remaining=await lstat(files.root).then(()=>true,error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw fail('CLEANUP_FAILED');});if(remaining)throw fail('CLEANUP_FAILED');}}
    }
    if(faults.length)throw fail(faults[0]!);
  })();
  const reject=(res:ServerResponse,status:number)=>{res.writeHead(status,{'content-type':'application/json'});res.end('{"error":"SYNTHETIC_REQUEST_REJECTED"}');};
  const handler=async(req:IncomingMessage,res:ServerResponse)=>{
    if(closed||req.method!=='POST'||req.url!=='/mcp'||req.headers.host!=='127.0.0.1:52339'||req.headers.authorization!=='Bearer '+token||!req.headers['content-type']?.startsWith('application/json')){faults.push('REQUEST_TARGET_OR_HEADERS');reject(res,400);return;}
    const raw=await body(req),message=raw as {method?:unknown};
    if(!message||typeof message!=='object'||!['initialize','notifications/initialized','tools/list','tools/call','notifications/cancelled','ping'].includes(String(message.method))){faults.push('UNEXPECTED_METHOD');reject(res,400);return;}
    methods.push(String(message.method));
    const sessionId=req.headers['mcp-session-id'];
    let session=typeof sessionId==='string'?sessions.get(sessionId):undefined;
    if(!session&&sessionId===undefined&&isInitializeRequest(raw)){
      const sdk=new Server(server,{capabilities:{tools:{}}});
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID(),onsessioninitialized:id=>{sessions.set(id,{server:sdk,transport});}});
      allServers.add(sdk);
      sdk.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'chat',inputSchema:schema as {type:'object'}}]}));
      sdk.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
        const args=request.params.arguments;
        if(request.params.name!=='chat'||!args||Object.keys(args).length!==1||typeof args['message']!=='string'||!args['message'].trim()||Buffer.byteLength(args['message'])>65_536){faults.push('TOOL_ARGUMENTS');throw fail('TOOL_ARGUMENTS');}
        calls++;
        try{await wait(delay,AbortSignal.any([controller.signal,extra.signal]));}catch{if(!controller.signal.aborted&&!extra.signal.aborted){faults.push('HANDLER_FAILED');throw fail('HANDLER_FAILED');}}
        return {content:[{type:'text',text}]};
      });
      await sdk.connect(transport as Transport);session={server:sdk,transport};
    }
    if(!session){faults.push('SESSION_INVALID');reject(res,400);return;}
    await session.transport.handleRequest(req,res,raw);
  };
  try{
    files=await credentials();setDefaultCACertificates([...previousCAs,files.ca]);
    https=createServer({key:files.key,cert:files.cert,minVersion:'TLSv1.2'},(req,res)=>{
      const request=handler(req,res).catch(()=>{if(!closed&&!res.destroyed){faults.push('HTTP_HANDLER_FAILED');if(!res.headersSent)reject(res,500);else res.destroy();}});
      pending.add(request);void request.finally(()=>pending.delete(request));
    });
    https.requestTimeout=15_000;https.headersTimeout=5000;https.timeout=15_000;https.keepAliveTimeout=500;
    https.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
    await new Promise<void>((resolve,reject)=>{https!.once('error',reject);https!.listen(52339,'127.0.0.1',()=>{https!.removeListener('error',reject);resolve();});});
    return {endpoint,token,schema,server,get methods(){return Object.freeze([...methods]);},callCount:()=>calls,close};
  }catch(error){await close();if(error instanceof Error&&/^SYNTHETIC_HTTPS_[A-Z_]+$/.test(error.message))throw error;throw fail('START_FAILED');}
}
