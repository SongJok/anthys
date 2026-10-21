import {clarificationCommand} from '../../packages/dingtalk/src/clarification.js';
it('recognizes an explicit complete task reference without guessing a bare continuation or accepting a short identifier',()=>{
 const id='123e4567-e89b-42d3-a456-426614174000';expect(clarificationCommand('继续任务 '+id.toUpperCase()+' 12AB34cd：内部技术分享')).toEqual({taskId:id,code:'12ab34cd',text:'内部技术分享'});
 expect(clarificationCommand('继续任务 '+id+' 12ab34cd: two\nlines')).toEqual({taskId:id,code:'12ab34cd',text:'two\nlines'});
 for(const text of ['继续任务 '+id+'：缺问题编号','继续任务 123e4567 12ab34cd：回答','继续任务 '+id+'：','继续任务 --profile:回答'])expect(clarificationCommand(text)).toEqual({invalid:true});
 expect(clarificationCommand('继续任务 '+id+' 12ab34cd：'+'x'.repeat(10001))).toEqual({invalid:true});
 for(const text of ['继续','继续任务的讨论','继续 '+id+'：普通叙述'])expect(clarificationCommand(text)).toBeNull();
});
it('only the explicit question code command binds a trusted native continuation',()=>{
 expect(clarificationCommand('补充 12AB34cd：第一个')).toEqual({code:'12ab34cd',text:'第一个'});expect(clarificationCommand('补充 12ab34cd: two\nlines')).toEqual({code:'12ab34cd',text:'two\nlines'});expect(clarificationCommand('第一个')).toBeNull();expect(clarificationCommand('补充文档说明')).toBeNull();for(const text of ['补充 1234：内容','补充 12345678：','补充:evil','补充 --profile:内容'])expect(clarificationCommand(text)).toEqual({invalid:true});
});
