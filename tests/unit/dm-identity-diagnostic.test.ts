import {DmIdentityDiagnosticFilter,dmIdentityDiagnosticSchema} from '../../packages/dingtalk/src/dm-identity-diagnostic.js';
import {DM_CAPTURE_TOPIC,DmCaptureFilter,dmMetadataSchema} from '../../packages/dingtalk/src/dm-metadata.js';
import {DmDiagnosticCounters} from '../../packages/dingtalk/src/dm-metadata-diagnostics.js';

const identity={corpId:'SYNTHETIC_EXPECTED_CORP',staffId:'SYNTHETIC_SELF',robotCode:'SYNTHETIC_ROBOT'},nonce='a'.repeat(32),now=1700000000000;
function body(patch:Record<string,unknown>={}){return {msgtype:'text',msgId:'SYNTHETIC_MSG',chatbotCorpId:'FOREIGN_CHATBOT_CORP_CANARY',senderCorpId:'FOREIGN_SENDER_CORP_CANARY',senderStaffId:identity.staffId,robotCode:identity.robotCode,conversationId:'SYNTHETIC_DM',conversationType:'1',createAt:now,senderId:'SYNTHETIC_HUMAN',chatbotUserId:'SYNTHETIC_BOT',text:{content:'OA_BIND_DM_V1 '+nonce},sessionWebhook:'https://secret.invalid?token=PRIVATE_TOKEN_CANARY',senderNick:'PRIVATE_BODY_CANARY',...patch};}
function callback(value=body()){return {type:'CALLBACK',headers:{topic:DM_CAPTURE_TOPIC,messageId:'SYNTHETIC_PROTOCOL'},data:JSON.stringify(value)};}
function setup(){const counters=new DmDiagnosticCounters(),filter=new DmIdentityDiagnosticFilter({identity,nonce,windowMs:1000,wall:()=>now,mono:()=>0,diagnostics:counters});return {filter,counters};}
it('projects only four raw identities after all non-corp guards and never becomes metadata or accepted authority',()=>{
 const {filter,counters}=setup(),observed=filter.accept(callback());expect(observed).toMatchObject({type:'UNTRUSTED_IDENTITY_DIAGNOSTIC',trusted:false,chatbotCorpId:'FOREIGN_CHATBOT_CORP_CANARY',senderCorpId:'FOREIGN_SENDER_CORP_CANARY',senderStaffId:identity.staffId,robotCode:identity.robotCode,chatbotCorpMatchesConfigured:false,senderCorpMatchesConfigured:false});expect(dmMetadataSchema.safeParse(observed).success).toBe(false);expect(JSON.stringify(observed)).not.toMatch(/PRIVATE_|sessionWebhook|senderNick|conversationId|messageId|SYNTHETIC_HUMAN|OA_BIND/);expect(counters.snapshot()).toMatchObject({accepted:0,protocolAckCalls:0,rejected:{chatbot_corp:1}});expect(filter.accept(callback())).toBeNull();
});
it('matching corp fields remain an untrusted observation with zero metadata/ACK acceptance',()=>{
 const {filter,counters}=setup(),observed=filter.accept(callback(body({chatbotCorpId:identity.corpId,senderCorpId:identity.corpId})));expect(observed).toMatchObject({trusted:false,chatbotCorpMatchesConfigured:true,senderCorpMatchesConfigured:true});expect(counters.snapshot().accepted).toBe(0);expect(counters.snapshot().protocolAckCalls).toBe(0);
});
it.each([
 {patch:{senderStaffId:'OTHER_SELF'},reason:'staff'},
 {patch:{robotCode:'OTHER_ROBOT'},reason:'robot'},
 {patch:{conversationType:'2'},reason:'not_private'},
 {patch:{senderId:'SYNTHETIC_BOT'},reason:'self_robot'},
 {patch:{text:{content:'not a marker'}},reason:'nonce_format'},
 {patch:{text:{content:'OA_BIND_DM_V1 '+'b'.repeat(32)}},reason:'nonce_value'},
 {patch:{createAt:now-10000},reason:'time'},
 {patch:{createAt:now+5001},reason:'time'},
 {patch:{chatbotCorpId:undefined},reason:'body_shape'},
 {patch:{chatbotCorpId:''},reason:'body_shape'},
 {patch:{chatbotCorpId:37},reason:'body_shape'},
 {patch:{senderCorpId:'bad\ncorp'},reason:'body_shape'},
 {patch:{downloadCode:'PRIVATE_FILE_CANARY'},reason:'forbidden_payload'},
 {patch:{senderNick:'x'.repeat(33000)},reason:'frame_size'}
])('non-corp $reason failure cannot expose raw identities despite corp mismatch',({patch,reason})=>{
 const {filter,counters}=setup();expect(filter.accept(callback(body(patch)))).toBeNull();expect(counters.snapshot().rejected[reason as keyof ReturnType<DmDiagnosticCounters['snapshot']>['rejected']]).toBe(1);expect(counters.snapshot().rejected.chatbot_corp).toBe(0);expect(JSON.stringify(counters.snapshot())).not.toMatch(/FOREIGN_|SYNTHETIC_|PRIVATE_|nonceHash|senderStaffId/);
});
it('malformed envelopes/json, a closed window and extra trusted/body fields cannot produce valid observation evidence',()=>{
 const {filter}=setup();expect(filter.accept({...callback(),headers:{topic:'OTHER_TOPIC',messageId:'SYNTHETIC'}})).toBeNull();expect(filter.accept({...callback(),data:'{'})).toBeNull();filter.close();expect(filter.accept(callback())).toBeNull();const valid=setup().filter.accept(callback())!;expect(dmIdentityDiagnosticSchema.safeParse({...valid,trusted:true}).success).toBe(false);expect(dmIdentityDiagnosticSchema.safeParse({...valid,content:'PRIVATE_BODY_CANARY'}).success).toBe(false);expect(dmIdentityDiagnosticSchema.safeParse({...valid,tenantId:'UNTRUSTED_TENANT'}).success).toBe(false);
});
it('default normal capture keeps rejecting corp mismatch and still accepts its original exact self metadata',()=>{
 const normal=new DmCaptureFilter({identity,nonce,windowMs:1000,wall:()=>now,mono:()=>0});expect(normal.accept(callback())).toBeNull();const matched=normal.accept(callback(body({chatbotCorpId:identity.corpId,senderCorpId:identity.corpId})));expect(dmMetadataSchema.safeParse(matched?.metadata).success).toBe(true);expect(dmIdentityDiagnosticSchema.safeParse(matched?.metadata).success).toBe(false);
});
