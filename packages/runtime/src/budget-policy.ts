import {readFileSync} from 'node:fs';
import {Decimal} from 'decimal.js';
import {z} from 'zod';
import {BudgetError} from './budget.js';
import {hash} from '../../storage/src/crypto.js';
const money=z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,8})?$/);
const positiveMoney=money.refine(v=>new Decimal(v).gt(0));
const count=z.string().regex(/^(0|[1-9]\d{0,11})$/);
const scope=z.object({tokens:count,money,concurrent:z.number().int().min(1).max(30)}).strict();
const zone=z.string().max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}});
export const modelBudgetPolicySchema=z.object({
 schemaVersion:z.literal(1),id:z.string().min(1).max(100),model:z.literal('glm-5.3-flash'),currency:z.enum(['CNY','USD']),environment:z.enum(['PRODUCTION','SYNTHETIC_TEST']),approved:z.literal(true),approvalReference:z.string().min(8).max(512),validUntil:z.iso.datetime(),dayZone:zone,
 maxInputTokens:z.number().int().min(1).max(65536),maxOutputTokens:z.number().int().min(1).max(8192),
 ceiling:z.object({inputPerMillion:positiveMoney,outputPerMillion:positiveMoney}).strict(),
 pricing:z.object({inputPerMillion:money,outputPerMillion:money,sourceReference:z.string().min(8).max(512),validFrom:z.iso.datetime(),validUntil:z.iso.datetime(),cache:z.object({inputPerMillion:money,storagePerMillionTokenHour:z.literal('0')}).strict().optional()}).strict().nullable(),
 limits:z.object({tenant:scope,department:scope,user:scope,task:scope}).strict()
}).strict().superRefine((p,ctx)=>{
 if(p.pricing&&(new Decimal(p.pricing.inputPerMillion).gt(p.ceiling.inputPerMillion)||new Decimal(p.pricing.outputPerMillion).gt(p.ceiling.outputPerMillion)||Date.parse(p.pricing.validFrom)>=Date.parse(p.pricing.validUntil)))ctx.addIssue({code:'custom',message:'INVALID_PRICING_CEILING_OR_WINDOW'});
 if(p.pricing?.cache&&new Decimal(p.pricing.cache.inputPerMillion).gt(p.pricing.inputPerMillion))ctx.addIssue({code:'custom',path:['pricing','cache'],message:'CACHE_RATE_EXCEEDS_ORDINARY_INPUT_RATE'});
});
export type ModelBudgetPolicy=z.infer<typeof modelBudgetPolicySchema>;
export function assertPolicyEnvironment(p:ModelBudgetPolicy):void{
 if(p.environment==='SYNTHETIC_TEST'&&(process.env['APP_ENV']!=='test'||process.env['OA_TEST_ISOLATED']!=='true'||Reflect.get(globalThis,Symbol.for('anthys.testNetworkGuard'))!==true))throw new BudgetError('SYNTHETIC_BUDGET_POLICY_FORBIDDEN');
}
export function loadModelBudgetPolicy(env:NodeJS.ProcessEnv=process.env):{policy:ModelBudgetPolicy|null;error:string|null}{
 const path=env['BUDGET_POLICY_FILE']?.trim();if(!path)return {policy:null,error:'MODEL_BUDGET_POLICY_UNCONFIGURED'};
 try{const bytes=readFileSync(path);if(bytes.length>1024*1024)throw Error('SIZE');const policy=modelBudgetPolicySchema.parse(JSON.parse(bytes.toString('utf8')));assertPolicyEnvironment(policy);return {policy,error:null};}catch{return {policy:null,error:'MODEL_BUDGET_POLICY_INVALID'};}
}
export function modelBudgetDiagnostic(now=Date.now()){
 const loaded=loadModelBudgetPolicy(),p=loaded.policy;
 if(!p)return {status:'BLOCKED_EXTERNAL',reason:loaded.error,providerInvoiceVerified:false};
 if(Date.parse(p.validUntil)<=now)return {status:'FAIL',reason:'MODEL_BUDGET_POLICY_EXPIRED',providerInvoiceVerified:false};
 const pricing=p.pricing&&Date.parse(p.pricing.validFrom)<=now&&Date.parse(p.pricing.validUntil)>now;
 return {status:'PASS',reason:'OFFLINE_CONFIG_VALID_NOT_PROVIDER_VERIFIED',policyHash:hash(JSON.stringify(p)),model:p.model,currency:p.currency,environment:p.environment,validUntil:p.validUntil,dayZone:p.dayZone,maxInputTokens:p.maxInputTokens,maxOutputTokens:p.maxOutputTokens,pricingStatus:pricing?'ADMIN_APPROVED_RATE_CONFIGURED':'UNCONFIRMED',providerInvoiceVerified:false};
}
