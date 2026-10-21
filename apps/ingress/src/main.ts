import {initializeLifecycle,assertLifecycleBinding} from '../../../packages/config/src/lifecycle.js';
import {assertOwnedTrialService} from '../../../packages/runtime/src/trial-supervision.js';
import {RunPersonas} from '../../../packages/personas/src/runtime.js';
import {GroupAudience} from '../../../packages/groups/src/audience.js';
import {RuntimeStore} from '../../../packages/runtime/src/store.js';
import {configureDws} from '../../../packages/dws/src/configuration.js';
import {DWClient} from 'dingtalk-stream';
import {Database} from '../../../packages/storage/src/database.js';
import {Vault} from '../../../packages/storage/src/crypto.js';
import {loadEnvFile,config,secret} from '../../../packages/config/src/index.js';
import {resolveTenantBinding} from '../../../packages/config/src/tenant-binding.js';
import {DingTalkIngress,attachDurableRobotCallback} from '../../../packages/dingtalk/src/ingress.js';
import {CardCallbacks,attachCardCallbacks} from '../../../packages/dingtalk/src/card-actions.js';
loadEnvFile();config();
const required=(name:string)=>{const v=secret(name);if(!v) throw Error(`BLOCKED_EXTERNAL:${name}`);return v;};
const db=new Database(required('RUNTIME_DATABASE_URL')),vault=new Vault(new Map([['1',Buffer.from(required('APP_MASTER_KEY'),'hex')]]),'1');
const binding=await resolveTenantBinding(db,required('DINGTALK_CORP_ID'),process.env['TENANT_BINDINGS_FILE']??'.data/tenant-bindings.json');if(!binding)throw Error('BLOCKED_EXTERNAL:TENANT_BINDING');
const lifecycle=await initializeLifecycle(db,process.env,[{tenantId:binding.tenantId,actorId:'00000000-0000-4000-8000-000000000000'}],'INGRESS'),trial=lifecycle.mode==='TRIAL';assertLifecycleBinding(lifecycle,secret('DINGTALK_CORP_ID'),secret('DINGTALK_ROBOT_CODE'));
if(lifecycle.mode==='TRIAL')assertOwnedTrialService(lifecycle.profile,'ingress');
const client=new DWClient({clientId:required('DINGTALK_CLIENT_ID'),clientSecret:required('DINGTALK_CLIENT_SECRET'),debug:false});

const continuations=new RuntimeStore(db,vault);if(!trial){continuations.configurePersonas(new RunPersonas(db,vault));if(lifecycle.mode==='DEFAULT'||lifecycle.profile.capabilities.some(c=>c.id.startsWith('dws.')))continuations.configureGroupAudience(new GroupAudience(db,vault,await configureDws(db,vault),required('DINGTALK_ROBOT_CODE')));}
attachDurableRobotCallback(client,new DingTalkIngress(db,vault,{...binding,robotCode:required('DINGTALK_ROBOT_CODE')},continuations),code=>console.error(code));
if(lifecycle.mode==='DEFAULT')attachCardCallbacks(client,new CardCallbacks(db,{...binding,clientId:required('DINGTALK_CLIENT_ID'),appOrigin:config().APP_ORIGIN}),code=>console.error(code));
await client.connect();for(const s of ['SIGTERM','SIGINT'] as const) process.on(s,()=>{client.disconnect();void Promise.resolve(continuations.groupAudiences?.close()).then(()=>db.close());});
