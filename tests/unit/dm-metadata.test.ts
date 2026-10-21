import {DmDiagnosticCounters,dmDiagnosticSnapshotSchema} from '../../packages/dingtalk/src/dm-metadata-diagnostics.js';
import {createHash} from 'node:crypto';
import {DmCaptureFilter,DM_CAPTURE_TOPIC,dmMetadataSchema,isDmCaptureMarker,newDmCaptureNonce} from '../../packages/dingtalk/src/dm-metadata.js';
const nonce='0123456789abcdef0123456789abcdef',identity={corpId:'synthetic-corp',staffId:'synthetic-self',robotCode:'synthetic-robot'},wall=Date.UTC(2026,9,17,0,0,0);
function message(patch:Record<string,unknown>={}){return {type:'CALLBACK',headers:{topic:DM_CAPTURE_TOPIC,messageId:'synthetic-protocol-id'},data:JSON.stringify({msgtype:'text',msgId:'synthetic-message',chatbotCorpId:identity.corpId,senderCorpId:identity.corpId,senderStaffId:identity.staffId,robotCode:identity.robotCode,conversationId:'synthetic-cid',conversationType:'1',createAt:wall,senderId:'synthetic-human',chatbotUserId:'synthetic-bot',text:{content:'OA_BIND_DM_V1 '+nonce},...patch})};}
function fixture(windowMs=180000){let mono=0,now=wall;const filter=new DmCaptureFilter({identity,nonce,windowMs,mono:()=>mono,wall:()=>now});return {filter,set:(m:number,w=wall)=>{mono=m;now=w;}};}
it('captures exactly one minimum private metadata projection and discards every extra callback/body field',()=>{
 const f=fixture(),m=message({senderNick:'PRIVATE_NAME',sessionWebhook:'https://secret.invalid/callback?token=SECRET',clientSecret:'SECRET',text:{content:'OA_BIND_DM_V1 '+nonce,secret:'SECRET'}}),r=f.filter.accept({...m,secret:'SECRET'});
 expect(r).toEqual({protocolMessageId:'synthetic-protocol-id',metadata:{schemaVersion:1,...identity,conversationId:'synthetic-cid',conversationType:'1',messageId:'synthetic-message',providerTime:wall,capturedAt:new Date(wall).toISOString(),nonceHash:createHash('sha256').update(nonce).digest('hex'),source:'DINGTALK_STREAM_ROBOT_CALLBACK',sdkVersion:'2.1.5'}});
 expect(JSON.stringify(r)).not.toMatch(/PRIVATE_NAME|SECRET|sessionWebhook|senderNick|OA_BIND_DM_V1/);expect(f.filter.accept(m)).toBeNull();
});
it.each([
 {chatbotCorpId:'foreign'},{senderCorpId:'foreign'},{senderStaffId:'other'},{robotCode:'other'},{conversationType:'2'},{conversationType:1},{senderId:'synthetic-bot'},
 {msgtype:'image'},{attachments:[]},{content:{downloadCode:'synthetic'}},{downloadCode:'synthetic'},{conversationId:''},{msgId:''},{senderId:''},{chatbotUserId:''},{createAt:wall-5001},{createAt:wall+5001},{createAt:NaN},
 {text:{content:'OA_BIND_DM_V1 '+nonce.slice(1)}},{text:{content:'OA_BIND_DM_V1 '+'a'.repeat(32)}},{text:{content:'OA_BIND_DM_V1 '+nonce+' extra'}},{text:{content:' OA_BIND_DM_V1 '+nonce}},{text:{content:'OA_BIND_DM_V1 '+nonce+'\n'}},
 {text:{content:'OA_BIND_DM_V1 '+nonce,attachment:{name:'fake'}} ,msgtype:'file'}
])('rejects wrong identity, group/self/attachment, stale, partial or malformed message %#',patch=>{const f=fixture();expect(f.filter.accept(message(patch))).toBeNull();expect(f.filter.accept(message())).not.toBeNull();});
it('rejects wrong topic/type, empty protocol ID, malformed JSON and oversized frames',()=>{
 for(const m of [{...message(),type:'EVENT'},{...message(),headers:{topic:'*',messageId:'id'}},{...message(),headers:{topic:DM_CAPTURE_TOPIC,messageId:''}},{...message(),data:'{'},{...message(),data:'x'.repeat(32769)},null])expect(fixture().filter.accept(m)).toBeNull();
});
it('uses the monotonic deadline even if the wall clock is moved backwards, and close is final',()=>{
 const f=fixture();f.set(180000,wall-10000);expect(f.filter.accept(message())).toBeNull();f.set(0);expect(f.filter.accept(message())).toBeNull();const closed=fixture();closed.filter.close();expect(closed.filter.accept(message())).toBeNull();
});
it('accepts just before deadline and synchronously prevents repeated/concurrent claims',async()=>{
 const f=fixture();f.set(179999,wall+179999);const m=message({createAt:wall+179999}),r=await Promise.all(Array.from({length:20},async()=>f.filter.accept(m)));expect(r.filter(Boolean)).toHaveLength(1);
});
it.each([0,-1,180001,0.5,NaN,Infinity])('rejects an invalid capture window %s',windowMs=>{expect(()=>fixture(windowMs)).toThrow();});
it('reserves only the exact marker and generates 128bit nonces without persisting raw text',()=>{
 const a=newDmCaptureNonce(),b=newDmCaptureNonce();expect(a).toMatch(/^[a-f0-9]{32}$/);expect(b).not.toBe(a);expect(isDmCaptureMarker('OA_BIND_DM_V1 '+a)).toBe(true);
 for(const text of ['ordinary business','OA_BIND_DM_V1 '+a+' suffix','prefix OA_BIND_DM_V1 '+a,'OA_BIND_DM_V1 '+a.toUpperCase(),null])expect(isDmCaptureMarker(text)).toBe(false);
 const r=fixture().filter.accept(message())!;expect(dmMetadataSchema.safeParse({...r.metadata,text:'PRIVATE_BODY'}).success).toBe(false);
});
it.each(['\n','\r\n','\r'])('the shared reserved marker rejects the full trailing line ending %#',ending=>{expect(isDmCaptureMarker('OA_BIND_DM_V1 '+nonce+ending)).toBe(false);});
it('requires exact-length nonces and nonce hashes rather than JavaScript dollar-anchor matching',()=>{
 expect(()=>new DmCaptureFilter({identity,nonce:nonce+'\n'})).toThrow();const r=fixture().filter.accept(message())!;expect(dmMetadataSchema.safeParse({...r.metadata,nonceHash:r.metadata.nonceHash+'\n'}).success).toBe(false);
});

