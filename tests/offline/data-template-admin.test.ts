import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DataTemplateAdminFlow,DataTemplateAdminFailure,canRollbackTemplate} from '../../apps/web/src/data-template-admin-flow.js';
assert.equal(Reflect.get(globalThis,Symbol.for('anthys.testNetworkGuard')),true);
assert.deepEqual(Object.keys(process.env).filter(k=>/(?:DATABASE|PROVIDER|GLM|DINGTALK|DWS|MCP|TOKEN|SECRET|CREDENTIAL|^PG|^NODE_OPTIONS$)/i.test(k)),[]);
const key='30000000-0000-4000-8000-000000000001',otherKey='30000000-0000-4000-8000-000000000002',templateKey='payments.success_rate_daily';
const item=(version='1.0.0',active=false)=>({templateKey,templateVersion:version,templateHash:(version==='1.0.0'?'a':'b').repeat(64),certificationReference:'cert-review-2026-10',publishedAt:'2026-10-20T00:00:00.000Z',active,activeVersion:'1.1.0',activeRevision:4});
const list=()=>({items:[item('1.0.0',false),item('1.1.0',true)],truncated:false,platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false});
const receipt=(requestId=key,operation:'publish'|'rollback'='rollback')=>{const version=operation==='publish'?'1.2.0':'1.0.0';return {templateKey,templateVersion:version,activeVersion:version,activeRevision:5,operation:operation==='publish'?'PUBLISH':'ROLLBACK',replayed:false,requestId,platformCertification:'LOCAL_GOLDEN_ONLY',liveVerified:false};};

test('rejects malformed, overbroad or contradictory template lists without retaining metadata',async()=>{
 for(const value of [{...list(),platformCertification:'LIVE'},{...list(),liveVerified:true},{...list(),truncated:'no'},{...list(),items:[item('1.0.0'),item('1.0.0')]},{...list(),items:Array.from({length:201},(_,i)=>({...item('1.0.0'),templateVersion:`1.0.${i}`}))},{...list(),items:[{...item('1.0.0'),active:true}]},{...list(),items:[{...item('1.0.0'),activeVersion:null}]},{...list(),items:[{...item('1.0.0'),active:false,activeVersion:'1.0.0'}]},{...list(),items:[{...item('1.0.0'),templateHash:'x'}]},{...list(),items:[{...item('1.0.0'),templateVersion:'1.0'}]},{...list(),items:[{...item('1.0.0'),publishedAt:'2026-10-20'}]},{...list(),items:[{...item('1.0.0'),certificationReference:'short'}]},{items:[item()]},null]){
  const flow=new DataTemplateAdminFlow(async()=>value,()=>key);const result=await flow.load();assert.equal(result?.ok,false);assert.deepEqual(flow.items,[]);assert.equal(flow.selected,null);assert.equal(flow.intent,null);assert.equal(flow.truncated,false);
 }
});

test('only a registered non-active version with a current active record can be selected for rollback',async()=>{
 const valid=item('1.0.0');assert.equal(canRollbackTemplate(valid),true);assert.equal(canRollbackTemplate(item('1.1.0',true)),false);assert.equal(canRollbackTemplate({...valid,activeVersion:null,activeRevision:null}),false);
 const flow=new DataTemplateAdminFlow(async()=>list(),()=>key);await flow.load();assert.equal(flow.select(templateKey,'1.1.0'),false);assert.equal(flow.select(templateKey,'9.9.9'),false);assert.equal(flow.select(templateKey,'1.0.0'),true);assert.equal(flow.prepareRollback('short').ok,false);assert.equal(flow.prepareRollback('template-rollback-1').ok,true);assert.equal(flow.intent?.operation,'rollback');
 if(flow.intent?.operation==='rollback')assert.equal(flow.intent.body.expectedRevision,4);
});

test('publish validates the reviewed key, version and review reference and refuses already registered versions',async()=>{
 const paths:string[]=[];const flow=new DataTemplateAdminFlow(async path=>{paths.push(path);return list();},()=>key);await flow.load();
 for(const input of [{templateKey:'BAD',templateVersion:'1.2.0',reviewReference:'template-publish-1'},{templateKey,templateVersion:'1.2',reviewReference:'template-publish-1'},{templateKey,templateVersion:'1.2.0',reviewReference:'short'},{templateKey,templateVersion:'1.0.0',reviewReference:'template-publish-1'}])assert.equal(flow.preparePublish(input).ok,false);
 assert.equal(paths.length,1);assert.equal(flow.intent,null);assert.equal(flow.preparePublish({templateKey,templateVersion:'1.2.0',reviewReference:'template-publish-1'}).ok,true);
});

test('publish sends one fixed key and exact body, and a second click cannot resend',async()=>{
 const calls:{path:string;body:unknown;key:string|undefined}[]=[];const flow=new DataTemplateAdminFlow(async(path,body,requestKey)=>{calls.push({path,body,key:requestKey});return body===undefined?list():receipt(requestKey,'publish');},()=>key);await flow.load();
 assert.equal(flow.preparePublish({templateKey,templateVersion:'1.2.0',reviewReference:'template-publish-1'}).ok,true);assert.equal(flow.intent?.item,null);
 const pending=flow.confirm();assert.equal(flow.intent,null);assert.equal(await flow.confirm(),null);const result=await pending;assert.equal(result?.ok,true);assert.equal(flow.receipt?.activeVersion,'1.2.0');assert.equal(flow.receipt?.operation,'PUBLISH');
 assert.deepEqual(calls[1],{path:'/data/templates/publish',body:{templateKey,templateVersion:'1.2.0',reviewReference:'template-publish-1'},key});assert.equal(calls.length,2);assert.deepEqual(flow.items,[]);
});

