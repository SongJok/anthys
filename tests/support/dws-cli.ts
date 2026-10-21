import {mkdtemp,readFile,writeFile,chmod,realpath,mkdir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {canonical} from '../../packages/gateway/src/index.js';
import {hash} from '../../packages/storage/src/crypto.js';
import {DwsRunner} from '../../packages/dws/src/runner.js';
import type {DwsState,DwsSubject} from '../../packages/dws/src/contracts.js';
export const dwsCredentialCanary='SYNTHETIC_DWS_CREDENTIAL_0123456789';
export async function dwsFixture(options:{documents?:boolean;groups?:boolean}={}){const root=await realpath(await mkdtemp(join(tmpdir(),'oa-dws-fixture-'))),binary=join(root,'dws-fixture.mjs'),control=join(root,'control.json'),telemetry=join(root,'telemetry.jsonl'),workspace=join(root,'workspaces'),schema=JSON.parse(await readFile('config/dws/contact-me.schema.json','utf8')),docSchema=JSON.parse(await readFile('config/dws/doc-fetch.schema.json','utf8')),groupSchema=JSON.parse(await readFile('config/dws/chat-members-list.schema.json','utf8')),groupInfoSchema=JSON.parse(await readFile('config/dws/chat-conversation-info.schema.json','utf8'));
 await mkdir(workspace,{mode:0o700});await writeFile(control,JSON.stringify({mode:'normal'}));
 const script=`#!${process.execPath}
import ${JSON.stringify(pathToFileURL(resolve('scripts/test-network-guard.mjs')).href)};
import {readFile,writeFile,appendFile,stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const args=process.argv.slice(2),control=JSON.parse(await readFile(${JSON.stringify(control)},'utf8')),root=process.env.HOME,registry=JSON.parse(await readFile(process.env.DWS_CONFIG_DIR+'/profiles.json','utf8')),profile=registry.profiles[0],key=process.env.DWS_KEYCHAIN_DIR+'/dws-cli/auth-token.enc',token=JSON.parse(await readFile(key,'utf8'));
if(Reflect.get(globalThis,Symbol.for('anthys.testNetworkGuard'))!==true)throw Error('CHILD_NETWORK_GUARD_MISSING');
if(Object.keys(process.env).some(k=>/^(AIDER_AI_|GLM_|DINGTALK_|DATABASE_|APP_MASTER_KEY|NODE_OPTIONS)/.test(k)))throw Error('UNEXPECTED_INHERITED_SECRET_ENV');
const event=async(extra={})=>appendFile(${JSON.stringify(telemetry)},JSON.stringify({args,root,pid:process.pid,parent:process.ppid,corp:profile.corpId,user:profile.userId,rootMode:(await stat(root)).mode&511,fileMode:(await stat(key)).mode&511,tokenMatches:token.token===${JSON.stringify(dwsCredentialCanary)}+'_'+profile.userId,...extra})+'\\n');
await event({phase:'START'});const finish=data=>process.stdout.write(JSON.stringify(data));
if(args[0]==='version')process.stdout.write('Version:        '+(control.mode==='version'?'v9.9.9':'v1.0.61')+'\\nEdition: open\\n');
else if(args[0]==='schema'){const schema=args[2]==='chat +conversation-info'?${JSON.stringify(groupInfoSchema)}:args[2]==='chat +chat-members-list'?${JSON.stringify(groupSchema)}:args[2]==='doc +fetch'?${JSON.stringify(docSchema)}:${JSON.stringify(schema)};if(control.mode==='schema')schema.risk='high';finish(schema);}
else if(args[0]==='profile')finish({success:true,profiles:control.mode==='profiles'?[{profile:profile.corpId+':'+profile.userId,corpId:profile.corpId,userId:profile.userId},{profile:'other:other',corpId:'other',userId:'other'}]:[{profile:profile.corpId+':'+profile.userId,corpId:profile.corpId,userId:profile.userId,isCurrent:false,isOrgCurrent:false}]});
else if(args[0]==='auth'){await event({phase:'VERIFY'});if(control.mode==='verifyHang')await new Promise(resolve=>setTimeout(resolve,1000));finish({success:true,authenticated:true,token_valid:true,corp_id:profile.corpId,user_id:control.mode==='wrongAuth'?'other':profile.userId});}
else if(args[0]==='chat'){
 if(args[1]==='+conversation-info'){
  if(args.length!==10||args[2]!=='--group'||args[5]!==profile.corpId+':'+profile.userId||token.userId!==profile.userId||token.corpId!==profile.corpId)throw Error('EXACT_GROUP_INFO_PROFILE_NOT_SELECTED');
  const group=control.groups?.[args[3]];await event({phase:'GROUP_INFO',group:args[3]});
  const reads=(await readFile(${JSON.stringify(telemetry)},'utf8')).split('\\n').filter(Boolean).map(line=>JSON.parse(line)).filter(e=>e.phase==='GROUP_INFO'&&e.group===args[3]).length;
  if(!group||!group.allowedUsers?.includes(profile.userId)){process.stderr.write(JSON.stringify({error:{category:'api',reason:'group_permission_denied',message:token.token,retryable:false}}));process.exitCode=1;}
  else finish(reads>1&&group.infoAfter?group.infoAfter:group.info);
 }else{
 if(args[1]!=='+chat-members-list'||args[2]!=='--conversation-id'||args[4]!=='--member-types'||args[5]!=='user,bot'||args[6]!=='--page-limit'||args[7]!=='50'||args[9]!==profile.corpId+':'+profile.userId||token.userId!==profile.userId||token.corpId!==profile.corpId)throw Error('EXACT_GROUP_PROFILE_NOT_SELECTED');
 const group=control.groups?.[args[3]];await event({phase:'GROUP_READ',group:args[3]});
 if(group?.delayMs)await new Promise(resolve=>setTimeout(resolve,group.delayMs));
 if(!group||!group.allowedUsers?.includes(profile.userId)){process.stderr.write(JSON.stringify({error:{category:'api',reason:'group_permission_denied',message:token.token,retryable:false}}));process.exitCode=1;}
 else{token.revision++;await writeFile(key,JSON.stringify(token),{mode:384});finish(group.reply);}
}
}
else if(args[0]==='doc'){
 if(args[1]!=='+fetch'||args[9]!==profile.corpId+':'+profile.userId||token.userId!==profile.userId||token.corpId!==profile.corpId)throw Error('EXACT_PROFILE_NOT_SELECTED');
 const document=control.documents?.[args[3]];await event({phase:'DOC_READ',node:args[3],metadataReadable:document?.metadataReadable===true});
 const reads=(await readFile(${JSON.stringify(telemetry)},'utf8')).split('\\n').filter(Boolean).map(line=>JSON.parse(line)).filter(e=>e.phase==='DOC_READ'&&e.node===args[3]).length;
 if(document?.delayMs)await new Promise(resolve=>setTimeout(resolve,document.delayMs));
 if(document?.delayUntil)await new Promise(resolve=>setTimeout(resolve,Math.max(0,document.delayUntil-Date.now())));
 if(!document||!document.allowedUsers?.includes(profile.userId)||document.revokeAfterReads&&reads>document.revokeAfterReads){process.stderr.write(JSON.stringify({error:{category:'api',reason:'document_permission_denied',message:token.token,retryable:false}}));process.exitCode=1;}
 else{token.revision++;await writeFile(key,JSON.stringify(token),{mode:384});finish({contractVersion:'doc.content.v1',status:document.outerPartial?'partial_success':'success',complete:!document.outerPartial,target:{canonicalId:args[3],product:'doc'},content:{data:{nodeId:document.responseNodeId??args[3],resourceType:document.resourceType??'adoc',revision:document.revision,markdown:document.text,complete:document.complete??true,hasMore:document.hasMore??false,nextCursor:document.nextCursor??null},...(document.payloadError?{error:{message:token.token}}:{})}});}
}
else if(args[0]==='contact'){
 if(args[3]!==profile.corpId+':'+profile.userId||token.userId!==profile.userId||token.corpId!==profile.corpId)throw Error('EXACT_PROFILE_NOT_SELECTED');await event({phase:'READ'});
 if(control.mode==='hang'){const child=spawn(process.execPath,['--import',${JSON.stringify(pathToFileURL(resolve('scripts/test-network-guard.mjs')).href)},'-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await event({phase:'CHILD',child:child.pid});setInterval(()=>{},1000);await new Promise(()=>{});}
 if(control.mode==='killSupervisor'){process.kill(process.ppid,'SIGKILL');setInterval(()=>{},1000);await new Promise(()=>{});}
 if(control.mode==='flood'){process.stdout.write('x'.repeat(300000));}else if(control.mode==='legacyAuthError'){process.stderr.write(JSON.stringify({error:{code:2,category:'auth',reason:'auth_refresh_failed',message:token.token}}));process.exitCode=2;}
 else if(control.mode==='authError'){finish({ok:false,outcome:'failure',error:{type:'auth',message:token.token}});process.exitCode=2;}
 else if(control.mode==='confirmation'){finish({ok:false,outcome:'failure',error:{type:'auth',subtype:'confirmation_required',message:token.token}});process.exitCode=3;}
 else if(control.mode==='nonzeroSuccess'){finish({ok:true,outcome:'success',data:{userId:profile.userId}});process.exitCode=2;}
 else if(control.mode==='businessError')finish({ok:false,outcome:'failure',error:{type:'api',message:token.token}});
 else if(control.mode==='partial')finish({ok:false,outcome:'partial_failure',data:{userId:profile.userId,name:'Unverified partial'}});
 else{if(control.mode==='network'){let blocked=false;try{await fetch('https://undeclared.example.invalid');}catch(error){blocked=error.message==='TEST_NETWORK_UNDECLARED_DESTINATION';if(!blocked)throw Error('WRONG_NETWORK_FAILURE');}await event({phase:'NETWORK',blocked});if(!blocked)throw Error('NETWORK_GUARD_FAILED');}if(control.mode==='slow')await new Promise(resolve=>setTimeout(resolve,200));token.revision++;await writeFile(key,JSON.stringify(token),{mode:384});finish({ok:true,outcome:'success',identity:'user',data:{userId:control.mode==='wrongResult'?'other':profile.userId,name:control.name??'Fixture '+profile.userId,dept:'测试部门',org:'测试企业',mobile:'SYNTHETIC_PRIVATE_PHONE',email:'SYNTHETIC_PRIVATE_EMAIL'}});}
}else throw Error('UNREVIEWED_COMMAND');
`;
 await writeFile(binary,script,{mode:0o500});await chmod(binary,0o500);const binaryHash=createHash('sha256').update(script).digest('hex'),runner=new DwsRunner({mode:'SYNTHETIC_TEST',binaryFile:binary,binaryHash,schemaHash:hash(canonical(schema)),...(options.documents?{documentSchemaHash:hash(canonical(docSchema))}:{}),...(options.groups?{groupMembersSchemaHash:hash(canonical(groupSchema)),groupInfoSchemaHash:hash(canonical(groupInfoSchema))}:{}),root:workspace,timeoutMs:3000,maxOutputBytes:128000});
 const state=(subject:DwsSubject):DwsState=>({schemaVersion:1,files:{'config/profiles.json':Buffer.from(JSON.stringify({version:2,profiles:[{name:subject.corpId+':'+subject.userId,corpId:subject.corpId,userId:subject.userId}]})).toString('base64'),'keychain/dws-cli/dek':Buffer.alloc(32,6).toString('base64'),'keychain/dws-cli/auth-token.enc':Buffer.from(JSON.stringify({corpId:subject.corpId,userId:subject.userId,token:dwsCredentialCanary+'_'+subject.userId,revision:0})).toString('base64')}});
 return {root,binary,workspace,runner,state,control,telemetry,mode:async(mode:string,extra:Record<string,unknown>={})=>writeFile(control,JSON.stringify({mode,...extra})),events:async()=>{try{return (await readFile(telemetry,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as {args:string[];root:string;pid:number;parent:number;phase:string;user:string;corp:string;node?:string;group?:string;metadataReadable?:boolean;rootMode:number;fileMode:number;child?:number;blocked?:boolean;tokenMatches:boolean});}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}},close:()=>rm(root,{recursive:true,force:true})};
}
