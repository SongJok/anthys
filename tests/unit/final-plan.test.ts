import {parseFinalPlan,readFinalPointer,safeSocialReply,assertNoUnbackedActionProse} from '../../packages/runtime/src/final-plan.js';
it('plain conversation is only a parse representation, never authority for arbitrary business text',()=>{
 expect(parseFinalPlan('hello')).toMatchObject({mode:'CONVERSATION',text:'hello'});expect(safeSocialReply('你好','您好！')).toBe(true);expect(safeSocialReply('请通知收件人','收件人那边现在能看到通知了')).toBe(false);expect(safeSocialReply('你好，请发消息','你好')).toBe(false);expect(safeSocialReply('hello','Hello. Notification delivered.')).toBe(false);
});
it('malformed/oversized plans and undeclared fields fail without being reinterpreted as ordinary text',()=>{
 for(const value of ['{broken','{"schemaVersion":1}',JSON.stringify({schemaVersion:1,mode:'REPORT',text:'',claims:[],outcome:'COMPLETE',extra:true}),JSON.stringify({schemaVersion:1,mode:'REPORT',text:'',claims:[{kind:'VALUE',ref:{kind:'TOOL_CALL',id:'x'},pointer:'/x',expected:1,coverage:'ALL'}],outcome:'COMPLETE'}),'x'.repeat(96001)])expect(()=>parseFinalPlan(value)).toThrow();
});
it('JSON Pointer resolves only present own properties, including escaped keys and array indices',()=>{
 const data={'a/b':{'x~y':[0,6,false,null]}};expect(readFinalPointer(data,'/a~1b/x~0y/1')).toBe(6);expect(readFinalPointer(data,'')).toBe(data);expect(readFinalPointer(data,'/a~1b/x~0y/2')).toBe(false);expect(readFinalPointer(data,'/a~1b/x~0y/3')).toBeNull();
 for(const pointer of ['a','/~2','/missing','/__proto__','/constructor','/a~1b/x~0y/length/value','/a~1b/x~0y/9'])expect(()=>readFinalPointer(data,pointer)).toThrow();expect(()=>readFinalPointer({u:undefined},'/u')).toThrow();
});
it('the supplementary action-prose guard rejects common direct promises after Unicode normalization',()=>{
 for(const text of ['我会每天提醒你','已创建待办','I have sent the message','Ｉ have sent the message','已\u200b发送通知'])expect(()=>assertNoUnbackedActionProse(text)).toThrow();expect(()=>assertNoUnbackedActionProse('来源记录尚待核对。')).not.toThrow();
});
