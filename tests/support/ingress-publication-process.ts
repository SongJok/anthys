import './isolation.js';
import {z} from 'zod';
import {DWClient,TOPIC_ROBOT,type DWClientDownStream} from 'dingtalk-stream';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {DingTalkIngress,attachDurableRobotCallback} from '../../packages/dingtalk/src/ingress.js';
const input=z.object({tenantId:z.uuid(),actorId:z.uuid(),externalUserId:z.string(),messageId:z.uuid(),conversationId:z.string()}).strict().parse(JSON.parse(process.argv[2]!));
const db=new Database(secret('RUNTIME_DATABASE_URL')!),ctx={tenantId:input.tenantId,actorId:input.actorId},robotCode='synthetic-publication-crash',key=`${robotCode}:${input.conversationId}:${input.messageId}`;
const ingress=new DingTalkIngress(db,new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1'),{tenantId:input.tenantId,corpId:'TENANT_A',robotCode}),client=new DWClient({clientId:'synthetic',clientSecret:'synthetic'});
// This child runs the actual native callback/persistence/ACK path. It never
// starts a publisher or worker; the parent kills it after the durable ACK.
client.socketCallBackResponse=id=>{void db.scope(ctx,c=>c.query("SELECT t.id task_id,r.id run_id,o.published_at FROM event_inbox e JOIN tasks t ON t.tenant_id=e.tenant_id AND t.source_event_id=e.id JOIN runs r ON r.tenant_id=t.tenant_id AND r.task_id=t.id JOIN outbox o ON o.tenant_id=r.tenant_id AND o.aggregate_id=r.id AND o.kind='RUN' WHERE e.event_key=$1",[key])).then(q=>{
 if(id!==input.messageId||q.rowCount!==1||q.rows[0].published_at!==null)throw Error('COMMITTED_OUTBOX_BOUNDARY_MISSING');
 process.send?.({kind:'COMMITTED_ACK_BEFORE_PUBLICATION',messageId:id,taskId:q.rows[0].task_id,runId:q.rows[0].run_id});
 }).catch(()=>{process.send?.({kind:'FAILED'});process.exitCode=1;});};
attachDurableRobotCallback(client,ingress,()=>{process.send?.({kind:'FAILED'});process.exitCode=1;});
const event:DWClientDownStream={specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic',connectionId:'synthetic',contentType:'application/json',messageId:input.messageId,time:String(Date.now()),topic:TOPIC_ROBOT},data:JSON.stringify({msgId:input.messageId,chatbotCorpId:'TENANT_A',senderCorpId:'TENANT_A',senderStaffId:input.externalUserId,conversationId:input.conversationId,conversationType:'1',robotCode,msgtype:'text',text:{content:'synthetic committed ingress crash recovery'},createAt:Date.now(),senderId:input.externalUserId,chatbotUserId:'synthetic-bot'})};
setInterval(()=>{},1000);client.onCallback(event);
