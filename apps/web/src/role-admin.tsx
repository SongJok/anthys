import React from 'react';
import {RoleAdminFlow,RoleAdminFailure,canManageRole,canRenewRole,type AssignInput,type RoleAdminOperation,type RoleName,type ScopeKind} from './role-admin-flow.js';
const roleLabels:Record<string,string>={TENANT_ADMIN:'企业配置管理员',ACTION_APPROVER:'动作审批',SECURITY_OPERATOR:'安全处理'};
const scopeLabels:Record<string,string>={TENANT:'企业',CAPABILITY:'能力',CONNECTOR:'连接器',RESOURCE:'资源',TASK:'任务',USER:'指定用户'};
const states:Record<string,string>={ACTIVE:'有效',EXPIRED:'已到期',REVOKED:'已撤销'};
export function RoleAdmin({csrf,onSessionLost}:{csrf:string;onSessionLost:()=>void}){return <RoleAdminSession key={csrf} csrf={csrf} onSessionLost={onSessionLost}/>;}
function RoleAdminSession({csrf,onSessionLost}:{csrf:string;onSessionLost:()=>void}){
 const [flow]=React.useState(()=>new RoleAdminFlow(async(path,body,requestId)=>{
  const response=await fetch('/api/v1/permissions'+path,{credentials:'same-origin',cache:'no-store',...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':requestId!},body:JSON.stringify(body)})});
  if(!response.ok)throw new RoleAdminFailure(response.status);
  return (await response.json() as {data:unknown}).data;
 }));
 const [,render]=React.useReducer(n=>n+1,0),[target,setTarget]=React.useState(''),[bindingId,setBindingId]=React.useState(''),[operation,setOperation]=React.useState<Exclude<RoleAdminOperation,'assign'>>('renew'),[reference,setReference]=React.useState(''),[expiry,setExpiry]=React.useState(''),[notice,setNotice]=React.useState('');
 const [assignTarget,setAssignTarget]=React.useState(''),[assignRole,setAssignRole]=React.useState<RoleName>('ACTION_APPROVER'),[assignScope,setAssignScope]=React.useState<ScopeKind>('CAPABILITY'),[assignScopeId,setAssignScopeId]=React.useState(''),[assignExpiry,setAssignExpiry]=React.useState(''),[assignReference,setAssignReference]=React.useState('');
 const mounted=React.useRef(true),lost=React.useRef(onSessionLost);lost.current=onSessionLost;
 function clearSelectedForm(){setReference('');setExpiry('');setOperation('renew');}
 function clearAssignForm(){setAssignTarget('');setAssignRole('ACTION_APPROVER');setAssignScope('CAPABILITY');setAssignScopeId('');setAssignExpiry('');setAssignReference('');}
 async function list(cursor?:string){
  if(flow.busy)return;clearSelectedForm();setNotice('正在核对企业角色绑定…');
  const pending=flow.load({...(target.trim()?{targetUserId:target.trim()}:{}),...(bindingId.trim()?{id:bindingId.trim()}:{})},cursor);render();const result=await pending;
  if(mounted.current&&result){setNotice(result.notice);render();if(result.sessionLost){setTarget('');setBindingId('');lost.current();}}
 }
 React.useEffect(()=>{
  mounted.current=true;void list();const visibility=()=>{flow.clear();clearSelectedForm();clearAssignForm();setTarget('');setBindingId('');setNotice('页面可见性已变化，旧资料已清除；请明确重新加载角色。');render();};document.addEventListener('visibilitychange',visibility);
  return()=>{mounted.current=false;flow.clear();document.removeEventListener('visibilitychange',visibility);};
 },[flow]);
 function filter(kind:'target'|'binding',value:string){flow.clear();clearSelectedForm();setNotice('筛选条件已变化，请加载角色。');if(kind==='target')setTarget(value);else setBindingId(value);render();}
 function choose(id:string){flow.select(id);clearSelectedForm();setNotice('请核对所选角色记录；续期或撤销只改变企业角色绑定，不代表平台权限。');render();}
 function prepare(event:React.FormEvent){
  event.preventDefault();if(flow.busy)return;
  let expiresAt:string|undefined;
  try{if(operation==='renew')expiresAt=new Date(expiry).toISOString();}catch{setNotice('请填写有效的新到期时间。');return;}
  setNotice(flow.prepare(operation,reference,expiresAt).notice);render();
 }
 function prepareAssign(event:React.FormEvent){
  event.preventDefault();if(flow.busy)return;
  let expiresAt:string;
  try{expiresAt=new Date(assignExpiry).toISOString();}catch{setNotice('请填写有效的到期时间。');return;}
  const input:AssignInput={targetUserId:assignTarget.trim(),roleName:assignRole,scopeKind:assignScope,scopeId:assignScopeId.trim(),expiresAt,reviewReference:assignReference};
  setNotice(flow.prepareAssign(input).notice);render();
 }
 async function confirm(){
  if(flow.busy)return;const pending=flow.confirm();clearSelectedForm();clearAssignForm();setNotice('正在提交本次确认，不会自动重发。');render();const result=await pending;
  if(mounted.current&&result){setNotice(result.notice);render();if(result.sessionLost){setTarget('');setBindingId('');lost.current();}}
 }
 const intent=flow.intent,selected=flow.selected,receipt=flow.receipt,disabled=flow.busy||!!intent;
 return <section aria-label="管理员角色分配"><h3>管理员角色分配</h3><p>这里只展示企业角色绑定元数据，不包含私人内容；群治理不在本组件内。平台权限尚未核实，管理资格、最后管理员限制与范围条件由服务端核对。</p>{notice&&<p role="status">{notice}</p>}
 <form aria-label="筛选角色绑定" onSubmit={event=>{event.preventDefault();void list();}}><label htmlFor="role-admin-target">目标用户 UUID（可选）</label><input id="role-admin-target" value={target} onChange={e=>filter('target',e.target.value)} disabled={disabled}/><label htmlFor="role-admin-binding">角色记录 UUID（可选）</label><input id="role-admin-binding" value={bindingId} onChange={e=>filter('binding',e.target.value)} disabled={disabled}/><button disabled={disabled}>加载角色</button></form>
 {!flow.busy&&!flow.items.length&&!receipt&&<p>没有可展示的角色绑定，请核对筛选条件与管理资格。</p>}
 {flow.items.map(item=><article key={item.id} aria-label={'角色记录 '+item.id}><p>记录：{item.id}</p><p>目标用户：{item.targetUserId}</p><p>角色：{roleLabels[item.roleName]??item.roleName} · 范围：{scopeLabels[item.scopeKind]??item.scopeKind}</p><p>范围对象：{item.scopeId}{item.scopeTruncated?'（已截断）':''}</p><p>记录状态：{states[item.state]} · 版本 {item.version}</p><p>角色到期：{item.expiresAt??'未登记'}</p>{canManageRole(item)?<button disabled={disabled} onClick={()=>choose(item.id)}>选择此角色记录</button>:<p>此记录不可直接续期或撤销：需为完整、未撤销的受管绑定。</p>}</article>)}
 {flow.nextCursor&&<button disabled={disabled} onClick={()=>void list(flow.nextCursor!)}>下一页角色</button>}
 {selected&&!intent&&<form aria-label="管理所选角色" onSubmit={prepare}><h4>管理所选角色</h4><p>记录：{selected.id} · 目标用户：{selected.targetUserId} · 版本 {selected.version}</p><label htmlFor="role-admin-operation">角色操作</label><select id="role-admin-operation" value={operation} disabled={flow.busy} onChange={e=>setOperation(e.target.value as Exclude<RoleAdminOperation,'assign'>)}><option value="renew">续期</option><option value="revoke">撤销</option></select>{operation==='renew'&&<><label htmlFor="role-admin-expiry">新到期时间</label><input id="role-admin-expiry" type="datetime-local" value={expiry} onChange={e=>setExpiry(e.target.value)} required disabled={flow.busy}/></>}{operation==='renew'&&!canRenewRole(selected)&&<p>仅有效且完整的受管绑定可以续期。</p>}<label htmlFor="role-admin-reference">审核引用</label><input id="role-admin-reference" value={reference} onChange={e=>setReference(e.target.value)} required maxLength={128} pattern="[A-Za-z0-9][A-Za-z0-9_.:\-]*" disabled={flow.busy}/><p>审核引用仅填写审批编号，不填写私人内容。</p><button disabled={flow.busy}>核对变更</button><button type="button" disabled={flow.busy} onClick={()=>{flow.cancel();clearSelectedForm();render();}}>取消选择</button></form>}
 {!intent&&<form aria-label="分配角色" onSubmit={prepareAssign}><h4>分配角色</h4><label htmlFor="role-assign-target">目标用户 UUID</label><input id="role-assign-target" value={assignTarget} onChange={e=>setAssignTarget(e.target.value)} required disabled={disabled}/><label htmlFor="role-assign-role">可分配角色</label><select id="role-assign-role" value={assignRole} onChange={e=>setAssignRole(e.target.value as RoleName)} disabled={disabled}><option value="ACTION_APPROVER">动作审批</option><option value="SECURITY_OPERATOR">安全处理</option><option value="TENANT_ADMIN">企业配置管理员</option></select><label htmlFor="role-assign-scope">范围类型</label><select id="role-assign-scope" value={assignScope} onChange={e=>setAssignScope(e.target.value as ScopeKind)} disabled={disabled}>{Object.entries(scopeLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select><label htmlFor="role-assign-scope-id">范围对象</label><input id="role-assign-scope-id" value={assignScopeId} onChange={e=>setAssignScopeId(e.target.value)} required maxLength={512} disabled={disabled}/><p>企业、任务与指定用户范围填写 UUID；能力、连接器与资源范围填写已登记标识。</p><label htmlFor="role-assign-expiry">到期时间</label><input id="role-assign-expiry" type="datetime-local" value={assignExpiry} onChange={e=>setAssignExpiry(e.target.value)} required disabled={disabled}/><label htmlFor="role-assign-reference">审核引用</label><input id="role-assign-reference" value={assignReference} onChange={e=>setAssignReference(e.target.value)} required maxLength={128} pattern="[A-Za-z0-9][A-Za-z0-9_.:\-]*" disabled={disabled}/><p>新分配有效期不超过 366 天；平台权限仍需独立核实。</p><button disabled={flow.busy}>核对分配</button></form>}
 {intent&&<aside aria-label="确认角色变更"><h4>{intent.operation==='assign'?'确认分配角色':intent.operation==='renew'?'确认续期':'确认撤销角色'}</h4>{intent.operation==='assign'?<><p>目标用户：{intent.body.targetUserId}</p><p>角色：{roleLabels[intent.body.roleName]} · 范围：{scopeLabels[intent.body.scopeKind]}</p><p>范围对象：{intent.body.scopeId}</p><p>到期时间：{intent.body.expiresAt}</p></>:<><p>记录：{intent.item.id}</p><p>目标用户：{intent.item.targetUserId}</p><p>角色：{roleLabels[intent.item.roleName]} · 范围：{scopeLabels[intent.item.scopeKind]}</p><p>预期记录版本：{intent.body.version}</p>{intent.operation==='renew'&&<p>新到期时间：{intent.body.expiresAt}</p>}</>}<p>审核引用：{intent.body.reviewReference}</p><p>本次操作仅更改企业角色绑定。平台权限和群治理仍需独立核实；现有会话可能需要重新登录。</p><button disabled={flow.busy} onClick={()=>void confirm()}>{intent.operation==='assign'?'确认分配':intent.operation==='renew'?'确认续期':'确认撤销角色'}</button><button className="quiet" disabled={flow.busy} onClick={()=>{flow.cancel();clearSelectedForm();clearAssignForm();setNotice('已取消，未提交变更。');render();}}>取消变更</button></aside>}
 {receipt&&<aside aria-label="角色变更回执"><h4>操作意图回执</h4><p>逻辑回执：{states[receipt.state]} · 版本 {receipt.version}</p><p>角色：{roleLabels[receipt.roleName]} · 范围：{scopeLabels[receipt.scopeKind]}</p>{receipt.replayed&&<p>这是历史操作意图的重放回执，不能据此认定当前绑定有效。</p>}<h4>回执时记录状态</h4><p>记录状态：{states[receipt.currentState]} · 版本 {receipt.currentVersion}</p><p>此处仅为企业角色绑定状态，平台权限尚未核实；不会恢复任务或执行业务动作。</p></aside>}
 </section>;
}
