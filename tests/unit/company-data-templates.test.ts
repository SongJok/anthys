import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {companyDataContractHash,companyDataToolSchemaHash,dataAggregateResultSchema,dataMetricsSchema,dataQuerySchema,dataWireArguments} from '../../packages/company/src/data-contracts.js';
import {companyDataContractFileSchema} from '../../packages/company/src/data-configuration.js';
import {exactCountSum,exactDecimalEqual,exactRate,parseExactCount,RateDecimal} from '../../packages/company/src/data-numeric.js';
import {aggregatePaymentAttempts,assertExecutableDataTemplate,dataTemplateHash,dataTemplateSchema,loadDataTemplates,requireDataTemplate,type GoldenPaymentEvent} from '../../packages/company/src/data-templates.js';
const root=fileURLToPath(new URL('../..',import.meta.url)),registryDirectory=join(root,'config/data-templates'),window={start:'2026-10-12T16:00:00.000Z',end:'2026-10-13T16:00:00.000Z'};
const rows:GoldenPaymentEvent[]=[
 {eventId:'e01',attemptId:'a1',tenantId:'A',departmentId:'d_pay',eventTime:'2026-10-12T16:00:00.000Z',channel:'app',status:'success',valid:true},
 {eventId:'e02',attemptId:'a1',tenantId:'A',departmentId:'d_pay',eventTime:'2026-10-12T16:00:01.000Z',channel:'app',status:'success',valid:true},
 {eventId:'e03',attemptId:'a2',tenantId:'A',departmentId:'d_pay',eventTime:'2026-10-12T16:01:00.000Z',channel:'app',status:'failed',valid:true},
 {eventId:'e04',attemptId:'a3',tenantId:'A',departmentId:'d_pay',eventTime:'2026-10-13T15:59:59.000Z',channel:'web',status:'success',valid:true},
 {eventId:'e05',attemptId:'a4',tenantId:'A',departmentId:'d_pay',eventTime:'2026-10-13T16:00:00.000Z',channel:'app',status:'success',valid:true},
 {eventId:'e06',attemptId:'a5',tenantId:'A',departmentId:'d_pay',eventTime:'2026-10-12T15:59:59.000Z',channel:'app',status:'success',valid:true},
 {eventId:'e07',attemptId:'a6',tenantId:'A',departmentId:'d_pay',eventTime:'2026-10-13T04:00:00.000Z',channel:'web',status:'unknown',valid:true},
 {eventId:'e08',attemptId:'a7',tenantId:'A',departmentId:'d_other',eventTime:'2026-10-13T04:01:00.000Z',channel:'app',status:'success',valid:true},
 {eventId:'e09',attemptId:'a8',tenantId:'B',departmentId:'d_pay',eventTime:'2026-10-13T04:02:00.000Z',channel:'app',status:'failed',valid:true},
 {eventId:'e10',attemptId:'a9',tenantId:'A',departmentId:'d_pay',eventTime:'2026-10-13T04:03:00.000Z',channel:'app',status:'success',valid:false},
 {eventId:'e11',attemptId:'a10',tenantId:'A',departmentId:'d_pay',eventTime:'2026-10-13T04:04:00.000Z',channel:'app',status:'success',valid:true},
];
function rejection(run:()=>void,code:string):void{
 try{run();}catch(error){expect(error).toMatchObject({code});return;}throw Error('EXPECTED_'+code);
}
describe('T083/T084/T086/T087 certified data template and golden oracle',()=>{
 it('loads the certified payments template and pins the reviewed contract, tool and registry hashes',async()=>{
  const registry=await loadDataTemplates(registryDirectory),template=requireDataTemplate(registry,'payments.success_rate_daily','1.0.0'),contract=companyDataContractFileSchema.parse(JSON.parse(await readFile(join(root,'config/company-data-contract.json'),'utf8')));
  expect(template).toMatchObject({status:'CERTIFIED',version:'1.0.0',certification:{liveStatus:'UNVERIFIED'}});
  expect(contract.contractHash).toBe(companyDataContractHash);expect(contract.inputSchemaHash).toBe(companyDataToolSchemaHash);expect(contract.templateRegistryHash).toBe(registry.registryHash);
  expect(contract.server).toEqual({name:'anthys-company-data-proxy',version:'1.0.0'});expect(contract.selectedUpstreamTool).toBe('chat');
  expect(contract.templateFiles).toEqual([{key:template.key,version:template.version,hash:dataTemplateHash(template)}]);
  const query=dataQuerySchema.parse({...window,templateKey:template.key,templateVersion:template.version});
  expect(dataWireArguments(template,'INLINE_DEFINITION',query)).toMatchObject({definition:template,parameters:window});
  expect(dataWireArguments(template,'KEY_ONLY',query)).not.toHaveProperty('definition');
  rejection(()=>requireDataTemplate(registry,'payments.unknown','1.0.0'),'COMPANY_DATA_TEMPLATE_UNKNOWN');
 });
 it('rejects DRAFT or uncertified templates, unknown fields and user supplied raw SQL parameters',async()=>{
  const registry=await loadDataTemplates(registryDirectory),template=requireDataTemplate(registry,'payments.success_rate_daily','1.0.0');
  for(const status of ['DRAFT','VALIDATED','APPROVED','PUBLISHED','DEPRECATED','REVOKED'] as const)rejection(()=>assertExecutableDataTemplate({...template,status}),'COMPANY_DATA_TEMPLATE_NOT_CERTIFIED');
  const {certification:ignored,...uncertified}=template;void ignored;rejection(()=>assertExecutableDataTemplate(uncertified),'COMPANY_DATA_TEMPLATE_NOT_CERTIFIED');
  expect(dataTemplateSchema.safeParse({...template,sql:'SELECT * FROM payments'}).success).toBe(false);
  const rawParameter={...template.parameters,properties:{...template.parameters.properties,sql:{type:'string',format:'date-time'}}};
  expect(dataTemplateSchema.safeParse({...template,parameters:rawParameter}).success).toBe(false);
  expect(dataQuerySchema.safeParse({...window,templateKey:template.key,templateVersion:template.version,rawSql:'SELECT 1'}).success).toBe(false);
  expect(dataQuerySchema.safeParse({...window,templateKey:template.key,templateVersion:template.version,tenantId:'B'}).success).toBe(false);
  rejection(()=>assertExecutableDataTemplate({...template,execution:{...template.execution,operation:'arbitrary-sql'}}),'COMPANY_DATA_TEMPLATE_OPERATION_INVALID');
  rejection(()=>assertExecutableDataTemplate({...template,parameters:{...template.parameters,properties:{...template.parameters.properties,table:{type:'string',enum:['payments']}}}}),'COMPANY_DATA_TEMPLATE_PARAMETERS_INVALID');
 });
 it('T083 computes the documented oracle from fixed rows: attempts=5, success=3, rate=0.6',()=>{
  const result=aggregatePaymentAttempts(rows,{...window,tenantId:'A',departmentId:'d_pay'});
  expect(result).toEqual({attempts:'5',successes:'3',successRate:'0.6',byChannel:[{channel:'app',attempts:'3',successes:'2',successRate:'0.666666666667'},{channel:'web',attempts:'2',successes:'1',successRate:'0.5'}]});
  expect(`${result.successes}/${result.attempts}`).toBe('3/5');
 });
 it('T084 keeps the window right-open, counts the duplicate attempt once and enforces the server row scope',()=>{
  const result=aggregatePaymentAttempts(rows,{...window,tenantId:'A',departmentId:'d_pay'});
  expect(rows.filter(row=>row.attemptId==='a1')).toHaveLength(2);expect(result.attempts).toBe('5');
  expect(aggregatePaymentAttempts(rows,{...window,tenantId:'A',departmentId:'d_pay'}).byChannel.find(channel=>channel.channel==='web')).toMatchObject({attempts:'2',successes:'1'});
  expect(aggregatePaymentAttempts([rows.find(row=>row.eventId==='e04')!],{...window,tenantId:'A',departmentId:'d_pay'})).toMatchObject({attempts:'1',successes:'1'});
  expect(aggregatePaymentAttempts([rows.find(row=>row.eventId==='e05')!],{...window,tenantId:'A',departmentId:'d_pay'})).toMatchObject({attempts:'0',successes:'0',successRate:null});
  expect(aggregatePaymentAttempts([rows.find(row=>row.eventId==='e06')!],{...window,tenantId:'A',departmentId:'d_pay'})).toMatchObject({attempts:'0',successRate:null});
  expect(aggregatePaymentAttempts([rows.find(row=>row.eventId==='e01')!],{...window,tenantId:'A',departmentId:'d_pay'}).attempts).toBe('1');
  expect(aggregatePaymentAttempts(rows,{...window,tenantId:'B',departmentId:'d_pay'})).toMatchObject({attempts:'1',successes:'0'});
  expect(aggregatePaymentAttempts(rows,{...window,tenantId:'A',departmentId:'d_other'})).toMatchObject({attempts:'1',successes:'1'});
  const scoped=aggregatePaymentAttempts(rows,{...window,tenantId:'A',departmentId:'d_pay',channel:'app'});
  expect(scoped).toMatchObject({attempts:'3',successes:'2',byChannel:[{channel:'app'}]});
 });
 it('T086 aggregates channels from deduped attempts instead of averaging channel rates',()=>{
  const result=aggregatePaymentAttempts(rows,{...window,tenantId:'A',departmentId:'d_pay'}),average=(2/3+1/2)/2;
  expect(result.successRate).toBe('0.6');expect(Number(result.successRate)).not.toBe(average);
  expect(exactCountSum(result.byChannel.map(channel=>channel.attempts))).toBe(result.attempts);
  expect(exactCountSum(result.byChannel.map(channel=>channel.successes))).toBe(result.successes);
 });
 it('T087 returns NULL for a zero denominator and preserves exact large integers and decimal rates',()=>{
  expect(aggregatePaymentAttempts([],{...window,tenantId:'A',departmentId:'d_pay'})).toEqual({attempts:'0',successes:'0',successRate:null,byChannel:[]});
  expect(parseExactCount('9007199254740993')).toBe('9007199254740993');expect(exactCountSum(['9007199254740993','1'])).toBe('9007199254740994');
  expect(exactRate('9007199254740993','18014398509481986')).toBe('0.5');expect(exactRate('1','10')).toBe('0.1');expect(exactRate('0','0')).toBeNull();
  expect(new RateDecimal('0.1').plus('0.2').toFixed()).toBe('0.3');expect(exactDecimalEqual('0.1','0.100')).toBe(true);expect(exactDecimalEqual('0.6666666666666666',exactRate('2','3')!)).toBe(false);
  expect(dataMetricsSchema.safeParse({attempts:'9007199254740993',successes:'1',successRate:exactRate('1','9007199254740993'),byChannel:[{channel:'app',attempts:'9007199254740993',successes:'1',successRate:exactRate('1','9007199254740993')}]}).success).toBe(true);
  expect(dataMetricsSchema.safeParse({attempts:'5',successes:'3',successRate:'0.6',byChannel:[{channel:'app',attempts:'2',successes:'2',successRate:'1'},{channel:'web',attempts:'2',successes:'1',successRate:'0.5'}]}).success).toBe(false);
  expect(dataMetricsSchema.safeParse({attempts:'2',successes:'1',successRate:'0.5',byChannel:[]}).success).toBe(false);
  expect(dataAggregateResultSchema.safeParse({queryId:'not-a-uuid',window:{...window,interval:'[start,end)'},watermark:new Date().toISOString(),observedAt:new Date().toISOString(),completeness:'COMPLETE',metrics:{attempts:'0',successes:'0',successRate:null,byChannel:[]}}).success).toBe(false);
 });
});
