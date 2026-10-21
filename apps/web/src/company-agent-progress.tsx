import React from 'react';
import {CompanyAgentProgressFlow,createEnterpriseProgressTransport,enterprisePollIntervalMs,enterpriseStateCopy,validEnterpriseTarget,type EnterpriseProgressOutcome} from './company-agent-progress-flow.js';
import './company-agent-progress.css';
export interface CompanyAgentProgressProps{taskId:string;runId:string;csrf:string;onSessionLost?:()=>void}
const time=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZoneName:'short'});
export function CompanyAgentProgress(props:CompanyAgentProgressProps){
 if(!props.csrf||!validEnterpriseTarget(props.taskId,props.runId))return null;
 return <ProgressSession key={JSON.stringify([props.csrf,props.taskId,props.runId])} {...props}/>;
}
function ProgressSession({taskId,runId,csrf,onSessionLost}:CompanyAgentProgressProps){
 const [flow]=React.useState(()=>new CompanyAgentProgressFlow(createEnterpriseProgressTransport(csrf),{taskId,runId}));
 const [,render]=React.useReducer((value:number)=>value+1,0),[notice,setNotice]=React.useState('正在读取本次运行的请求记录…'),mounted=React.useRef(true),lost=React.useRef(onSessionLost),confirmationTitle=React.useId();lost.current=onSessionLost;
 const report=(outcome:EnterpriseProgressOutcome|null)=>{if(!mounted.current||!outcome)return;setNotice(outcome.notice);if(outcome.sessionLost){flow.pause();lost.current?.();}};
 const read=async(automatic=false)=>{const result=flow.read(automatic);render();report(await result);if(mounted.current)render();};
 const stop=async()=>{const result=flow.confirmStop();render();report(await result);if(mounted.current)render();};
 React.useEffect(()=>{
  mounted.current=true;if(document.visibilityState==='visible')void read(true);
  const timer=window.setInterval(()=>{if(document.visibilityState!=='visible')return;flow.expire();if(flow.shouldPoll)void read(true);else render();},enterprisePollIntervalMs);
  const visibility=()=>{if(document.visibilityState!=='visible'){flow.clear();setNotice('页面已隐藏，旧请求记录已清除。返回后只重新读取本地状态。');render();}else void read();};
  document.addEventListener('visibilitychange',visibility);
  return()=>{mounted.current=false;flow.clear();window.clearInterval(timer);document.removeEventListener('visibilitychange',visibility);};
 },[flow]);
 const items=flow.items;
 return <section className="enterprise-progress" aria-label="企业请求等待状态" aria-busy={flow.busy}>
  <div className="enterprise-progress-heading"><div><p className="enterprise-progress-eyebrow">本次运行 · 本地状态记录</p><h3>企业请求</h3></div><button type="button" className="quiet" disabled={flow.busy} onClick={()=>void read()}>重新读取状态</button></div>
  <p className="enterprise-progress-boundary">这里只读取已经保存的请求记录，不会新提问或自动重问。企业底座可能需要较长时间；其计算进度与费用未由本页面核实。</p>
  {notice&&<p className="enterprise-progress-notice" role="status" aria-live="polite">{notice}</p>}
  {flow.pollingLimitReached&&<p className="enterprise-progress-warning">本页自动更新已到上限，已暂停轮询。这不表示任务超时、停止或完成；请手动重新读取服务端状态。</p>}
  {flow.cancellationUncertain&&<p className="enterprise-progress-warning">停止请求仍待核对，企业底座是否已停未确认。不会重复提交或自动重问，请只重新读取状态。</p>}
  {flow.fresh&&<p className="enterprise-progress-asof">状态记录截至：{time(flow.snapshot!.asOf)}</p>}
  {flow.fresh&&items.length===0&&<p>本次运行暂无可显示的请求记录，请以重新读取的服务端状态为准。</p>}
  {items.length>0&&<ul className="enterprise-progress-list">{items.map(item=><li key={item.id}><article className={'enterprise-request enterprise-request-'+item.state.toLowerCase()}>
   <div className="enterprise-request-heading"><h4>{enterpriseStateCopy[item.state].label}</h4><span>不会自动重问</span></div>
   <p>{enterpriseStateCopy[item.state].detail}</p>
   <dl className="enterprise-request-times"><div><dt>等待截止</dt><dd>{time(item.deadline)}</dd></div><div><dt>最近记录</dt><dd>{time(item.updatedAt)}</dd></div></dl>
   {Date.now()>=Date.parse(item.deadline)&&['QUEUED','DISPATCHING'].includes(item.state)&&<p className="enterprise-progress-warning">本地时钟已超过记录期限，服务端状态仍待核对，尚未据此判定到期。</p>}
   {(item.remoteCancellation==='UNCONFIRMED'||item.localCancellationRequestedAt)&&<p className="enterprise-request-cancel">已有本地停止记录或取消请求；企业底座是否已停未确认，不会自动重问。</p>}
   <details><summary>请求记录信息</summary><p>连接：{item.source.connectorId} · 工具：{item.source.toolName}</p><p className="enterprise-request-id">请求编号：{item.id}</p><p>来源回复尚未核验；收到回复不代表事实或外部动作成功。</p></details>
  </article></li>)}</ul>}
  {flow.confirmationOpen?<div className="enterprise-stop-confirm" role="group" aria-labelledby={confirmationTitle}>
   <h4 id={confirmationTitle}>确认停止本任务等待？</h4><p>只停止本任务本地等待，企业底座是否已停未确认，不会重问。</p><p>此操作会向服务端提交一次停止请求。未收到服务端确认前，不会显示停止成功。</p>
   <div><button type="button" disabled={flow.busy} onClick={()=>void stop()}>确认停止本任务等待</button><button type="button" className="quiet" onClick={()=>{flow.dismissStopConfirmation();render();}}>继续等待</button></div>
  </div>:flow.canStop&&<button type="button" className="quiet enterprise-stop-button" onClick={()=>{flow.beginStopConfirmation();render();}}>停止本任务等待</button>}
  {flow.busy&&<button type="button" className="quiet enterprise-pause-button" onClick={()=>{report(flow.pause());render();}}>停止本页等待并清除记录</button>}
 </section>;
}
