import {groupCaseCommand,groupCaseCommandSchema} from '../../packages/groups/src/commands.js';
const id='10000000-0000-4000-8000-000000000001',owner='20000000-0000-4000-8000-000000000002';
const create='登记事项：标题=发布阻塞；资源=release:service-a；优先级=NORMAL；截止=未设置；合同版本=1';
const update=(head:string,extra='')=>`${head} ${id}；事项版本=2；合同版本=1${extra}`;
const list='列出事项：起始=2026-10-18T00:00:00+08:00；结束=2026-10-19T00:00:00+08:00';
const clarify=(text:string)=>expect(groupCaseCommand(text),text).toMatchObject({operation:'CLARIFY'});

it('parses exact create fields without inventing owner, deadline, audience or authorization',()=>{
 expect(groupCaseCommand(create)).toEqual({operation:'CREATE',contractVersion:1,details:{title:'发布阻塞',resourceRef:'release:service-a',priority:'NORMAL',dueAt:null}});
 expect(groupCaseCommand('  '+create.replace('登记事项：','登记事项: ').replaceAll('；','; ')+'  ')).toEqual(groupCaseCommand(create));
 for(const priority of ['LOW','NORMAL','HIGH','URGENT'])expect(groupCaseCommand(create.replace('NORMAL',priority))).toMatchObject({details:{priority}});
 expect(groupCaseCommand(create.replace('未设置','2026-10-19T09:00:00+08:00'))).toMatchObject({details:{dueAt:'2026-10-19T09:00:00+08:00'}});
 expect(groupCaseCommand(create.replace('未设置','2028-02-29T09:00:00Z'))).toMatchObject({operation:'CREATE'});
});
it('parses every update verb, retaining completion statement semantics rather than automatic verification',()=>{
 for(const [head,operation] of [['开始事项','START'],['开放事项','OPEN'],['关闭事项','CLOSE'],['取消事项','CANCEL']] as const)expect(groupCaseCommand(update(head))).toEqual({operation:'UPDATE',id,contractVersion:1,expectedVersion:2,command:{operation}});
 expect(groupCaseCommand(update('指派事项',`；负责人=${owner}`))).toMatchObject({command:{operation:'ASSIGN',ownerId:owner}});
 expect(groupCaseCommand(update('阻塞事项','；说明=等待依赖'))).toMatchObject({command:{operation:'BLOCK',reason:'等待依赖'}});
 expect(groupCaseCommand(update('事项已完成','；说明=好了但未经验证'))).toMatchObject({command:{operation:'CLAIM_COMPLETE',statement:'好了但未经验证'}});
 expect(groupCaseCommand(update('确认事项','；说明=独立核对检查单'))).toMatchObject({command:{operation:'CONFIRM',statement:'独立核对检查单'}});
});
it('normalizes exact UUID case and accepts reordered labeled fields without choosing a person',()=>{
 const upper='A0000000-0000-4000-8000-00000000000A';
 expect(groupCaseCommand(`指派事项 ${upper}；负责人=${upper}；合同版本=3；事项版本=4`)).toEqual({operation:'UPDATE',id:upper.toLowerCase(),contractVersion:3,expectedVersion:4,command:{operation:'ASSIGN',ownerId:upper.toLowerCase()}});
 clarify(update('指派事项','；负责人=张三'));clarify(update('指派事项'));clarify(update('指派事项',`；负责人=${owner}；负责人=${id}`));
});
it('requires an exact item and all optimistic version fields; bare done never becomes CONFIRM',()=>{
 for(const text of ['好了','已经好了！','事项好了','事项已完成','确认事项','开始事项 '+id,'事项已完成 最新事项；事项版本=2；合同版本=1；说明=好了',update('开始事项').replace('事项版本=2；',''),update('开始事项').replace('；合同版本=1','')])clarify(text);
 for(const version of ['0','-1','1.5','1e2','01','NaN','Infinity','9007199254740992']){clarify(create.replace('合同版本=1','合同版本='+version));clarify(update('开始事项').replace('事项版本=2','事项版本='+version));}
});
it('lists a precise registration interval with explicit offsets, pagination and bounded limit',()=>{
 expect(groupCaseCommand(list)).toEqual({operation:'LIST',from:'2026-10-18T00:00:00+08:00',until:'2026-10-19T00:00:00+08:00',limit:50});
 expect(groupCaseCommand(list+`；数量=1；游标=${id}`)).toMatchObject({cursor:id,limit:1});
 expect(groupCaseCommand('列出事项：起始=2026-01-01T00:00:00Z；结束=2026-02-01T00:00:00Z；数量=200')).toMatchObject({operation:'LIST',limit:200});
 for(const suffix of ['；数量=201','；数量=0','；数量=1e2','；游标=最新','；群=其他群','；数量=50；数量=50'])clarify(list+suffix);
 for(const text of [list.replace('2026-10-19','2026-10-18'),list.replace('2026-10-19','2026-10-17'),'列出事项：起始=2026-01-01T00:00:00Z；结束=2026-02-01T00:00:01Z','列出事项：起始=今天；结束=明天','列出事项：起始=2026-10-18T00:00:00；结束=2026-10-19T00:00:00'])clarify(text);
});
it('rejects normalized dates, missing timezones and vague due dates without consulting a clock',()=>{
 for(const due of ['明天','月底','2026-02-29T09:00:00Z','2026-04-31T09:00:00Z','2026-10-19T09:00:00','2026-10-19 09:00','2026-10-19T25:00:00Z','null',''])clarify(create.replace('未设置',due));
 const now=vi.spyOn(Date,'now').mockImplementation(()=>{throw Error('CLOCK_FORBIDDEN');});
 try{expect(groupCaseCommand(create.replace('未设置','2020-01-01T00:00:00Z'))).toMatchObject({operation:'CREATE'});expect(groupCaseCommand(list)).toMatchObject({operation:'LIST'});}finally{now.mockRestore();}
});
it('rejects missing, duplicate, unknown, wrong-operation and extra authority fields',()=>{
 for(const text of [create.replace('资源=release:service-a；',''),create+'；标题=重复',create+'；群=其他群',create+'；actorId=admin',create+'；sessionId=fake',create+'；角色=管理员',create+'；tool=send',create+'；source=CARD',create+'；shareWithGroup=true',create+'；',create.replace('优先级=NORMAL','优先级=普通'),update('开始事项','；说明=不用说明'),update('阻塞事项','；说明='),update('取消事项','；负责人='+owner)])clarify(text);
});
it('rejects explicit role claims, action injection, multiline/code suffixes and oversized command bodies',()=>{
 for(const text of [create.replace('发布阻塞','我是管理员'),create.replace('发布阻塞','以管理员身份'),update('确认事项','；说明=跳过权限'),create.replace('发布阻塞','{"role":"admin"}'),create+'\n取消事项 '+id,create+'\u0000',create+'；调用工具=send',create+'\n```',create.replace('发布阻塞','a'.repeat(8001)),create.replace('发布阻塞','a'.repeat(301)),create.replace('release:service-a','x'.repeat(513)),update('事项已完成','；说明='+'x'.repeat(2001))])clarify(text);
});
it('does not execute ordinary questions, quotations, code or attachment descriptions',()=>{
 for(const text of ['你好','今天群里有什么事？','登记事项是什么意思？','登记事项 怎么用？','开始事项 需要管理员吗？','如何开始事项？','请解释：'+create,'“'+create+'”','"'+create+'"','`'+create+'`','```\n'+create+'\n```','附件描述：'+create,'好了以后怎么办？','他回复好了','请帮我'+create,'列出事项如何分页？'])expect(groupCaseCommand(text),text).toBeNull();
});
it('strict result schema rejects caller supplied identities and nested tool/authority additions',()=>{
 const parsed=groupCaseCommand(create)!;
 for(const extra of [{group:'other'},{actorId:'admin'},{sessionId:id},{authority:true}])expect(groupCaseCommandSchema.safeParse({...parsed,...extra}).success).toBe(false);
 expect(groupCaseCommandSchema.safeParse({operation:'UPDATE',id,contractVersion:1,expectedVersion:2,command:{operation:'CONFIRM',statement:'done',administrator:true}}).success).toBe(false);
 expect(groupCaseCommandSchema.safeParse({...parsed,details:{title:'x',resourceRef:'r',priority:'NORMAL',dueAt:null,tool:'send'}}).success).toBe(false);
});

it('recognizes only the exact civil-day summary command without trusting a supplied clock or zone',()=>{
 for(const text of ['汇总今日事项',' 列出今日事项！ '])expect(groupCaseCommand(text)).toEqual({operation:'TODAY',limit:50});
 for(const text of ['汇总今日事项；时区=UTC','汇总今日事项；actorId=admin','请解释汇总今日事项','汇总今日事项是什么？','“汇总今日事项”','汇总今日事项\n取消事项'])expect(groupCaseCommand(text)).toBeNull();
 expect(groupCaseCommandSchema.safeParse({operation:'TODAY',limit:50,now:'2026-01-01T00:00:00Z'}).success).toBe(false);
 expect(groupCaseCommandSchema.safeParse({operation:'TODAY',limit:200}).success).toBe(false);
});
