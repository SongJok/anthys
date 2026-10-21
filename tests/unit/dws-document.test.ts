import {hash} from '../../packages/storage/src/crypto.js';
import {randomUUID} from 'node:crypto';
import {documentReadSchema,documentPayloadProfile,projectDocument,type DocumentRead} from '../../packages/dws/src/document-contract.js';
const profile=documentPayloadProfile.parse({schemaVersion:1,reviewRef:'synthetic-reviewed-payload',nodePointer:'/data/nodeId',revisionPointer:'/data/revision',textPointer:'/data/markdown',typePointer:'/data/resourceType',typeValue:'adoc',completePointer:'/data/complete',hasMorePointer:'/data/hasMore',cursorPointer:'/data/nextCursor',completenessUnit:'ONE_DOCUMENT_VERSION'});
const args=(selector:DocumentRead['selector']={kind:'FULL',maxCharacters:6000})=>documentReadSchema.parse({nodeId:'synthetic_doc',authorizationVersion:2,requestNonce:randomUUID(),selector});
const response=(text:string,extra:Record<string,unknown>={})=>({contractVersion:'doc.content.v1',status:'success',complete:true,target:{canonicalId:'synthetic_doc',product:'doc'},content:{data:{nodeId:'synthetic_doc',resourceType:'adoc',revision:'r1',markdown:text,complete:true,hasMore:false,nextCursor:null,...extra}}});
it('only reviewed stable IDs and typed selections can reach the CLI; URL, title, flags and dangerous payload paths are rejected',()=>{
 for(const nodeId of ['https://alidocs.dingtalk.com/i/nodes/synthetic_doc','项目周报','--profile','../synthetic_doc','synthetic_doc;id'])expect(documentReadSchema.safeParse({...args(),nodeId}).success).toBe(false);
 for(const extra of [{yes:true},{argv:['doc','+access-grant']},{profile:'foreign:user'},{password:'synthetic-secret'}])expect(documentReadSchema.safeParse({...args(),...extra}).success).toBe(false);
 for(const nodePointer of ['/__proto__/x','/constructor','/data/~2bad','data/nodeId'])expect(documentPayloadProfile.safeParse({...profile,nodePointer}).success).toBe(false);
 expect(documentReadSchema.safeParse({...args(),selector:{kind:'RANGE',start:5,end:2}}).success).toBe(false);
});
it('invocation complete never promotes unknown/partial upstream coverage or a selected fragment to document/corpus completeness',()=>{
 const full=projectDocument(response('甲😀乙\n结论'),args(),profile);expect(full).toMatchObject({status:'OK',completeness:'COMPLETE',projection:{population:'ONE_DOCUMENT_VERSION',rangeUnit:'UNICODE_CODE_POINTS',documentComplete:true}});
 const fragment=projectDocument(response('甲😀乙\n结论'),args({kind:'RANGE',start:1,end:3}),profile);expect(fragment.projection.fragments[0]).toMatchObject({start:1,end:3,text:'😀乙'});expect(fragment.completeness).toBe('TRUNCATED');
 expect(projectDocument(response('text',{complete:false,hasMore:true,nextCursor:'unconsumed'}),args(),profile).completeness).toBe('TRUNCATED');
 expect(projectDocument(response('text'),args(),{...profile,completePointer:null,hasMorePointer:null,cursorPointer:null}).completeness).toBe('UNKNOWN');
 expect(()=>projectDocument(response('text',{nodeId:'foreign'}),args(),profile)).toThrow('DWS_DOCUMENT_TARGET_MISMATCH');expect(()=>projectDocument(response('text',{resourceType:'dlink'}),args(),profile)).toThrow('DWS_DOCUMENT_TARGET_MISMATCH');
 expect(()=>projectDocument({...response('text'),content:{document:{name:'metadata only'}}},args(),profile)).toThrow();
 expect(()=>projectDocument({...response('text'),content:{...response('text').content,error:{message:'failed'}}},args(),profile)).toThrow('DWS_DOCUMENT_PAYLOAD_FAILED');
});
it('secret spans are masked before range/keyword/byte clipping, with original Unicode offsets and hashes retained',()=>{
 const value='SYNTHETIC_DOC_PRIVATE_CREDENTIAL_0123456789',text='😀前文 access_token='+value+' 后文',start=Array.from(text.slice(0,text.indexOf(value))).length;
 for(const selector of [{kind:'RANGE',start,end:start+8},{kind:'RANGE',start:start+5,end:start+18},{kind:'FULL',maxCharacters:start+10}] as DocumentRead['selector'][]){const r=projectDocument(response(text),args(selector),profile);expect(JSON.stringify(r)).not.toContain(value);expect(r.projection.fragments.some(f=>f.redacted)).toBe(true);for(const f of r.projection.fragments)expect(f.end).toBeGreaterThanOrEqual(f.start);}
 const single=projectDocument(response(text),args({kind:'RANGE',start:start+2,end:start+3}),profile).projection.fragments[0]!;expect(single.text).toBe('█');expect(single.contentHash).toBe(hash('█'));expect(single.contentHash).not.toBe(hash(Array.from(text)[start+2]!));expect(single).not.toHaveProperty('originalHash');expect(projectDocument(response(text),args({kind:'KEYWORD',query:value,context:4,limit:1}),profile).projection.totalMatches).toBe(0);
 const keyword=projectDocument(response(text),args({kind:'KEYWORD',query:'access_token',context:100,limit:1}),profile);expect(keyword.projection.fragments[0]!.redacted).toBe(true);expect(JSON.stringify(keyword)).not.toContain(value);
 const long='a'.repeat(8000)+'汉'.repeat(2650)+' password='+value,r=projectDocument(response(long),args({kind:'FULL',maxCharacters:12000}),profile);expect(r.projection.fragments[0]!.redacted).toBe(true);expect(Buffer.byteLength(r.projection.fragments[0]!.text)).toBeLessThanOrEqual(16000);expect(JSON.stringify(r)).not.toContain(value);expect(r.completeness).toBe('TRUNCATED');
});
it('empty documents and bounded keyword matches preserve explicit empty/partial semantics without reversed ranges',()=>{
 expect(projectDocument(response(''),args(),profile)).toMatchObject({status:'EMPTY',completeness:'COMPLETE'});expect(projectDocument(response(''),args({kind:'RANGE',start:0,end:1}),profile).projection.fragments[0]).toMatchObject({start:0,end:0,text:''});expect(()=>projectDocument(response(''),args({kind:'RANGE',start:5,end:6}),profile)).toThrow('DWS_DOCUMENT_RANGE_OUTSIDE_OBSERVATION');
 const r=projectDocument(response('hit xx hit yy hit'),args({kind:'KEYWORD',query:'hit',context:0,limit:1}),profile);expect(r.projection.totalMatches).toBe(3);expect(r.projection.fragments).toHaveLength(1);expect(r.completeness).toBe('TRUNCATED');expect(projectDocument(response('text'),args({kind:'KEYWORD',query:'absent',context:0,limit:1}),profile).status).toBe('EMPTY');
});
