import {randomUUID} from 'node:crypto';
import {TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import type {Database} from '../../packages/storage/src/database.js';
import type {Vault} from '../../packages/storage/src/crypto.js';
import {DingTalkIngress} from '../../packages/dingtalk/src/ingress.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import type {RuntimePreferences} from '../../packages/memory/src/runtime.js';
import {RunPersonas} from '../../packages/personas/src/runtime.js';
import {Gateway} from '../../packages/gateway/src/index.js';
import type {personaFixture} from './personas.js';
export function personaNative(f:Awaited<ReturnType<typeof personaFixture>>,db:Database,vault:Vault,memory?:RuntimePreferences){
 const binding={tenantId:f.tenantId,corpId:'synthetic-personas-'+f.tenantId,robotCode:'synthetic-persona-robot',appOrigin:'http://localhost:64700'},store=new RuntimeStore(db,vault);store.configurePersonas(new RunPersonas(db,vault,memory));
 const event=(text:string,name:keyof typeof f.people='alice',group?:string):DWClientDownStream=>{const id=randomUUID(),external='synthetic-persona-'+name;return {specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:id,time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId:id,chatbotCorpId:binding.corpId,senderCorpId:binding.corpId,senderStaffId:external,senderId:external,chatbotUserId:'synthetic-persona-bot',conversationId:group??'synthetic-persona-dm-'+f.people[name].actorId,conversationType:group?'2':'1',robotCode:binding.robotCode,msgtype:'text',text:{content:text},createAt:Date.now(),sessionWebhook:'https://oapi.dingtalk.com/robot/send?access_token=synthetic-persona-webhook',sessionWebhookExpiredTime:Date.now()+600000})};};
 return {binding,store,gateway:new Gateway(store),event,ingress:new DingTalkIngress(db,vault,binding,store)};
}
