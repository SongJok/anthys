import React from 'react';
import {DataResultFailure,DataResultFlow,type CertifiedDataResult} from './data-result-flow.js';
const publication=(value:string)=>new Date(value).toLocaleString('zh-CN');
const completeness:Record<string,string>={COMPLETE:'完整',TRUNCATED:'已截断',SAMPLED:'抽样'};
const classification:Record<string,string>={PUBLIC:'公开',INTERNAL:'内部',CONFIDENTIAL:'保密',RESTRICTED:'严格受限'};
export function DataResultView({csrf,onSessionLost}:{csrf:string;onSessionLost:()=>void}){return <DataResultSession key={csrf} csrf={csrf} onSessionLost={onSessionLost}/>;}
function DataResultSession({csrf,onSessionLost}:{csrf:string;onSessionLost:()=>void}){
 const [flow]=React.useState(()=>new DataResultFlow(async path=>{
  const response=await fetch('/api/v1'+path,{credentials:'same-origin',cache:'no-store',headers:{'x-csrf-token':csrf}});
  if(!response.ok)throw new DataResultFailure(response.status);
  return (await response.json() as {data:unknown}).data;
 }));
 const [,render]=React.useReducer(n=>n+1,0),[notice,setNotice]=React.useState(''),[question,setQuestion]=React.useState('');
 const mounted=React.useRef(true),lost=React.useRef(onSessionLost);lost.current=onSessionLost;
 async function load(){
  if(flow.busy)return;setQuestion('');setNotice('正在核对本账号的认证数据结果…');
  const pending=flow.load();render();const result=await pending;
  if(mounted.current&&result){setNotice(result.notice);render();if(result.sessionLost)lost.current();}
 }
 React.useEffect(()=>{
  mounted.current=true;void load();
  const visibility=()=>{flow.clear();setQuestion('');setNotice('页面可见性已变化，旧结果已清除；请明确重新加载。');render();};
  document.addEventListener('visibilitychange',visibility);
  return()=>{mounted.current=false;flow.clear();document.removeEventListener('visibilitychange',visibility);};
 },[flow]);
 function prepare(event:React.FormEvent){event.preventDefault();if(flow.busy)return;const outcome=flow.preparePending(question);setNotice(outcome.notice);render();}
 const metricOf=(result:CertifiedDataResult)=>flow.catalog.find(item=>item.templateKey===result.templateKey&&item.templateVersion===result.templateVersion)??null;
 return <section aria-label="认证数据结果"><h2>认证数据结果</h2><p>这里只展示本账号已执行并留痕的认证口径结果，不读取上游数据，也不包含 SQL、行范围规则或凭据。平台认证与真实数据尚未核实。</p>{notice&&<p role="status">{notice}</p>}
 <button disabled={flow.busy} onClick={()=>void load()}>加载认证数据结果</button>
 {!flow.busy&&!flow.results.length&&<p>没有可展示的认证数据结果；请先通过任务流程执行已认证口径。</p>}
 {flow.results.map(result=>{const conclusion=flow.conclusion(result),metric=metricOf(result);return <article key={result.queryId} aria-label={'数据结果 '+result.queryId}>
  <p>模板：{result.templateKey}@{result.templateVersion} · 口径：{metric?metric.metricName:'未登记口径'}</p>
  <p>统计定义：分子 {metric?metric.numerator:'未登记'} · 分母 {metric?metric.denominator:'未登记'} · 粒度 {metric?metric.grain.join('、'):'未登记'}</p>
  <p>时间窗口：{result.window.start} 至 {result.window.end}（{result.window.interval}）</p>
  <p>行范围：{Object.entries(result.rowScope).map(([name,value])=>name+'='+value).join('、')}</p>
  <p>数据新鲜度：水位 {result.watermark} · 观测 {result.observedAt} · 落后 {conclusion.lagMinutes} 分钟（允许上限 {conclusion.limitMinutes} 分钟）</p>
  <p>行数：{result.rowCount} · 截断状态：{completeness[result.completeness]??result.completeness} · 执行时间 {publication(result.executedAt)}</p>
  {conclusion.allowed?<p>总体结论：在上述授权行范围与时间窗口内，成功 {result.metrics.successes} / 尝试 {result.metrics.attempts}，成功率 {result.metrics.successRate??'不适用（分母为零）'}；此结论只覆盖已授权范围与该时间窗口。</p>:<><p>不能据此给出总体确定结论：{conclusion.reasons.join('；')}。</p><p>此处只展示统计口径、时间范围与数据新鲜度，不给出总体统计。</p></>}
  <p>结果等级：{classification[result.classification]??result.classification} · 上游认证未核实 · 证据引用 {result.evidenceRef}</p>
 </article>;})}
 {flow.truncated&&<p>结果超过展示上限，请通过服务端核对完整列表。</p>}
 <section aria-label="认证口径目录"><h3>认证口径目录</h3><p>目录只登记本地已认证的口径定义、粒度与新鲜度上限；平台认证与真实数据尚未核实。</p>
  {!flow.catalog.length&&<p>没有可展示的认证口径目录。</p>}
  {flow.catalog.map(item=><article key={item.templateKey+'@'+item.templateVersion} aria-label={'口径 '+item.templateKey+'@'+item.templateVersion}>
   <p>口径：{item.metricName} · 模板 {item.templateKey}@{item.templateVersion}</p>
   <p>分子：{item.numerator} · 分母：{item.denominator}</p>
   <p>粒度：{item.grain.join('、')} · 参数：{item.parameterNames.join('、')}</p>
   <p>新鲜度上限：{item.freshnessMaxMinutes} 分钟 · 最大窗口：{item.maxWindowDays} 天 · 结果等级：{classification[item.classification]??item.classification}</p>
   <p>允许角色：{item.allowedRoles.join('、')} · 认证引用：{item.certificationReference}</p>
   <p>{item.active?'当前登记生效':'尚未登记为生效版本'} · 仅本地认证 · 平台认证与真实数据尚未核实</p>
  </article>)}
 </section>
 <form aria-label="口径核对" onSubmit={prepare}><h3>业务问题核对</h3><label htmlFor="data-result-question">业务问题</label><input id="data-result-question" value={question} onChange={event=>setQuestion(event.target.value)} required maxLength={500} disabled={flow.busy}/><p>只有已认证口径才可能直接统计；没有认证模板时只生成待开发口径要素，不会返回任何数字。</p><button disabled={flow.busy}>核对口径</button></form>
 {flow.covered&&<aside aria-label="已认证口径"><h3>已认证口径</h3><p>口径：{flow.covered.metricName} · 模板版本 {flow.covered.templateVersion} · 新鲜度上限 {flow.covered.freshnessMaxMinutes} 分钟</p><p>该问题可以通过已认证口径统计，请通过任务流程执行；本页不另行统计，也不访问上游数据。</p></aside>}
 {flow.pending&&<aside aria-label="待开发口径"><h3>待开发口径</h3><p>问题：{flow.pending.question}</p><p>当前没有任何认证模板覆盖该问题，不能直接统计。以下是仍需先确定的口径要素，本页不提供任何数字，也不代替数据部门认证。</p><ul>{flow.pending.requiredElements.map(element=><li key={element}>{element}</li>)}</ul></aside>}
 </section>;
}