it('optional diagnostics retain fixed refusal counts while preserving the exact acceptance and minimal proof',()=>{
 const counts=new DmDiagnosticCounters(),filter=new DmCaptureFilter({identity,nonce,wall:()=>wall,mono:()=>0,diagnostics:counts});
 for(const rejected of [message({chatbotCorpId:'PRIVATE_CHATBOT_CORP_CANARY'}),message({senderCorpId:'PRIVATE_SENDER_CORP_CANARY'}),message({senderStaffId:'PRIVATE_STAFF_CANARY'}),message({robotCode:'PRIVATE_ID_CANARY'}),message({text:{content:'OA_BIND_DM_V1 '+'b'.repeat(32)}}),message({conversationType:'2'}),message({text:{content:' OA_BIND_DM_V1 '+nonce}}),message({createAt:wall-5001}),{...message(),data:'{PRIVATE_BODY_CANARY'},message({attachments:['PRIVATE_FILE_CANARY']})])expect(filter.accept(rejected)).toBeNull();
 expect(filter.accept(message())).not.toBeNull();expect(filter.accept(message())).toBeNull();
 const snapshot=counts.snapshot();expect(snapshot.rejected).toMatchObject({chatbot_corp:1,sender_corp:1,staff:1,robot:1,not_private:1,nonce_format:1,nonce_value:1,time:1,json:1,forbidden_payload:1,inactive:1});expect(snapshot.accepted).toBe(1);expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE_|synthetic-|OA_BIND|012345/);
 for(const raw of [{...snapshot,body:'PRIVATE_BODY_CANARY'},{...snapshot,rejected:{...snapshot.rejected,raw:'SECRET'}},{...snapshot,callbacks:-1},{...snapshot,sequence:130},{...snapshot,callbacks:1000001}])expect(dmDiagnosticSnapshotSchema.safeParse(raw).success).toBe(false);
 const copy=counts.snapshot();copy.rejected.robot=999;expect(counts.snapshot().rejected.robot).toBe(1);
});
