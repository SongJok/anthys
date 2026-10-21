import '../support/isolation.js';
import {test,expect,type Page,type Request} from '@playwright/test';
import {mkdir,readFile} from 'node:fs/promises';
type Fixture={ownerCookie:string;taskId:string;runId:string;ordinaryTaskId:string;artifactCookie:string;artifactTaskId:string;isolatedDatabase:string};
type Proof={calls:number;state:string;remoteCancellation:string;enterpriseCost:string;workerFailed:boolean};
const fixture=async(project:string)=>JSON.parse(await readFile('.data/test-environment/browser-company-agent.json','utf8'))[project] as Fixture;
const panel=(page:Page)=>page.getByRole('region',{name:'企业请求等待状态',exact:true});
async function login(page:Page,cookie:string,taskId:string){await page.context().addCookies([{name:'oa_session',value:cookie,url:'http://localhost:52339'}]);await page.goto('/tasks?task='+taskId);await expect(page.getByText('工作台已就绪',{exact:true})).toBeVisible();}
async function proof(page:Page):Promise<Proof>{const response=await page.request.get('/api/v1/browser-company-agent-proof');expect(response.status()).toBe(200);const data=(await response.json()).data as Proof;expect(data.workerFailed).toBe(false);return data;}
const layout=async(page:Page)=>expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);

test('real local API polling and confirmed cancellation retain UNKNOWN without a repeated enterprise call',async({page},info)=>{
 const f=await fixture(info.project.name);expect(f.isolatedDatabase).toMatch(/^open_aider_test_group_reminder_[a-f0-9]{32}$/);
 const enterprisePath='/api/v1/tasks/'+f.taskId+'/enterprise-requests',ordinaryPath='/api/v1/tasks/'+f.ordinaryTaskId+'/enterprise-requests';
 const reads:{status:number;state:string}[]=[],ordinaryReads:string[]=[],cancels:string[]=[];
 // Each body read is owned by the current step and completes before reload,
 // session replacement or teardown. A permanent async response listener would
 // outlive those transitions and leave rejected CDP body reads unobserved.
 // A response event observes headers, including requests the component may
 // subsequently abort while clearing stale state. Only requestfinished proves
 // the full body completed; failed/aborted reads cannot count as a 200 poll.
 const readEnterprise=()=>page.waitForEvent('requestfinished',request=>new URL(request.url()).pathname===enterprisePath&&request.method()==='GET').then(async request=>{const response=await request.response();expect(response).not.toBeNull();const body=await response!.json();const row={status:response!.status(),state:body.data.items[0]?.state as string};reads.push(row);return row;});
 const onRequest=(request:Request)=>{const path=new URL(request.url()).pathname;if(path===ordinaryPath)ordinaryReads.push(path);if(path==='/api/v1/tasks/'+f.taskId+'/cancel'&&request.method()==='POST')cancels.push(path);};
 page.on('request',onRequest);
 try{
 await login(page,f.ownerCookie,f.ordinaryTaskId);await expect(panel(page)).toHaveCount(0);
 // Wait through a real browser interval without intercepting any route.
 await page.waitForTimeout(2200);expect(ordinaryReads).toEqual([]);await layout(page);
 await Promise.all([readEnterprise(),page.locator('button.task').filter({hasText:'SYNTHETIC enterprise question'}).click()]);await expect(page).toHaveURL(new RegExp('task='+f.taskId));await expect(panel(page)).toBeVisible();
 await expect.poll(async()=>(await proof(page)).calls).toBe(1);
 await expect.poll(async()=>{await readEnterprise();return reads.filter(row=>row.status===200&&row.state==='DISPATCHING').length;}).toBeGreaterThanOrEqual(2);
 await expect(panel(page)).toContainText('等待截止');await expect(panel(page)).toContainText('状态记录截至');await expect(panel(page)).toContainText('不会新提问或自动重问');
 await expect(page.getByRole('link',{name:'群事务',exact:true})).toHaveAttribute('href','/groups');await expect(page.getByRole('button',{name:'停止任务',exact:true})).toHaveCount(0);await layout(page);
 await mkdir('reports/company-agent-browser-20261019/screenshots',{recursive:true});await panel(page).screenshot({path:'reports/company-agent-browser-20261019/screenshots/'+info.project.name+'-dispatching.png'});
 await panel(page).getByRole('button',{name:'停止本任务等待',exact:true}).click();await expect(panel(page).getByRole('group',{name:'确认停止本任务等待？',exact:true})).toContainText('只停止本任务本地等待，企业底座是否已停未确认，不会重问');expect(cancels).toHaveLength(0);
 await panel(page).getByRole('button',{name:'继续等待',exact:true}).click();expect(cancels).toHaveLength(0);
 await panel(page).getByRole('button',{name:'停止本任务等待',exact:true}).click();
 const receipt=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/tasks/'+f.taskId+'/cancel'&&response.request().method()==='POST');
 await panel(page).getByRole('button',{name:'确认停止本任务等待',exact:true}).click();const cancelled=await receipt;expect(cancelled.status()).toBe(200);expect((await cancelled.json()).data).toMatchObject({taskId:f.taskId,status:'CANCELLED',inFlightExternalActions:'MUST_RECONCILE'});expect(cancels).toHaveLength(1);
 await expect.poll(async()=>{const p=await proof(page);return {calls:p.calls,state:p.state,remoteCancellation:p.remoteCancellation,enterpriseCost:p.enterpriseCost};}).toEqual({calls:1,state:'UNKNOWN',remoteCancellation:'UNCONFIRMED',enterpriseCost:'UNKNOWN'});
 const [unknownRead]=await Promise.all([readEnterprise(),panel(page).getByRole('button',{name:'重新读取状态',exact:true}).click()]);expect(unknownRead).toEqual({status:200,state:'UNKNOWN'});await expect(panel(page)).toContainText('企业底座是否已停未确认');expect(reads.some(row=>row.status===200&&row.state==='UNKNOWN')).toBe(true);await layout(page);
 await panel(page).screenshot({path:'reports/company-agent-browser-20261019/screenshots/'+info.project.name+'-unknown.png'});
 await page.reload();await expect(panel(page)).toBeVisible();await expect(panel(page)).toContainText('企业底座是否已停未确认');const finalProof=await proof(page);expect(finalProof.calls).toBe(1);expect(cancels).toHaveLength(1);
 // A separate already-finalized source fixture checks the retained artifact
 // entry through the actual task API and component, not mocked metadata.
 await page.context().clearCookies();await login(page,f.artifactCookie,f.artifactTaskId);await expect(panel(page)).toHaveCount(0);const artifacts=page.getByRole('region',{name:'任务成果',exact:true});await expect(artifacts).toBeVisible();await expect(artifacts.getByRole('button',{name:'生成受保护成果',exact:true})).toBeEnabled();await expect(page.getByRole('link',{name:'群事务',exact:true})).toBeVisible();await layout(page);
 await artifacts.screenshot({path:'reports/company-agent-browser-20261019/screenshots/'+info.project.name+'-artifacts-retained.png'});
 }finally{page.off('request',onRequest);}
});
