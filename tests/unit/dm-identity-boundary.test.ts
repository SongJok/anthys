import {DmIdentityDiagnosticFilter} from '../../packages/dingtalk/src/dm-identity-diagnostic.js';
import {DmDiagnosticCounters} from '../../packages/dingtalk/src/dm-metadata-diagnostics.js';
import {DM_CAPTURE_TOPIC} from '../../packages/dingtalk/src/dm-metadata.js';
const identity={corpId:'SYNTHETIC_EXPECTED',staffId:'SYNTHETIC_SELF',robotCode:'SYNTHETIC_ROBOT'},nonce='a'.repeat(32),stamp=1700000000000;
function callback(){return {type:'CALLBACK',headers:{topic:DM_CAPTURE_TOPIC,messageId:'SYNTHETIC_PROTOCOL'},data:JSON.stringify({msgtype:'text',msgId:'SYNTHETIC_MSG',chatbotCorpId:'RAW_BOUNDARY_CORP_CANARY',senderCorpId:'RAW_BOUNDARY_SENDER_CANARY',senderStaffId:identity.staffId,robotCode:identity.robotCode,conversationId:'SYNTHETIC_DM',conversationType:'1',createAt:stamp,senderId:'SYNTHETIC_HUMAN',chatbotUserId:'SYNTHETIC_BOT',text:{content:'OA_BIND_DM_V1 '+nonce}})};}
it('identity observer closes permanently exactly at monotonic deadline even if the wall clock later rolls back',()=>{
 let mono=0,wall=stamp;const counters=new DmDiagnosticCounters(),filter=new DmIdentityDiagnosticFilter({identity,nonce,windowMs:100,mono:()=>mono,wall:()=>wall,diagnostics:counters});mono=100;wall=stamp-10000;expect(filter.accept(callback())).toBeNull();mono=0;wall=stamp;expect(filter.accept(callback())).toBeNull();expect(counters.snapshot()).toMatchObject({accepted:0,rejected:{inactive:2}});
});
it('identity observer projects no raw values when only the final monotonic check reaches the deadline',()=>{
 const times=[0,0,100,0],counters=new DmDiagnosticCounters(),filter=new DmIdentityDiagnosticFilter({identity,nonce,windowMs:100,mono:()=>times.shift()??0,wall:()=>stamp,diagnostics:counters});expect(filter.accept(callback())).toBeNull();expect(filter.accept(callback())).toBeNull();expect(counters.snapshot()).toMatchObject({accepted:0,rejected:{inactive:2}});expect(JSON.stringify(counters.snapshot())).not.toMatch(/RAW_BOUNDARY|nonceHash/);
});
it.each([nonce+'\n',nonce+'a'])('identity observer constructor rejects newline or overlong nonce before accepting any callback %#',invalid=>{
 expect(()=>new DmIdentityDiagnosticFilter({identity,nonce:invalid})).toThrow();
});
