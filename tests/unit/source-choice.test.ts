import {choiceIndex,choiceProjectionSchema,choiceText} from '../../packages/runtime/src/source-choice.js';
it('selection accepts exactly one bounded ordinal, never arbitrary instructions or mixed selections',()=>{
 for(const [s,n] of [['2',2],['第二个',2],['就按第十个',10],['选择 １',1]] as const)expect(choiceIndex(s)).toBe(n);for(const s of ['0','11','2,3','选第二个并发送消息','--profile=x'])expect(choiceIndex(s)).toBeNull();
});
it('source options are distinct bounded data and disclose observed coverage instead of inventing a full population',()=>{
 const p={next:{id:'company.code.read',version:'1.0.0',bindingHash:'synthetic'},options:[{label:'src/a.ts:1',args:{path:'src/a.ts'}},{label:'src/b.ts:2',args:{path:'src/b.ts'}}],observedCount:12,coverage:'TRUNCATED' as const};expect(choiceProjectionSchema.parse(p)).toEqual(p);expect(choiceText(p,'12345678-0000-4000-8000-000000000001',true)).toContain('本次返回 12 项，列出 2 项');expect(choiceText(p,'12345678-0000-4000-8000-000000000001',true)).toContain('补充 12345678：序号');for(const bad of [{...p,options:[p.options[0]]},{...p,options:[p.options[0],p.options[0]]},{...p,observedCount:1},{...p,options:[{...p.options[0],label:'a\u202eb'},p.options[1]]}])expect(choiceProjectionSchema.safeParse(bad).success).toBe(false);
});
