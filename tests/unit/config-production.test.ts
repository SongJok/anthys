import {config,secret} from '../../packages/config/src/index.js';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'anthys-config-'));
const mount=(name:string,value:string)=>{const path=join(dir,name);writeFileSync(path,value,{mode:0o600});return path;};
afterAll(()=>rmSync(dir,{recursive:true,force:true}));
const strong='synthetic-production-value-0123456789abcdef',strongSecrets={DATABASE_URL_FILE:mount('database_url',strong),QUEUE_DATABASE_URL_FILE:mount('queue_database_url',strong),APP_MASTER_KEY_FILE:mount('app_master_key',strong),SESSION_SECRET_FILE:mount('session_secret',strong)};
describe('production configuration accepts only mounted, strong, https-bound values',()=>{
 it('accepts a safe origin with strong mounted secrets and defaults the rest',()=>{
  const parsed=config({APP_ENV:'production',APP_ORIGIN:'https://anthys.example.com',...strongSecrets});
  expect(parsed).toMatchObject({APP_ENV:'production',APP_ORIGIN:'https://anthys.example.com',PORT:64700,MOCK_PROVIDERS:'false',RELEASE_PROFILE:'ENTERPRISE_DWS'});
 });
 it('rejects weak or placeholder mounted secrets regardless of length',()=>{
  for(const value of [strong.slice(0,31),'changeme'.padEnd(40,'x'),'default-value'.padEnd(40,'x'),'password-value'.padEnd(40,'x'),'test-value'.padEnd(40,'x')])expect(()=>config({APP_ENV:'production',APP_ORIGIN:'https://anthys.example.com',...strongSecrets,DATABASE_URL_FILE:mount('weak_database_url',value)})).toThrow('INVALID_SECRET:DATABASE_URL');
 });
 it('rejects inline secrets and a local origin without the production mounts',()=>{
  const inline={DATABASE_URL:strong,QUEUE_DATABASE_URL:strong,APP_MASTER_KEY:strong,SESSION_SECRET:strong};
  expect(()=>config({APP_ENV:'production',APP_ORIGIN:'https://anthys.example.com',...inline})).toThrow('PRODUCTION_SECRET_MOUNT_REQUIRED');
  for(const origin of ['https://localhost','https://127.0.0.1','https://anthys.example.invalid','http://anthys.example.com'])expect(()=>config({APP_ENV:'production',APP_ORIGIN:origin,...strongSecrets})).toThrow('UNSAFE_PRODUCTION_CONFIG');
  expect(()=>config({APP_ENV:'production',APP_ORIGIN:'https://anthys.example.com',MOCK_PROVIDERS:'true',...strongSecrets})).toThrow('UNSAFE_PRODUCTION_CONFIG');
 });
 it('reads mounted files first, trims them and falls back to canonical then legacy names',()=>{
  expect(secret('DINGTALK_CLIENT_SECRET',{DINGTALK_CLIENT_SECRET:'inline-canonical',DINGTALK_CLIENT_SECRET_FILE:mount('dingtalk_client_secret','  mounted-canonical\n')})).toBe('mounted-canonical');
  expect(secret('DINGTALK_CLIENT_SECRET',{DINGTALK_CLIENT_SECRET:'inline-canonical',DINGTALK_APP_SECRET:'inline-legacy'})).toBe('inline-canonical');
  expect(secret('DINGTALK_CLIENT_SECRET',{DINGTALK_APP_SECRET_FILE:mount('dingtalk_app_secret','mounted-legacy\n')})).toBe('mounted-legacy');
  expect(secret('GLM_API_KEY',{GLM_API_KEY_FILE:mount('glm_api_key','mounted-model-key\n'),AIDER_AI_DEFAULT_API_KEY:'inline-legacy'})).toBe('mounted-model-key');
  expect(secret('GLM_MODEL',{})).toBeUndefined();
 });
});
