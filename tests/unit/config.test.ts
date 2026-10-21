import {config} from '../../packages/config/src/index.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {randomBytes} from 'node:crypto';
describe('P00 configuration and P01 secret envelope',()=>{
 it('T122 refuses unsafe production origin, mocks and weak secrets',()=>{
  for(const env of [{APP_ORIGIN:'https://anthys.example.invalid'},{APP_ORIGIN:'http://example.com'},{APP_ORIGIN:'https://example.com',MOCK_PROVIDERS:'true'},{APP_ORIGIN:'https://example.com',APP_MASTER_KEY:'test'}]) expect(()=>config({APP_ENV:'production',...env})).toThrow();
  expect(config({}).PORT).toBe(64700);expect(()=>config({GLM_MODEL:'other'})).toThrow();
 });
 it('T125 rotates encryption keys and binds ciphertext to tenant/identity',()=>{
  const a=randomBytes(32),b=randomBytes(32),v1=new Vault(new Map([['1',a]]),'1');
  const old=v1.seal('test-private-value','tenantA:alice');
  const v2=new Vault(new Map([['1',a],['2',b]]),'2');
  expect(v2.open(old,'tenantA:alice')).toBe('test-private-value');
  expect(v2.seal('new','tenantA:alice').version).toBe('2');
  expect(()=>v2.open(old,'tenantB:alice')).toThrow();
  expect(()=>new Vault(new Map([['2',b]]),'2').open(old,'tenantA:alice')).toThrow('KEY_VERSION');
 });
});
it('supports explicitly configured legacy credential names with canonical names taking priority',async()=>{
 const {secret}=await import('../../packages/config/src/index.js');
 expect(secret('DINGTALK_CLIENT_ID',{DINGTALK_APP_KEY:'synthetic-app'})).toBe('synthetic-app');
 expect(secret('DINGTALK_CLIENT_SECRET',{DINGTALK_APP_SECRET:'synthetic-secret'})).toBe('synthetic-secret');
 expect(secret('GLM_API_KEY',{AIDER_AI_DEFAULT_API_KEY:'synthetic-model-key'})).toBe('synthetic-model-key');
 expect(secret('GLM_API_KEY',{GLM_API_KEY:'canonical-key',AIDER_AI_DEFAULT_API_KEY:'legacy-key'})).toBe('canonical-key');
 expect(config({AIDER_AI_DEFAULT_MODEL:'glm-5.3-flash',AIDER_AI_DEFAULT_BASE_URL:'https://open.bigmodel.cn/api/paas/v4'}).GLM_MODEL).toBe('glm-5.3-flash');
 expect(()=>config({AIDER_AI_DEFAULT_MODEL:'other-model'})).toThrow();
});
it('authenticated encryption rejects tampering and invalid active key material',()=>{
 const key=randomBytes(32),vault=new Vault(new Map([['one',key]]),'one'),value=vault.seal('private','tenant:actor');
 expect(()=>new Vault(new Map([['one',Buffer.alloc(31)]]),'one')).toThrow('KEY_LENGTH');
 expect(()=>new Vault(new Map([['one',key]]),'missing')).toThrow('KEY_VERSION');
 const changed={...value,tag:Buffer.alloc(16).toString('base64')};expect(()=>vault.open(changed,'tenant:actor')).toThrow();
});
it('reply-only configuration defaults off and rejects ambiguous values',()=>{
 expect(config({}).DINGTALK_REPLY_ONLY).toBe('false');
 expect(config({DINGTALK_REPLY_ONLY:'true'}).DINGTALK_REPLY_ONLY).toBe('true');
 expect(config({DINGTALK_REPLY_ONLY:'false'}).DINGTALK_REPLY_ONLY).toBe('false');
 for(const value of ['1','TRUE','yes',''])expect(()=>config({DINGTALK_REPLY_ONLY:value})).toThrow();
});
