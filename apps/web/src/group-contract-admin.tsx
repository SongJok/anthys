import React from 'react';
import {GroupContractAdminFlow,GroupContractAdminFailure,groupContractRequestLifetimeMs,type ContractChange} from './group-contract-admin-flow.js';
const labels={ACTIVE:'已登记启用',PAUSED:'已暂停',REVOKED:'已撤销',EXPIRED:'已到期'};
const changes={ACTIVE:'恢复',PAUSED:'暂停',REVOKED:'撤销'};
export function GroupContractAdmin({csrf,onSessionLost}:{csrf:string;onSessionLost:()=>void}){return <GroupContractSession key={csrf} csrf={csrf} onSessionLost={onSessionLost}/>;}
function GroupContractSession({csrf,onSessionLost}:{csrf:string;onSessionLost:()=>void}){
 const [flow]=React.useState(()=>new GroupContractAdminFlow(async(path,body,key)=>{
  const response=await fetch('/api/v1'+path,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(groupContractRequestLifetimeMs),...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':key!},body:JSON.stringify(body)})});
  if(!response.ok)throw new GroupContractAdminFailure(response.status);return (await response.json() as {data:unknown}).data;
 }));
 const [delegation,setDelegation]=React.useState(''),[notice,setNotice]=React.useState(''),[,render]=React.useReducer(n=>n+1,0),mounted=React.useRef(true),lost=React.useRef(onSessionLost);lost.current=onSessionLost;
 React.useEffect(()=>{mounted.current=true;const visibility=()=>{flow.clear();setDelegation('');setNotice('页面可见性已变化，旧合同资料已清除，请明确重新读取。');render();};document.addEventListener('visibilitychange',visibility);return()=>{mounted.current=false;flow.clear();document.removeEventListener('visibilitychange',visibility);};},[flow]);
 const snapshot=flow.snapshot,contract=snapshot?.contract,intent=flow.intent,receipt=flow.receipt;
 React.useEffect(()=>{
  if(!snapshot)return;let timer:ReturnType<typeof setTimeout>;
  const deadlines=[Date.parse(snapshot.authority.validUntil),...(contract&&Date.parse(contract.document.expiresAt)>Date.now()?[Date.parse(contract.document.expiresAt)]:[])];
  const check=()=>{const remaining=Math.min(...deadlines)-Date.now();if(remaining<=0){flow.clear();setDelegation('');setNotice('合同或委托期限已变化，旧资料已清除；请重新读取后核对。');render();}else timer=setTimeout(check,Math.min(remaining,2147483647));};check();return()=>clearTimeout(timer);
 },[flow,snapshot,contract]);
 async function read(event:React.FormEvent){
  event.preventDefault();if(flow.busy)return;setNotice('正在读取已有审核委托与群合同…');const pending=flow.read(delegation.trim());render();const result=await pending;
  if(mounted.current&&result){setNotice(result.notice);if(!result.ok)setDelegation('');render();if(result.sessionLost)lost.current();}
 }
 function prepare(state:ContractChange){if(flow.busy)return;setNotice(flow.prepare(state).notice);render();}
 async function confirm(){
  if(flow.busy)return;setNotice('正在提交本次状态确认，不会自动重发。');const pending=flow.confirm();render();const result=await pending;
  if(mounted.current&&result){setNotice(result.notice);if(!result.ok)setDelegation('');render();if(result.sessionLost)lost.current();}
 }
 return <section aria-label="已有群合同管理"><h3>已有群合同管理</h3><p>GROUP_ADMIN 是应用角色，不能证明外部群主或供应商授权。管理资格、精确群与服务身份仍由后端独立核对。</p><p>读取已有审核委托后，可明确确认暂停、撤销或恢复暂停合同；平台权限尚未核实。恢复不会延长期限、增加额度或补发旧动作；已撤销合同须重新取得审核委托。</p>{notice&&<p role="status">{notice}</p>}
 <form aria-label="读取已有群合同" onSubmit={event=>void read(event)}><label htmlFor="group-delegation">已审核委托 UUID</label><input id="group-delegation" value={delegation} disabled={flow.busy||!!intent} onChange={event=>{flow.clear();setDelegation(event.target.value);setNotice('委托编号已变化，旧合同资料已清除。');render();}} required/><button disabled={flow.busy||!!intent||!delegation.trim()}>读取群合同</button></form>
 {snapshot&&<article aria-label="审核委托资料"><h4>审核委托</h4><p>授权依据：REVIEWED_DELEGATION（已审核委托）</p><p>委托：{snapshot.authority.id}</p><p>群：{snapshot.authority.groupId}</p><p>管理员：{snapshot.authority.administratorId}</p><p>服务身份：{snapshot.authority.serviceIdentityId}</p><p>审核引用：{snapshot.authority.reviewReference}</p><p>委托有效至：{snapshot.authority.validUntil}</p><p>委托额度上限：{snapshot.authority.currency} {snapshot.authority.maxAmountMinor}（最小货币单位）</p><p>平台权限：尚未核实</p></article>}
 {snapshot&&!contract&&<p>此委托尚无已登记合同，不能提交状态变更。</p>}
 {contract&&<article aria-label="已有合同资料"><h4>已有合同</h4><p>合同：{contract.document.id}</p><p>合同版本：{contract.version}</p><p>合同登记状态：{labels[contract.document.state]}</p><p>合同期限：{contract.document.validFrom} 至 {contract.document.expiresAt}</p>{Date.parse(contract.document.expiresAt)<=Date.now()&&<p>合同期限已到，没有状态变更入口。</p>}<p>合同预算：{contract.document.budget.currency} {contract.document.budget.maxAmountMinor}（最小货币单位）</p><h5>职责范围</h5><ul>{contract.document.responsibilityScope.map((text,index)=><li key={index}>{text}</li>)}</ul><p>允许动作：{contract.document.actions.allowed.join('、')||'无'}</p><p>禁止动作：{contract.document.actions.prohibited.join('、')||'无'}</p><p>来源模式：{contract.document.sources.mode??'MENTION_ONLY'}</p><ul>{contract.document.sources.entries.map((entry,index)=><li key={index}>{entry.kind} · {entry.resourceRef}</li>)}</ul><p>工作时区：{contract.document.workHours.timezone}</p><p>撤销方式说明：{contract.document.revocation.method}</p>
 <button disabled={flow.busy||!!intent} hidden={!flow.canChange('PAUSED')} onClick={()=>prepare('PAUSED')}>暂停此群合同</button><button disabled={flow.busy||!!intent} hidden={!flow.canChange('ACTIVE')} onClick={()=>prepare('ACTIVE')}>恢复此暂停合同</button><button disabled={flow.busy||!!intent} hidden={!flow.canChange('REVOKED')} onClick={()=>prepare('REVOKED')}>撤销此群合同</button></article>}
 {intent&&<aside aria-label="确认群合同状态变更"><h4>确认{changes[intent.state]}群合同</h4><p>合同：{intent.snapshot.contract!.document.id}</p><p>预期合同版本：{intent.snapshot.contract!.version}</p><p>委托：{intent.snapshot.authority.id}</p><p>群：{intent.snapshot.authority.groupId}</p><p>服务身份：{intent.snapshot.authority.serviceIdentityId}</p><p>将提交{intent.state}状态。已经在途或结果未知的动作仍需独立核对；不会自动恢复、重发或补写。</p>{intent.state==='ACTIVE'&&<p>仅恢复当前暂停合同，新版本沿用既有职责、来源、期限与额度；后端会重新核对当前身份和授权。旧任务与通知不会自动恢复或补发。</p>}<button disabled={flow.busy} onClick={()=>void confirm()}>确认{changes[intent.state]}群合同</button><button className="quiet" disabled={flow.busy} onClick={()=>{flow.cancel();setNotice('已取消，未提交状态变更。');render();}}>取消状态变更</button></aside>}
 {receipt&&<aside aria-label="群合同状态回执"><h4>状态变更逻辑回执</h4><p>逻辑回执：{labels[receipt.state]} · 版本 {receipt.version}</p>{receipt.replayed&&<p>这是历史意图的重放回执，不能作为当前状态。</p>}<h4>回执时记录状态</h4><p>记录状态：{labels[receipt.currentState]} · 版本 {receipt.currentVersion}</p><p>在途或结果未知的动作仍需核对，不会补发；平台权限仍未核实。</p></aside>}
 </section>;
}
