import React from 'react';
import {PermissionAdminFlow,PermissionAdminFailure,canManage,type AdminOperation} from './permission-admin-flow.js';
const labels={ACTIVE:'有效',EXPIRED:'已到期',REVOKED:'已撤销'};
export function PermissionAdmin({csrf,onSessionLost}:{csrf:string;onSessionLost:()=>void}){return <AdminSession key={csrf} csrf={csrf} onSessionLost={onSessionLost}/>;}
function AdminSession({csrf,onSessionLost}:{csrf:string;onSessionLost:()=>void}){
 const [flow]=React.useState(()=>new PermissionAdminFlow(async(path,body,requestId)=>{
  const response=await fetch('/api/v1/permissions'+path,{credentials:'same-origin',cache:'no-store',...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':requestId!},body:JSON.stringify(body)})});
  if(!response.ok)throw new PermissionAdminFailure(response.status);
  return (await response.json() as {data:unknown}).data;
 }));
 const [,render]=React.useReducer(n=>n+1,0),[target,setTarget]=React.useState(''),[grantId,setGrantId]=React.useState(''),[operation,setOperation]=React.useState<AdminOperation>('renew'),[reference,setReference]=React.useState(''),[expiry,setExpiry]=React.useState(''),[notice,setNotice]=React.useState('');
 const mounted=React.useRef(true),lost=React.useRef(onSessionLost);lost.current=onSessionLost;
 function clearForm(){setReference('');setExpiry('');setOperation('renew');}
 async function list(cursor?:string){
  if(flow.busy)return;clearForm();setNotice('正在核对企业策略记录…');
  const pending=flow.load({...(target.trim()?{targetUserId:target.trim()}:{}),...(grantId.trim()?{id:grantId.trim()}:{})},cursor);render();const result=await pending;
  if(mounted.current&&result){setNotice(result.notice);render();if(result.sessionLost){setTarget('');setGrantId('');lost.current();}}
 }
 React.useEffect(()=>{
  mounted.current=true;void list();const visibility=()=>{flow.clear();clearForm();setTarget('');setGrantId('');setNotice('页面可见性已变化，旧资料已清除；请明确重新加载策略。');render();};document.addEventListener('visibilitychange',visibility);
  return()=>{mounted.current=false;flow.clear();document.removeEventListener('visibilitychange',visibility);};
 },[flow]);
 function filter(kind:'target'|'grant',value:string){flow.clear();clearForm();setNotice('筛选条件已变化，请加载策略。');if(kind==='target')setTarget(value);else setGrantId(value);render();}
 function choose(id:string){flow.select(id);clearForm();setNotice('请核对所选记录；续期或撤销只改变企业策略，不代表平台权限。');render();}
 function prepare(event:React.FormEvent){
  event.preventDefault();if(flow.busy)return;
  let expiresAt:string|undefined;
  try{if(operation==='renew')expiresAt=new Date(expiry).toISOString();}catch{setNotice('请填写有效的新到期时间。');return;}
  setNotice(flow.prepare(operation,reference,expiresAt).notice);render();
 }
 async function confirm(){
  if(flow.busy)return;const pending=flow.confirm();clearForm();setNotice('正在提交本次确认，不会自动重发。');render();const result=await pending;
  if(mounted.current&&result){setNotice(result.notice);render();if(result.sessionLost){setTarget('');setGrantId('');lost.current();}}
 }
 const intent=flow.intent,selected=flow.selected,receipt=flow.receipt,disabled=flow.busy||!!intent;
 return <section aria-label="管理员资源策略"><h3>管理员资源策略</h3><p>这里只展示企业策略元数据，不包含姓名或私人内容。平台权限尚未核实；管理资格与资源条件由服务端核对。</p>{notice&&<p role="status">{notice}</p>}
 <form aria-label="筛选资源策略" onSubmit={event=>{event.preventDefault();void list();}}><label htmlFor="admin-target">目标用户 UUID（可选）</label><input id="admin-target" value={target} onChange={e=>filter('target',e.target.value)} disabled={disabled}/><label htmlFor="admin-grant">策略记录 UUID（可选）</label><input id="admin-grant" value={grantId} onChange={e=>filter('grant',e.target.value)} disabled={disabled}/><button disabled={disabled}>加载策略</button></form>
 {!flow.busy&&!flow.items.length&&!receipt&&<p>没有可展示的策略记录，请核对筛选条件与管理资格。</p>}
 {flow.items.map(item=><article key={item.id} aria-label={'策略记录 '+item.id}><p>记录：{item.id}</p><p>目标用户：{item.targetUserId}</p><p>能力：{item.capabilityId} · {item.capabilityVersion??'版本未登记'}</p><p>资源：{item.resourceId}{item.resourceTruncated?'（已截断）':''}</p><p>记录状态：{labels[item.state]} · 版本 {item.version}</p><p>策略到期：{item.expiresAt}</p>{canManage(item)?<button disabled={disabled} onClick={()=>choose(item.id)}>选择此策略</button>:<p>此记录不可直接续期或撤销：需为完整、未撤销的受管策略。</p>}</article>)}
 {flow.nextCursor&&<button disabled={disabled} onClick={()=>void list(flow.nextCursor!)}>下一页策略</button>}
 {selected&&!intent&&<form aria-label="管理所选策略" onSubmit={prepare}><h4>管理所选策略</h4><p>记录：{selected.id} · 目标用户：{selected.targetUserId} · 版本 {selected.version}</p><label htmlFor="admin-operation">策略操作</label><select id="admin-operation" value={operation} disabled={flow.busy} onChange={e=>setOperation(e.target.value as AdminOperation)}><option value="renew">续期</option><option value="revoke">撤销</option></select>{operation==='renew'&&<><label htmlFor="admin-expiry">新到期时间</label><input id="admin-expiry" type="datetime-local" value={expiry} onChange={e=>setExpiry(e.target.value)} required disabled={flow.busy}/></>}<label htmlFor="admin-reference">审核引用</label><input id="admin-reference" value={reference} onChange={e=>setReference(e.target.value)} required maxLength={128} pattern="[A-Za-z0-9][A-Za-z0-9_.:\-]*" disabled={flow.busy}/><p>审核引用仅填写审批编号，不填写私人内容。续期与平台授权是不同条件。</p><button disabled={flow.busy}>核对变更</button><button type="button" disabled={flow.busy} onClick={()=>{flow.cancel();clearForm();render();}}>取消选择</button></form>}
 {intent&&<aside aria-label="确认管理变更"><h4>确认{intent.operation==='renew'?'续期':'撤销'}</h4><p>记录：{intent.item.id}</p><p>目标用户：{intent.item.targetUserId}</p><p>预期记录版本：{intent.body.version}</p>{intent.operation==='renew'&&<p>新到期时间：{intent.body.expiresAt}</p>}<p>审核引用：{intent.body.reviewReference}</p><p>本次操作仅更改企业策略。平台权限仍需独立核实；现有会话可能需要重新登录。</p><button disabled={flow.busy} onClick={()=>void confirm()}>{intent.operation==='renew'?'确认续期':'确认撤销策略'}</button><button className="quiet" disabled={flow.busy} onClick={()=>{flow.cancel();clearForm();setNotice('已取消，未提交变更。');render();}}>取消变更</button></aside>}
 {receipt&&<aside aria-label="策略变更回执"><h4>操作意图回执</h4><p>逻辑回执：{labels[receipt.state]} · 版本 {receipt.version}</p>{receipt.replayed&&<p>这是历史操作意图的重放回执，不能据此认定当前策略有效。</p>}<h4>回执时记录状态</h4><p>记录状态：{labels[receipt.currentState]} · 版本 {receipt.currentVersion}</p><p>此处仅为企业策略状态，平台权限尚未核实；不会恢复任务或执行业务动作。</p></aside>}
 </section>;
}
