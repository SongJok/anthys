import React from 'react';
import './group-cases.css';
import {GroupEscalations} from './group-escalations.js';
import {flushSync} from 'react-dom';
import {GroupCasesFlow,GroupCasesFailure,localToday,localWindowInputs,localRegistrationWindow,caseActions,type GroupCase,type GroupCaseCommand,type GroupCaseOutcome} from './group-cases-flow.js';

const states={PROPOSED:'待管理员受理',OPEN:'已受理，待分派',ASSIGNED:'已分派',IN_PROGRESS:'进行中',BLOCKED:'受阻',WAITING_CONFIRMATION:'完成声明待确认',RESOLVED:'已登记完成',CLOSED:'已关闭',CANCELLED:'已取消'};
const priorities={LOW:'低',NORMAL:'普通',HIGH:'高',URGENT:'紧急'};
const actions={OPEN:'受理事项',ASSIGN:'分派负责人',START:'开始处理',BLOCK:'登记阻塞',CLAIM_COMPLETE:'声明已完成',CONFIRM:'管理员确认完成',CLOSE:'关闭事项',CANCEL:'取消事项'};
const completion={UNVERIFIED:'负责人已声明，尚未确认',OWNER_REPORTED:'按负责人自报登记完成，未经自动验证',ADMIN_CONFIRMED:'管理员已确认，未经自动验证'};
const format=(value:string)=>new Date(value).toLocaleString();
export function GroupCases({csrf,actorId}:{csrf:string;actorId:string}){return <GroupCasesSession key={csrf+':'+actorId} csrf={csrf} actorId={actorId}/>;}
function GroupCasesSession({csrf,actorId}:{csrf:string;actorId:string}){
 const [flow]=React.useState(()=>new GroupCasesFlow(async(path,request)=>{
  const response=await fetch('/api/v1'+path,{method:request.method,credentials:'same-origin',cache:'no-store',...(request.method==='GET'?{}:{headers:{'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':request.key!},body:JSON.stringify(request.body)})});
  if(!response.ok)throw new GroupCasesFailure(response.status);return (await response.json() as {data:unknown}).data;
 },actorId));
 const [group,setGroup]=React.useState(''),[notice,setNotice]=React.useState(''),[,render]=React.useReducer(n=>n+1,0),[title,setTitle]=React.useState(''),[resource,setResource]=React.useState(''),[priority,setPriority]=React.useState<'LOW'|'NORMAL'|'HIGH'|'URGENT'>('NORMAL'),[due,setDue]=React.useState(''),[share,setShare]=React.useState(false);
 const [mode,setMode]=React.useState<'today'|'custom'>('today'),[windowInputs,setWindowInputs]=React.useState(()=>localWindowInputs());
 const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
 const mounted=React.useRef(true),target=React.useRef<{group:string;mode:'today'|'custom';timezone:string;range:{from:string;until:string}}|null>(null);
 const resetDraft=React.useCallback(()=>{setTitle('');setResource('');setPriority('NORMAL');setDue('');setShare(false);},[]);
 const finish=React.useCallback(async(pending:Promise<GroupCaseOutcome|null>)=>{render();const result=await pending;if(mounted.current&&result){setNotice(result.notice);render();}},[]);
 React.useEffect(()=>{
  mounted.current=true;
  const suspend=()=>flushSync(()=>{flow.clear();resetDraft();setNotice('页面已离开或隐藏，事项正文和草稿已清除。恢复后将重新核验。');render();});
  const resume=()=>{suspend();const current=target.current;if(document.visibilityState==='visible'&&current){if(current.timezone!==Intl.DateTimeFormat().resolvedOptions().timeZone){target.current=null;setNotice('浏览器时区已变化，旧范围已清除，请核对本地与 UTC 边界后重新读取。');return;}const range=current.mode==='today'?localToday():current.range;target.current={...current,range};void finish(flow.read(current.group,range));}};
  const visibility=()=>document.visibilityState==='visible'?resume():suspend();
  document.addEventListener('visibilitychange',visibility);document.addEventListener('freeze',suspend);document.addEventListener('resume',resume);window.addEventListener('pagehide',suspend);window.addEventListener('pageshow',resume);window.addEventListener('focus',resume);
  return()=>{mounted.current=false;flow.clear();document.removeEventListener('visibilitychange',visibility);document.removeEventListener('freeze',suspend);document.removeEventListener('resume',resume);window.removeEventListener('pagehide',suspend);window.removeEventListener('pageshow',resume);window.removeEventListener('focus',resume);};
 },[flow,finish,resetDraft]);
 function changeWindow(nextMode:'today'|'custom',inputs=windowInputs){target.current=null;flow.clear();resetDraft();setMode(nextMode);setWindowInputs(inputs);setNotice('登记时间范围已变化，旧正文、负责人草稿和回执已清除，请重新读取；在途提交结果仍须另行核对，不会自动重发。');render();}
 let selected:{from:string;until:string}|null=null;
 try{selected=mode==='today'?localToday():localRegistrationWindow(windowInputs.from,windowInputs.until);}catch{/* Invalid input disables requests and clears no authority checks. */}
 async function read(event:React.FormEvent){event.preventDefault();if(flow.busy||document.visibilityState!=='visible')return;let range:{from:string;until:string};try{range=mode==='today'?localToday():localRegistrationWindow(windowInputs.from,windowInputs.until);}catch{flow.clear();resetDraft();setNotice('请输入真实有效的起止时间，终点须晚于起点，且 UTC 时差不超过31天；不存在的本地时间不能查询。');render();return;}target.current={group:group.trim(),mode,timezone,range};resetDraft();setNotice('正在核验当前群权限并读取所选登记事项…');await finish(flow.read(group.trim(),range));}
 async function create(event:React.FormEvent){event.preventDefault();if(flow.busy)return;let dueAt:string|null=null;try{dueAt=due?new Date(due).toISOString():null;}catch{setNotice('截止时间无效，请重新填写。');return;}const pending=flow.create({title,resourceRef:resource,priority,dueAt},share);resetDraft();await finish(pending);}
 const page=flow.snapshot;
 return <section className="group-cases" aria-label="群事务登记">
 <h3>群事务登记</h3><p className="scope">仅包含已登记的 @ 提交和明确共享给本群的卡片事项，不覆盖全部群聊。未接入历史或被动监听；登记与状态更新不会自动外发消息。</p>
 <form aria-label="读取群事项登记窗口" onSubmit={event=>void read(event)}><label htmlFor="case-group">管理员提供的群标识</label><input id="case-group" value={group} maxLength={512} required onChange={event=>{target.current=null;flow.clear();resetDraft();setGroup(event.target.value);setNotice('群标识已变化，旧正文、草稿和回执已清除，请重新读取。');render();}}/>
 <label htmlFor="case-window-mode">登记时间范围</label><select id="case-window-mode" value={mode} onChange={event=>changeWindow(event.target.value as 'today'|'custom')}><option value="today">今日</option><option value="custom">自定义起止时间</option></select>
 {mode==='custom'&&<div className="case-window-fields"><div><label htmlFor="case-window-from">登记起点（含，浏览器本地时间）</label><input id="case-window-from" type="datetime-local" step="60" value={windowInputs.from} required onChange={event=>changeWindow('custom',{...windowInputs,from:event.target.value})}/></div><div><label htmlFor="case-window-until">登记终点（不含，浏览器本地时间）</label><input id="case-window-until" type="datetime-local" step="60" value={windowInputs.until} required onChange={event=>changeWindow('custom',{...windowInputs,until:event.target.value})}/></div></div>}
 <p>浏览器时区：{timezone}。按事项登记时间筛选，含起点、不含终点；最多31天（31×24小时，以 UTC 时差校验）。</p>
 {selected?<p className="case-window-preview" aria-label="所选登记窗口 UTC 边界">UTC 起点（含）：{selected.from}<br/>UTC 终点（不含）：{selected.until}</p>:<p role="alert">起止时间无效：请填写真实本地时间，终点晚于起点且 UTC 时差不超过31天。</p>}
 {mode==='custom'&&<p>不存在的夏令时本地时间会拒绝；重复的本地时间按较早一次换算，请核对上述 UTC 边界。选择范围不会自动提交。</p>}
 <button disabled={flow.busy||!csrf||!group.trim()||!selected}>{mode==='today'?'读取今日登记事项':'读取所选登记事项'}</button></form>
 {notice&&<p role="status">{notice}</p>}
 {page&&<><p>群：{page.groupId} · 合同版本 {page.contractVersion} · {page.administrator?'当前具有群管理员操作资格':'按当前成员权限查看'}</p><p className="scope">{page.coverage.notice}</p><p>登记范围：{format(page.coverage.from)} 至 {format(page.coverage.until)}<br/><small>{page.coverage.from} ≤ 登记时间 &lt; {page.coverage.until}</small></p><p>第 {page.page} 页，本页 {page.items.length} 项。{page.nextCursor?'还有下一页，当前不是完整结果。':'当前查询没有后续页；这不代表全部群聊。'}</p>
 <form aria-label="明确共享卡片登记事项" onSubmit={event=>void create(event)}><h4>新建共享卡片事项</h4><label htmlFor="case-title">事项标题</label><input id="case-title" value={title} onChange={event=>setTitle(event.target.value)} required maxLength={300}/><label htmlFor="case-resource">精确资源标识</label><input id="case-resource" value={resource} onChange={event=>setResource(event.target.value)} required maxLength={512}/><p>请填写具体资源。同标题但不同资源的事项分别保留，不会按标题自动合并。</p><label htmlFor="case-priority">优先级</label><select id="case-priority" value={priority} onChange={event=>setPriority(event.target.value as typeof priority)}>{Object.entries(priorities).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select><label htmlFor="case-due">截止时间（当前浏览器时区，可不设）</label><input id="case-due" type="datetime-local" value={due} onChange={event=>setDue(event.target.value)}/><p>{due?'将按当前浏览器时区保存该截止时间。':'未设置截止时间。新事项尚无负责人。'}</p><label className="consent"><input type="checkbox" checked={share} onChange={event=>setShare(event.target.checked)}/>我确认标题、资源和内容可共享给这个群的当前成员。</label><button disabled={flow.busy||!share||!title.trim()||!resource.trim()}>登记为本群待受理事项</button></form>
 <h4>当前页事项</h4>{page.items.length===0&&<p>这个登记时间范围内当前页没有可见事项；不能据此判断群里没有其他问题。</p>}{page.items.map(item=><CaseCard key={item.id+':'+item.version} item={item} csrf={csrf} groupId={page.groupId} contractVersion={page.contractVersion} actorId={actorId} administrator={page.administrator} members={page.members} busy={flow.busy} submit={command=>{resetDraft();return finish(flow.command(item.id,command));}}/>)}
 {page.nextCursor&&<button disabled={flow.busy} onClick={()=>{resetDraft();void finish(flow.next());}}>读取下一页登记事项</button>}</>}
 {flow.receipt&&<aside aria-label="群事项逻辑回执"><h4>事项保存回执</h4><p>事项 {flow.receipt.id} · 版本 {flow.receipt.version} · {states[flow.receipt.state]}</p>{flow.receipt.replayed&&<p>这是既有请求的回执；请重新读取当前记录核对。</p>}<p>这不是外部动作执行证明；正文已清除，请重新读取。</p></aside>}
 </section>;
}
function CaseCard({item,csrf,groupId,contractVersion,actorId,administrator,members,busy,submit}:{item:GroupCase;csrf:string;groupId:string;contractVersion:number;actorId:string;administrator:boolean;members:{id:string;name:string}[];busy:boolean;submit:(command:GroupCaseCommand)=>Promise<void>}){
 const [owner,setOwner]=React.useState(''),[statement,setStatement]=React.useState(''),[reason,setReason]=React.useState(''),[escalating,setEscalating]=React.useState(false);
 const allowed=caseActions(item,actorId,administrator),person=(id:string|null)=>id?(members.find(m=>m.id===id)?.name??'当前名单中不可见的成员')+' · '+id:'未设置负责人';
 const button=(operation:'OPEN'|'START'|'CLOSE'|'CANCEL')=>allowed.includes(operation)&&<button type="button" disabled={busy} onClick={()=>void submit({operation})}>{actions[operation]}</button>;
 return <article aria-label={'群事项 '+item.title}><h4>{item.title}</h4><p>精确资源：{item.resourceRef}</p><p>状态：{states[item.state]} · 优先级：{priorities[item.priority]}</p><p>负责人：{person(item.ownerId)}<br/>截止：{item.dueAt?format(item.dueAt):'未设置截止时间'}</p><p>事项版本 {item.version} · 登记合同版本 {item.contractVersion}</p>{item.blockedReason&&<p>阻塞说明：{item.blockedReason}</p>}{item.completion&&<><p>{completion[item.completion.method]}</p><p>声明／确认人：{person(item.completion.actorId)}</p><p>声明／确认内容：{item.completion.statement}</p></>}<p>来源：{item.sources.map(source=>source.kind==='CARD'?'明确共享卡片':'已登记 @ 提交').join('、')||'未提供来源元信息'}</p>
 {button('OPEN')}{button('START')}{button('CLOSE')}{button('CANCEL')}
 {allowed.includes('ASSIGN')&&<form aria-label={'分派 '+item.title} onSubmit={event=>{event.preventDefault();if(owner&&!busy)void submit({operation:'ASSIGN',ownerId:owner});}}><label htmlFor={'case-owner-'+item.id}>从当前授权成员中选择负责人</label><select id={'case-owner-'+item.id} value={owner} onChange={event=>setOwner(event.target.value)} required disabled={busy}><option value="">请选择</option>{members.map(member=><option key={member.id} value={member.id}>{member.name} · {member.id}</option>)}</select><button disabled={busy||!owner}>确认分派负责人</button></form>}
 {allowed.includes('BLOCK')&&<form aria-label={'登记阻塞 '+item.title} onSubmit={event=>{event.preventDefault();if(reason.trim()&&!busy)void submit({operation:'BLOCK',reason});}}><label htmlFor={'case-block-'+item.id}>阻塞原因</label><textarea id={'case-block-'+item.id} value={reason} onChange={event=>setReason(event.target.value)} required maxLength={2000} disabled={busy}/><button disabled={busy||!reason.trim()}>登记阻塞</button></form>}
 {(allowed.includes('CLAIM_COMPLETE')||allowed.includes('CONFIRM'))&&<form aria-label={'完成说明 '+item.title} onSubmit={event=>{event.preventDefault();if(statement.trim()&&!busy)void submit({operation:allowed.includes('CONFIRM')?'CONFIRM':'CLAIM_COMPLETE',statement});}}><label htmlFor={'case-complete-'+item.id}>完成声明或独立确认说明</label><textarea id={'case-complete-'+item.id} value={statement} onChange={event=>setStatement(event.target.value)} required maxLength={2000} disabled={busy}/><p>负责人声明与管理员确认会分别记录，均不代表系统已自动核验外部结果。</p><button disabled={busy||!statement.trim()}>{allowed.includes('CONFIRM')?'作为管理员确认完成':'提交负责人完成声明'}</button></form>}
 {administrator&&['OPEN','ASSIGNED','IN_PROGRESS','BLOCKED'].includes(item.state)&&<><button type="button" disabled={busy} onClick={()=>setEscalating(v=>!v)}>{escalating?'收起同群升级申请':'申请此事项同群升级'}</button>{escalating&&<GroupEscalations csrf={csrf} groupId={groupId} caseId={item.id} caseVersion={item.version} contractVersion={contractVersion}/>}</>}
 </article>;
}
