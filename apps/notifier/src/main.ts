import {registerNativeArtifacts} from '../../../packages/artifacts/src/runtime.js';
import {NativeCaseAudience} from '../../../packages/groups/src/native-audience.js';
import {configureCompanyAgent} from '../../../packages/company/src/agent-configuration.js';
import {registerGroupCaseRead} from '../../../packages/groups/src/read-capability.js';
import {GroupCases} from '../../../packages/groups/src/cases.js';
import {configureCompanyLogs} from '../../../packages/company/src/log-configuration.js';
import {initializeLifecycle,assertLifecycleScopes,assertLifecycleBinding} from '../../../packages/config/src/lifecycle.js';
import {assertOwnedTrialService} from '../../../packages/runtime/src/trial-supervision.js';
import {RunPersonas} from '../../../packages/personas/src/runtime.js';
import {GroupAudience} from '../../../packages/groups/src/audience.js';
import {configureDws} from '../../../packages/dws/src/configuration.js';
import {registerDwsCapabilities} from '../../../packages/dws/src/capabilities.js';
import {configureCompanyCode} from '../../../packages/company/src/configuration.js';
import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {loadEnvFile,config,secret} from '../../../packages/config/src/index.js';
import {Database} from '../../../packages/storage/src/database.js';
import {Vault} from '../../../packages/storage/src/crypto.js';
import {DingTalkSender} from '../../../packages/dingtalk/src/sender.js';
import {DeliveryGateway} from '../../../packages/gateway/src/delivery.js';
import {DingTalkCards,cardTemplateSchema} from '../../../packages/dingtalk/src/cards.js';
import {CardCoordinator} from '../../../packages/gateway/src/cards.js';
import {Gateway} from '../../../packages/gateway/src/index.js';
import {RuntimeStore} from '../../../packages/runtime/src/store.js';
import {registerTaskCapability} from '../../../packages/runtime/src/loop.js';
import {registerAttachmentCapabilities} from '../../../packages/attachments/src/capabilities.js';
import {AttachmentService} from '../../../packages/attachments/src/service.js';
import {EncryptedFileStore} from '../../../packages/storage/src/files.js';
loadEnvFile();const cfg=config();const required=(n:string)=>{const v=secret(n);if(!v)throw Error('BLOCKED_EXTERNAL:'+n);return v;};
const db=new Database(required('RUNTIME_DATABASE_URL')),vault=new Vault(new Map([['1',Buffer.from(required('APP_MASTER_KEY'),'hex')]]),'1');
const scopes=z.array(z.object({tenantId:z.uuid(),actorId:z.uuid()}).strict()).parse(JSON.parse(await readFile(process.env['WORKER_SCOPE_FILE']??'.data/worker-scopes.json','utf8')));
const lifecycle=await initializeLifecycle(db,process.env,scopes,'NOTIFIER'),trial=lifecycle.mode==='TRIAL';assertLifecycleBinding(lifecycle,secret('DINGTALK_CORP_ID'),secret('DINGTALK_ROBOT_CODE'));
if(lifecycle.mode==='TRIAL')assertOwnedTrialService(lifecycle.profile,'notifier');
const sender=new DingTalkSender({clientId:required('DINGTALK_CLIENT_ID'),clientSecret:required('DINGTALK_CLIENT_SECRET'),robotCode:required('DINGTALK_ROBOT_CODE'),replyOnly:lifecycle.mode!=='DEFAULT'||cfg.DINGTALK_REPLY_ONLY==='true'});
const evidenceGateway=new Gateway(new RuntimeStore(db,vault));if(lifecycle.mode==='DEFAULT')registerNativeArtifacts(evidenceGateway,vault,new EncryptedFileStore(process.env['FILE_STORE_ROOT']??'.data/files',vault),{},lifecycle.mode);if(lifecycle.mode==='DEFAULT')evidenceGateway.store.configureGroupCases(new GroupCases(db,vault,required('DINGTALK_ROBOT_CODE')));if(!trial){evidenceGateway.store.configurePersonas(new RunPersonas(db,vault));registerTaskCapability(evidenceGateway);registerAttachmentCapabilities(evidenceGateway,new AttachmentService(db,vault,new EncryptedFileStore(process.env['FILE_STORE_ROOT']??'.data/files',vault),undefined,{corpId:required('DINGTALK_CORP_ID'),robotCode:required('DINGTALK_ROBOT_CODE')}));}
const company=lifecycle.mode==='DEFAULT'||lifecycle.mode==='FORMAL'&&lifecycle.profile.capabilities.some(c=>c.id.startsWith('company.'))?await configureCompanyCode(evidenceGateway,process.env,fetch,lifecycle.mode==='FORMAL'?lifecycle.profile.capabilities:undefined):undefined;
const companyLogs=lifecycle.mode==='DEFAULT'||lifecycle.mode==='FORMAL'&&lifecycle.profile.capabilities.some(c=>c.id.startsWith('company.'))?await configureCompanyLogs(evidenceGateway,process.env,fetch,lifecycle.mode==='FORMAL'?lifecycle.profile.capabilities:undefined):undefined;
if(lifecycle.mode==='DEFAULT'||lifecycle.mode==='FORMAL'&&lifecycle.profile.capabilities.some(c=>c.id.startsWith('dws.'))){const dws=await configureDws(db,vault);evidenceGateway.store.configureGroupAudience(new GroupAudience(db,vault,dws,required('DINGTALK_ROBOT_CODE')));if(lifecycle.mode==='DEFAULT'&&dws.runner?.readNativeCaseRoster)evidenceGateway.store.configureNativeCaseAudience(new NativeCaseAudience(db,vault,dws,required('DINGTALK_ROBOT_CODE')));registerDwsCapabilities(evidenceGateway,dws);if(lifecycle.mode==='DEFAULT')registerGroupCaseRead(evidenceGateway);}
const companyAgent=lifecycle.mode==='DEFAULT'||lifecycle.mode==='FORMAL'?configureCompanyAgent(evidenceGateway,vault,process.env,fetch,lifecycle.mode==='FORMAL'?lifecycle.profile.capabilities:undefined,lifecycle.mode==='FORMAL'?lifecycle.profile:undefined):undefined;
const gateway=new DeliveryGateway(db,vault,sender,{corpId:required('DINGTALK_CORP_ID'),robotCode:required('DINGTALK_ROBOT_CODE'),appOrigin:cfg.APP_ORIGIN},Date.now,(...args)=>evidenceGateway.finalSourcesAllowed(...args));
let cards:CardCoordinator|undefined;if(!sender.replyOnly)try{const template=cardTemplateSchema.parse(JSON.parse(await readFile(process.env['DINGTALK_CARD_TEMPLATE_FILE']??'.data/card-template.json','utf8')));cards=new CardCoordinator(db,vault,new DingTalkCards({template,robotCode:required('DINGTALK_ROBOT_CODE'),token:signal=>sender.token(signal)}),{corpId:required('DINGTALK_CORP_ID'),appOrigin:cfg.APP_ORIGIN,template});}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;console.log('CARD_TEMPLATE_NOT_CONFIGURED: text delivery remains enabled.');}

assertLifecycleScopes(lifecycle,scopes);
const controller=new AbortController();let busy=false;
async function tick(){if(busy||controller.signal.aborted)return;busy=true;try{for(const scope of scopes){if(cards)try{await cards.tick(scope,AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]));}catch{console.error('CARD_STATUS_FAILED_TEXT_DELIVERY_CONTINUES');}for(const id of await gateway.pending(scope))await gateway.process(scope,id,AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]));}}catch{console.error('DELIVERY_PROCESSING_FAILED');}finally{busy=false;}}
await tick();const timer=setInterval(()=>{void tick();},1000);
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{controller.abort();clearInterval(timer);void Promise.allSettled([company?.close(),companyLogs?.close(),companyAgent?.close()]).then(()=>Promise.allSettled([evidenceGateway.store.groupAudiences?.close(),evidenceGateway.store.nativeCaseAudiences?.close()])).then(()=>db.close());});
console.log('Notifier running with current-identity and audience authorization checks.');
