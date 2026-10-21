import {readFileSync} from 'node:fs';
import {z} from 'zod';
export function loadEnvFile(): void {if(process.env['OA_TEST_ISOLATED']==='true'||process.env['VITEST']==='true'||Reflect.get(globalThis,Symbol.for('open_aider.reviewedRuntimeEnvironment'))===true)return;try {process.loadEnvFile('.env');} catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e;}}
const aliases:Readonly<Record<string,string>>={DINGTALK_CLIENT_ID:'DINGTALK_APP_KEY',DINGTALK_CLIENT_SECRET:'DINGTALK_APP_SECRET',GLM_API_KEY:'AIDER_AI_DEFAULT_API_KEY',GLM_BASE_URL:'AIDER_AI_DEFAULT_BASE_URL',GLM_MODEL:'AIDER_AI_DEFAULT_MODEL'};
export function secret(name:string, env:NodeJS.ProcessEnv=process.env):string|undefined {
  for(const candidate of [name,aliases[name]].filter((s):s is string=>!!s)) {
    const path=env[`${candidate}_FILE`];if(path) return readFileSync(path,'utf8').trim();
  }
  return env[name]?.trim()|| (aliases[name]?env[aliases[name]!]?.trim():undefined);
}

const schema=z.object({
  APP_ENV:z.enum(['development','test','production']).default('development'),
  HOST:z.enum(['127.0.0.1','0.0.0.0']).default('127.0.0.1'),
  APP_ORIGIN:z.url().default('http://localhost:52330'),PORT:z.coerce.number().int().min(1).max(65535).default(52330),
  RELEASE_PROFILE:z.enum(['BASE','ENTERPRISE_DWS']).default('ENTERPRISE_DWS'),
  GLM_MODEL:z.literal('glm-5.3-flash').default('glm-5.3-flash'),
  GLM_BASE_URL:z.url().default('https://open.bigmodel.cn/api/paas/v4'),
  MOCK_PROVIDERS:z.enum(['true','false']).default('false'),
  DINGTALK_REPLY_ONLY:z.enum(['true','false']).default('false'),
  DWS_ENABLED:z.enum(['true','false']).default('false')
});
export function config(env:NodeJS.ProcessEnv=process.env) {
  const c=schema.parse({...env,GLM_BASE_URL:secret('GLM_BASE_URL',env),GLM_MODEL:secret('GLM_MODEL',env)});
  if(process.versions.node!=='24.21.0' && env['ALLOW_TOOLCHAIN_DRIFT']!=='true') throw new Error('NODE_VERSION_MISMATCH');
  if(c.APP_ENV==='production') {
    const u=new URL(c.APP_ORIGIN);
    if(u.protocol!=='https:'||u.hostname.endsWith('.invalid')||['localhost','127.0.0.1'].includes(u.hostname)||c.MOCK_PROVIDERS==='true') throw new Error('UNSAFE_PRODUCTION_CONFIG');
    for(const n of ['DATABASE_URL','QUEUE_DATABASE_URL','APP_MASTER_KEY','SESSION_SECRET']) {
      const s=secret(n,env);
      if(!s||s.length<32||/^(changeme|default|password|test)/i.test(s)) throw new Error(`INVALID_SECRET:${n}`);
    }
    if(!env['APP_MASTER_KEY_FILE']||!env['SESSION_SECRET_FILE']) throw new Error('PRODUCTION_SECRET_MOUNT_REQUIRED');
  }
  return c;
}
export type Config=ReturnType<typeof config>;
