import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {modelBudgetPolicySchema,loadModelBudgetPolicy,assertPolicyEnvironment,modelBudgetDiagnostic} from '../../packages/runtime/src/budget-policy.js';
import {ModelBudget,estimateModelPayload,quotaMoney} from '../../packages/runtime/src/model-budget.js';
import {runtimeBudgetSchema} from '../../packages/runtime/src/budget.js';
const prepared=()=>JSON.parse(readFileSync(resolve('.data/test-environment/budget-policy.json'),'utf8')) as Record<string,unknown>;
afterEach(()=>vi.unstubAllEnvs());
it('cache arithmetic rounds the combined bill once and refuses unquoted or contradictory cache counts',()=>{
 const rates={inputPerMillion:'0.00000001',outputPerMillion:'0.00000001',cache:{inputPerMillion:'0.00000001',storagePerMillionTokenHour:'0' as const}};
 expect(quotaMoney(2,1,rates,1)).toBe('0.000000000001');
 for(const cached of [-1,3,0.5,Number.MAX_SAFE_INTEGER+1])expect(()=>quotaMoney(2,1,rates,cached)).toThrow('MODEL_CACHED_USAGE_INVALID');
 expect(()=>quotaMoney(2,1,{inputPerMillion:'1',outputPerMillion:'1'},1)).toThrow('MODEL_CACHE_TARIFF_UNCONFIRMED');
});
it('accepts explicitly reviewed cache pricing only with zero storage tariff and within the ordinary input ceiling; legacy serialization stays unchanged',()=>{
 const p=prepared(),pricing={inputPerMillion:'1',outputPerMillion:'1',sourceReference:'SYNTHETIC_CACHE_TARIFF',validFrom:'2000-01-01T00:00:00.000Z',validUntil:'2099-01-01T00:00:00.000Z'};
 const ordinary=modelBudgetPolicySchema.parse({...p,pricing});expect(JSON.stringify(ordinary.pricing)).toBe(JSON.stringify(pricing));
 for(const rate of ['0','0.25','1'])expect(modelBudgetPolicySchema.safeParse({...p,pricing:{...pricing,cache:{inputPerMillion:rate,storagePerMillionTokenHour:'0'}}}).success).toBe(true);
 for(const cache of [{inputPerMillion:'1.01',storagePerMillionTokenHour:'0'},{inputPerMillion:'-1',storagePerMillionTokenHour:'0'},{inputPerMillion:0.25,storagePerMillionTokenHour:'0'},{inputPerMillion:'0.25'},{inputPerMillion:'0.25',storagePerMillionTokenHour:'0.01'},{inputPerMillion:'0.25',storagePerMillionTokenHour:'0',unknown:true}])expect(modelBudgetPolicySchema.safeParse({...p,pricing:{...pricing,cache}}).success).toBe(false);
});
it('requires an explicit approved finite policy, strict scope limits and a valid currency, timezone and pricing interval',()=>{
 const p=prepared();expect(modelBudgetPolicySchema.safeParse(p).success).toBe(true);
 for(const change of [{approved:false},{currency:'XXX'},{dayZone:'Invalid/Zone'},{maxInputTokens:65537},{maxOutputTokens:8193},{extra:true},{ceiling:{inputPerMillion:'0',outputPerMillion:'1'}},{ceiling:{inputPerMillion:'NaN',outputPerMillion:'Infinity'}},{limits:{tenant:{tokens:'-1',money:'1',concurrent:31}}},{pricing:{inputPerMillion:'2',outputPerMillion:'1',sourceReference:'synthetic-source',validFrom:'2000-01-01T00:00:00.000Z',validUntil:'2099-01-01T00:00:00.000Z'}},{pricing:{inputPerMillion:'0',outputPerMillion:'0',sourceReference:'synthetic-source',validFrom:'2099-01-01T00:00:00.000Z',validUntil:'2000-01-01T00:00:00.000Z'}}])expect(modelBudgetPolicySchema.safeParse({...p,...change}).success).toBe(false);
 const base={schemaVersion:1,maxTurns:16,maxTools:24,maxActiveMs:240000};expect(runtimeBudgetSchema.safeParse(base).success).toBe(true);for(const change of [{schemaVersion:2},{maxTurns:65},{maxTools:121},{maxActiveMs:1800001},{maxActiveMs:0},{unknown:1}])expect(runtimeBudgetSchema.safeParse({...base,...change}).success).toBe(false);
});
it('a synthetic budget policy cannot authorize production or ordinary development model dispatch',()=>{
 const p=modelBudgetPolicySchema.parse(prepared());vi.stubEnv('APP_ENV','production');expect(()=>assertPolicyEnvironment(p)).toThrow('SYNTHETIC_BUDGET_POLICY_FORBIDDEN');expect(()=>new ModelBudget(p)).toThrow('SYNTHETIC_BUDGET_POLICY_FORBIDDEN');vi.stubEnv('APP_ENV','development');expect(()=>assertPolicyEnvironment(p)).toThrow('SYNTHETIC_BUDGET_POLICY_FORBIDDEN');
});
it('missing, unreadable, malformed or oversized configuration blocks dispatch while diagnostics stay usable',()=>{
 vi.stubEnv('BUDGET_POLICY_FILE','');expect(loadModelBudgetPolicy()).toEqual({policy:null,error:'MODEL_BUDGET_POLICY_UNCONFIGURED'});expect(()=>new ModelBudget().limits()).toThrow('MODEL_BUDGET_POLICY_UNCONFIGURED');expect(modelBudgetDiagnostic().status).toBe('BLOCKED_EXTERNAL');
 const dir=mkdtempSync(join(tmpdir(),'oa-budget-policy-'));try{
  const path=join(dir,'policy.json');vi.stubEnv('BUDGET_POLICY_FILE',path);expect(loadModelBudgetPolicy().error).toBe('MODEL_BUDGET_POLICY_INVALID');
  for(const content of ['not json',JSON.stringify({...prepared(),approved:false}),' '.repeat(1024*1024+1)]){writeFileSync(path,content);expect(loadModelBudgetPolicy().error).toBe('MODEL_BUDGET_POLICY_INVALID');expect(()=>new ModelBudget().limits()).toThrow('MODEL_BUDGET_POLICY_INVALID');}
  writeFileSync(path,JSON.stringify({...prepared(),validUntil:'2000-01-01T00:00:00.000Z'}));expect(modelBudgetDiagnostic()).toMatchObject({status:'FAIL',reason:'MODEL_BUDGET_POLICY_EXPIRED',providerInvoiceVerified:false});
  writeFileSync(path,JSON.stringify(prepared()));expect(modelBudgetDiagnostic()).toMatchObject({status:'PASS',pricingStatus:'UNCONFIRMED',providerInvoiceVerified:false});
  writeFileSync(path,JSON.stringify({...prepared(),pricing:{inputPerMillion:'0',outputPerMillion:'0',sourceReference:'SYNTHETIC_APPROVED_ONLY',validFrom:'2000-01-01T00:00:00.000Z',validUntil:'2099-01-01T00:00:00.000Z'}}));expect(modelBudgetDiagnostic()).toMatchObject({status:'PASS',pricingStatus:'ADMIN_APPROVED_RATE_CONFIGURED',providerInvoiceVerified:false});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it('the offline command validates the mounted file without claiming provider billing verification',()=>{
 const output=execFileSync(process.execPath,['--import','tsx','scripts/check-model-budget.ts','--file',resolve('.data/test-environment/budget-policy.json')],{encoding:'utf8'});expect(JSON.parse(output)).toMatchObject({status:'PASS',reason:'OFFLINE_CONFIG_VALID_NOT_PROVIDER_VERIFIED',providerInvoiceVerified:false});expect(output).not.toContain('pricing":');
});
it('unsupported native bodies and unserializable requests cannot obtain a misleading small quote',()=>{
 const body={model:'glm-5.3-flash',messages:[{role:'user',content:'text'}]};for(const value of [{...body,model:'another-model'},{...body,messages:[{role:'user',content:[{image_url:'synthetic'}]}]},{...body,tools:{}},undefined])expect(()=>estimateModelPayload(value as Record<string,unknown>)).toThrow();const cycle={...body,cycle:null as unknown};cycle.cycle=cycle;expect(()=>estimateModelPayload(cycle)).toThrow('MODEL_REQUEST_UNSERIALIZABLE');
});