test('rollback binds the selected version, exact expected revision and one key; cancellation sends nothing',async()=>{
 const calls:{path:string;body:unknown;key:string|undefined}[]=[];const flow=new DataTemplateAdminFlow(async(path,body,requestKey)=>{calls.push({path,body,key:requestKey});return body===undefined?list():receipt(requestKey,'rollback');},()=>key);await flow.load();assert.equal(flow.select(templateKey,'1.0.0'),true);
 assert.equal(flow.prepareRollback('template-rollback-1').ok,true);flow.cancel();assert.equal(calls.length,1);assert.equal(await flow.confirm(),null);
 assert.equal(flow.select(templateKey,'1.0.0'),true);assert.equal(flow.prepareRollback('template-rollback-1').ok,true);const pending=flow.confirm();assert.equal(await flow.confirm(),null);assert.equal((await pending)?.ok,true);
 assert.deepEqual(calls[1],{path:'/data/templates/rollback',body:{templateKey,templateVersion:'1.0.0',expectedRevision:4,reviewReference:'template-rollback-1'},key});assert.equal(flow.receipt?.activeRevision,5);
});

test('wrong, old, contradictory or uncertified receipts cannot show success or retry',async()=>{
 for(const value of [{...receipt(),templateKey:'other.template'},{...receipt(),templateVersion:'1.0.1'},{...receipt(),operation:'PUBLISH'},{...receipt(),requestId:otherKey},{...receipt(),activeVersion:'1.1.0'},{...receipt(),activeRevision:6},{...receipt(),activeRevision:0},{...receipt(),platformCertification:'PLATFORM_CERTIFIED'},{...receipt(),liveVerified:true},{...receipt(),replayed:true},{...receipt(),replayed:true,currentActiveVersion:'1.1.0',currentActiveRevision:4},{...receipt(),currentActiveVersion:'1.1.0',currentActiveRevision:9},{...receipt(),replayed:true,currentActiveVersion:'bad',currentActiveRevision:9},{id:'x'},null]){
  let calls=0;const flow=new DataTemplateAdminFlow(async(_p,body)=>{calls++;return body===undefined?list():value;},()=>key);await flow.load();flow.select(templateKey,'1.0.0');flow.prepareRollback('template-rollback-1');
  assert.equal((await flow.confirm())?.ok,false);assert.equal(flow.receipt,null);assert.equal(flow.intent,null);assert.deepEqual(flow.items,[]);assert.equal(await flow.confirm(),null);assert.equal(calls,2);
 }
});

test('conflicts, denials, invalid input, missing versions, unavailability and unknown networks erase intent without leaking text',async()=>{
 for(const error of [new DataTemplateAdminFailure(409),new DataTemplateAdminFailure(403),new DataTemplateAdminFailure(400),new DataTemplateAdminFailure(404),new DataTemplateAdminFailure(503),new Error('SYNTHETIC_PRIVATE_TEMPLATE_DRIVER_ERROR')]){
  let calls=0;const flow=new DataTemplateAdminFlow(async(_p,body)=>{calls++;if(body===undefined)return list();throw error;},()=>key);await flow.load();flow.select(templateKey,'1.0.0');assert.equal(flow.prepareRollback('template-rollback-1').ok,true);const result=await flow.confirm();assert.equal(result?.ok,false);assert.doesNotMatch(result!.notice,/SYNTHETIC_PRIVATE_TEMPLATE_DRIVER_ERROR/);assert.equal(flow.intent,null);assert.equal(await flow.confirm(),null);assert.equal(calls,2);
 }
});

test('replayed receipt keeps the logical result separate from the latest active record and clear suppresses late replies',async()=>{
 const replay=new DataTemplateAdminFlow(async(_p,body)=>body===undefined?list():{...receipt(),replayed:true,currentActiveVersion:'1.1.0',currentActiveRevision:9},()=>key);await replay.load();replay.select(templateKey,'1.0.0');replay.prepareRollback('template-rollback-1');assert.equal((await replay.confirm())?.ok,true);assert.equal(replay.receipt?.activeVersion,'1.0.0');assert.equal(replay.receipt?.currentActiveVersion,'1.1.0');assert.equal(replay.receipt?.currentActiveRevision,9);assert.equal(replay.receipt?.replayed,true);
 let resolve!:(value:unknown)=>void;const flow=new DataTemplateAdminFlow(async()=>new Promise(r=>{resolve=r;}),()=>key);const pending=flow.load();flow.clear();resolve(list());assert.equal(await pending,null);assert.deepEqual(flow.items,[]);
 let finish!:(value:unknown)=>void;const live=new DataTemplateAdminFlow(async(_p,body)=>{if(body===undefined)return list();return new Promise(r=>{finish=r;});},()=>key);await live.load();live.select(templateKey,'1.0.0');live.prepareRollback('template-rollback-1');const write=live.confirm();live.clear();finish(receipt());assert.equal(await write,null);assert.equal(live.receipt,null);
});

test('401 on load or mutation clears every datum and requests session-lost handling',async()=>{
 for(const loadFails of [true,false]){
  const flow=new DataTemplateAdminFlow(async(_p,body)=>{if(body===undefined){if(loadFails)throw new DataTemplateAdminFailure(401);return list();}throw new DataTemplateAdminFailure(401);},()=>key);
  if(loadFails){const result=await flow.load();assert.equal(result?.sessionLost,true);assert.deepEqual(flow.items,[]);continue;}
  await flow.load();flow.select(templateKey,'1.0.0');flow.prepareRollback('template-rollback-1');const result=await flow.confirm();assert.equal(result?.sessionLost,true);assert.deepEqual(flow.items,[]);assert.equal(flow.receipt,null);assert.equal(flow.selected,null);
 }
});
