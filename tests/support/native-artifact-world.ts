import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {RuntimeStore,Lease} from '../../packages/runtime/src/store.js';
import {toolName,type Gateway} from '../../packages/gateway/src/index.js';
import type {DbContext} from '../../packages/storage/src/database.js';
import {nativeArtifactReceiptSchema,type NativeArtifactInput} from '../../packages/artifacts/src/native-contracts.js';
import {artifactWorld} from './artifact-world.js';
/** Real Gateway action, journal and finalization, shared by API and browser
 * fixtures. It neither constructs a web Principal nor invokes a model. */
export async function finishNativeDraft(deps:{store:RuntimeStore;gateway:Gateway},w:{ctx:DbContext;lease:Lease},args:NativeArtifactInput){
 const name=toolName('artifacts.create','1.0.0'),callId='native-'+randomUUID(),result=await deps.gateway.execute(w.ctx,w.lease,name,args,new AbortController().signal);assert.equal(result.status,'OK');
 assert.notEqual(result.status,'DEFERRED');const receipt=nativeArtifactReceiptSchema.parse(result.data);
 await deps.store.append(w.ctx,w.lease,{role:'assistant',content:null,tool_calls:[{id:callId,type:'function',function:{name,arguments:JSON.stringify(args)}}]});await deps.store.append(w.ctx,w.lease,{role:'tool',tool_call_id:callId,content:JSON.stringify(result)});
 const outcome=await deps.gateway.finalize(w.ctx,w.lease,JSON.stringify({schemaVersion:1,mode:'REPORT',text:'',claims:[{kind:'VALUE',ref:{kind:'TOOL_CALL',id:callId},pointer:'/artifact/fileName',expected:receipt.artifact.fileName,coverage:'OBSERVED'}],outcome:'PARTIAL'}));assert.equal(outcome.kind,'STAGED');return receipt.artifact;
}
export async function nativeArtifactWorld(deps:Parameters<typeof artifactWorld>[0],origin:string){
 const w=await artifactWorld(deps,origin,{finalize:false});
 const artifact=await finishNativeDraft(deps,w,{format:'txt',source:{mode:'TOOL_DRAFT',document:{title:'SYNTHETIC private native draft',paragraphs:['SYNTHETIC source observation: '+w.value]}}});
 return {...w,artifact};
}
