import {DmDiagnosticCounters} from '../../packages/dingtalk/src/dm-metadata-diagnostics.js';
import './dm-diagnostics-offline-guard.mjs';
import {EventEmitter} from 'node:events';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {runDmMetadataChild} from '../../packages/dingtalk/src/dm-metadata-child.js';
import {createDmMetadataClient} from '../../packages/dingtalk/src/dm-metadata-sdk.js';
import {DM_CAPTURE_TOPIC} from '../../packages/dingtalk/src/dm-metadata.js';
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
runDmMetadataChild((credentials,callback,context)=>{
 const client=createDmMetadataClient(credentials,callback),trace=credentials.clientSecret,write=(name:string,text='1')=>writeFileSync(join(trace,name),text,{mode:0o600});
 write('owned-pid',String(process.pid));
 if(credentials.clientId==='identity-ipc-unexpected')process.send?.({kind:'IDENTITY_DIAGNOSTIC',value:{chatbotCorpId:'PRIVATE_IPC_CORP_CANARY'}});
 if(credentials.clientId==='identity-ipc-wrong-kind')process.send?.({kind:'METADATA',value:{chatbotCorpId:'PRIVATE_IPC_CORP_CANARY'}});
 if(credentials.clientId==='identity-ipc-extra')process.send?.({kind:'IDENTITY_DIAGNOSTIC',value:{chatbotCorpId:'PRIVATE_IPC_CORP_CANARY'},body:'PRIVATE_IPC_BODY_CANARY'});

 if(credentials.clientId==='diagnostic-ipc-throw'){let calls=0;process.send=()=>{write('throwing-send-count',String(++calls));throw Error('PRIVATE_IPC_CANARY');};}
 if(credentials.clientId==='diagnostic-malformed')process.send?.({kind:'DIAGNOSTICS',snapshot:{...new DmDiagnosticCounters().snapshot(50),body:'PRIVATE_IPC_CANARY'}});
 client.getAccessToken=async()=>{write('unexpected-business-api');throw Error('FORBIDDEN_SYNTHETIC_TOKEN_REQUEST');};
 client.getEndpoint=async()=>{
  write('endpoint-entered');if(credentials.clientId==='failure'){console.error('RAW_SECRET_CANARY endpoint credentials');throw Error('RAW_SECRET_CANARY');}
  if(credentials.clientId==='late-endpoint')await delay(600);else if(credentials.clientId==='hang')await new Promise(()=>{});return client;
 };
 client._connect=async()=>{
  write('socket-entered');if(credentials.clientId==='no-open')return;const socket=new EventEmitter();Reflect.set(client,'socket',socket);setTimeout(()=>{socket.emit('open');if(credentials.clientId==='diagnostic-close')socket.emit('close');},0);if(credentials.clientId==='late-socket')await delay(600);write('socket-opened');client.connected=true;
  if(credentials.clientId.startsWith('identity-')||credentials.clientId==='success'||credentials.clientId==='nonce-expired'||credentials.clientId==='diagnostic-reject'||credentials.clientId==='diagnostic-flood'){
   let acks=0;client.send=()=>write('protocol-acks',String(++acks));
   const message={specVersion:'1.0',type:'CALLBACK',headers:{appId:'synthetic-app',connectionId:'synthetic-connection',contentType:'application/json',messageId:'synthetic-protocol',time:String(Date.now()),topic:DM_CAPTURE_TOPIC},data:JSON.stringify({msgtype:'text',msgId:'synthetic-msg',chatbotCorpId:credentials.clientId.startsWith('identity-')?'FOREIGN_CHATBOT_CORP_CANARY':context.identity.corpId,senderCorpId:credentials.clientId.startsWith('identity-')?'FOREIGN_SENDER_CORP_CANARY':context.identity.corpId,senderStaffId:credentials.clientId==='identity-wrong-staff'?'OTHER_STAFF_CANARY':context.identity.staffId,robotCode:credentials.clientId==='identity-wrong-robot'?'OTHER_ROBOT_CANARY':context.identity.robotCode,conversationId:'synthetic-cid',conversationType:credentials.clientId==='identity-group'?'2':'1',createAt:Date.now()-(credentials.clientId==='nonce-expired'||credentials.clientId==='identity-stale'?10000:0),senderId:credentials.clientId==='identity-self'?'synthetic-bot':'synthetic-human',chatbotUserId:'synthetic-bot',text:{content:'OA_BIND_DM_V1 '+(credentials.clientId==='identity-wrong-nonce'?'b'.repeat(32):context.nonce)},sessionWebhook:'https://secret.invalid?token=RAW_SECRET_CANARY',senderNick:'PRIVATE_BODY_CANARY'})};
   setTimeout(()=>{client.onSystem({...message,type:'SYSTEM',headers:{...message.headers,topic:'REGISTERED'}});if(credentials.clientId==='diagnostic-flood'){for(let i=0;i<500;i++)client.onCallback({...message,headers:{...message.headers,topic:'PRIVATE_OTHER_TOPIC_CANARY'}});}else if(credentials.clientId==='diagnostic-reject'){client.onCallback({...message,headers:{...message.headers,topic:'synthetic-other-topic'}});client.onCallback({...message,data:JSON.stringify({...JSON.parse(message.data),text:{content:'MISMATCHED_NONCE_CANARY'}})});}else{client.onCallback(message);client.onCallback(message);}},0);
  }
 };
 return client;
});
