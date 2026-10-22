import React from 'react';
import {DataTemplateAdminFlow,DataTemplateAdminFailure,canRollbackTemplate,type DataTemplateVersion} from './data-template-admin-flow.js';
const publication=(value:string)=>new Date(value).toLocaleString('zh-CN');
export function DataTemplateAdmin({csrf,onSessionLost}:{csrf:string;onSessionLost:()=>void}){return <DataTemplateAdminSession key={csrf} csrf={csrf} onSessionLost={onSessionLost}/>;}
function DataTemplateAdminSession({csrf,onSessionLost}:{csrf:string;onSessionLost:()=>void}){
 const [flow]=React.useState(()=>new DataTemplateAdminFlow(async(path,body,requestId)=>{
  const response=await fetch('/api/v1'+path,{credentials:'same-origin',cache:'no-store',...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':requestId!},body:JSON.stringify(body)})});
  if(!response.ok)throw new DataTemplateAdminFailure(response.status);
  return (await response.json() as {data:unknown}).data;
 }));
 const [,render]=React.useReducer(n=>n+1,0),[notice,setNotice]=React.useState('');
 const [templateKey,setTemplateKey]=React.useState(''),[templateVersion,setTemplateVersion]=React.useState(''),[publishReview,setPublishReview]=React.useState(''),[rollbackReview,setRollbackReview]=React.useState('');
 const mounted=React.useRef(true),lost=React.useRef(onSessionLost);lost.current=onSessionLost;
 function clearDrafts(){setTemplateKey('');setTemplateVersion('');setPublishReview('');setRollbackReview('');}
 async function load(){
  if(flow.busy)return;clearDrafts();setNotice('正在核对企业数据模板登记…');
  const pending=flow.load();render();const result=await pending;
  if(mounted.current&&result){setNotice(result.notice);render();if(result.sessionLost)lost.current();}
 }
 React.useEffect(()=>{
  mounted.current=true;void load();
  const visibility=()=>{flow.clear();clearDrafts();setNotice('页面可见性已变化，旧模板资料已清除；请明确重新加载登记。');render();};
  document.addEventListener('visibilitychange',visibility);
  return()=>{mounted.current=false;flow.clear();document.removeEventListener('visibilitychange',visibility);};
 },[flow]);
 function choose(item:DataTemplateVersion){flow.select(item.templateKey,item.templateVersion);setRollbackReview('');setNotice('请核对目标版本与当前生效记录；回退只改变本地登记，不读取或写入业务数据。');render();}
 function preparePublish(event:React.FormEvent){event.preventDefault();if(flow.busy)return;setNotice(flow.preparePublish({templateKey:templateKey.trim(),templateVersion:templateVersion.trim(),reviewReference:publishReview}).notice);render();}
 function prepareRollback(event:React.FormEvent){event.preventDefault();if(flow.busy)return;setNotice(flow.prepareRollback(rollbackReview).notice);render();}
 async function confirm(){
  if(flow.busy)return;const pending=flow.confirm();clearDrafts();setNotice('正在提交本次确认，不会自动重发。');render();const result=await pending;
  if(mounted.current&&result){setNotice(result.notice);render();if(result.sessionLost)lost.current();}
 }
 const intent=flow.intent,selected=flow.selected,receipt=flow.receipt,disabled=flow.busy||!!intent;
 return <section aria-label="管理员数据模板"><h3>管理员数据模板</h3><p>这里只登记企业已本地认证的数据模板生效版本，不包含 SQL、行范围、凭据或私人内容。模板定义仍来自受审的文件登记；平台认证与真实数据尚未核实。</p>{notice&&<p role="status">{notice}</p>}
 <button disabled={disabled} onClick={()=>void load()}>加载模板登记</button>
 {!flow.busy&&!flow.items.length&&!receipt&&<p>没有可展示的模板登记，请核对管理资格或先发布已认证版本。</p>}
 {flow.items.map(item=><article key={item.templateKey+'@'+item.templateVersion} aria-label={'模板版本 '+item.templateKey+'@'+item.templateVersion}><p>模板：{item.templateKey} · 版本 {item.templateVersion}</p><p>内容哈希：{item.templateHash}</p><p>认证引用：{item.certificationReference}</p><p>登记时间：{publication(item.publishedAt)}</p><p>{item.active?'当前生效 · 记录版本 '+item.activeRevision:item.activeVersion?'非当前生效 · 当前生效 '+item.activeVersion+' · 记录版本 '+item.activeRevision:'尚未设置生效版本'}</p>{canRollbackTemplate(item)?<button disabled={disabled} onClick={()=>choose(item)}>选择回退至此版本</button>:<p>此版本不可回退：需已登记且非当前生效，并存在当前生效记录。</p>}</article>)}
 {flow.truncated&&<p>登记超过展示上限，请通过服务端核对完整列表。</p>}
 {selected&&!intent&&<form aria-label="回退数据模板" onSubmit={prepareRollback}><h4>回退数据模板</h4><p>目标版本：{selected.templateKey}@{selected.templateVersion}</p><p>当前生效：{selected.activeVersion} · 记录版本 {selected.activeRevision}</p><label htmlFor="data-template-rollback-review">审核引用</label><input id="data-template-rollback-review" value={rollbackReview} onChange={e=>setRollbackReview(e.target.value)} required maxLength={255} disabled={flow.busy}/><p>审核引用仅填写审批编号，不填写私人内容。</p><button disabled={flow.busy}>核对回退</button><button type="button" className="quiet" disabled={flow.busy} onClick={()=>{flow.cancel();clearDrafts();setNotice('已取消选择，未提交变更。');render();}}>取消选择</button></form>}
 {!intent&&<form aria-label="发布数据模板" onSubmit={preparePublish}><h4>发布数据模板</h4><label htmlFor="data-template-key">模板标识</label><input id="data-template-key" value={templateKey} onChange={e=>setTemplateKey(e.target.value)} required maxLength={128} disabled={flow.busy}/><label htmlFor="data-template-version">模板版本</label><input id="data-template-version" value={templateVersion} onChange={e=>setTemplateVersion(e.target.value)} required maxLength={32} disabled={flow.busy}/><label htmlFor="data-template-publish-review">审核引用</label><input id="data-template-publish-review" value={publishReview} onChange={e=>setPublishReview(e.target.value)} required maxLength={255} disabled={flow.busy}/><p>仅可发布已通过本地认证登记且尚未发布的版本；服务端会复核文件哈希与黄金用例，不会访问上游数据。</p><button disabled={flow.busy}>核对发布</button></form>}
 {intent&&<aside aria-label="确认数据模板变更"><h4>{intent.operation==='publish'?'确认发布模板':'确认回退模板'}</h4><p>模板：{intent.body.templateKey} · 版本：{intent.body.templateVersion}</p>{intent.operation==='rollback'&&<p>预期记录版本：{intent.body.expectedRevision}</p>}<p>审核引用：{intent.body.reviewReference}</p><p>本次操作仅更改本企业已认证模板的生效版本；不会访问上游数据，平台认证与真实数据尚未核实。</p><button disabled={flow.busy} onClick={()=>void confirm()}>{intent.operation==='publish'?'确认发布':'确认回退'}</button><button className="quiet" disabled={flow.busy} onClick={()=>{flow.cancel();clearDrafts();setNotice('已取消，未提交变更。');render();}}>取消变更</button></aside>}
 {receipt&&<aside aria-label="数据模板变更回执"><h4>操作回执</h4><p>操作：{receipt.operation==='PUBLISH'?'发布':'回退'} · 模板：{receipt.templateKey} · 版本 {receipt.templateVersion}</p><p>逻辑回执生效版本：{receipt.activeVersion} · 记录版本 {receipt.activeRevision}</p>{receipt.replayed?<p>这是历史操作意图的重放回执，不能据此认定当前生效版本。</p>:<p>回执只证明本次意图已记录，不证明模板仍为当前生效版本。</p>}<h4>回执时登记状态</h4><p>当前生效版本：{receipt.currentActiveVersion??receipt.activeVersion} · 记录版本 {receipt.currentActiveRevision??receipt.activeRevision}</p><p>此处仅为企业模板登记状态，平台认证与真实数据尚未核实；不会访问或修改业务数据。</p></aside>}
 </section>;
}
