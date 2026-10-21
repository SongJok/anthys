import {secret} from '../../packages/config/src/index.js';
if(process.env['OA_TEST_ISOLATED']!=='true')throw Error('TEST_ISOLATION_REQUIRED: use pnpm test:prepare and guarded test scripts');
if(Reflect.get(globalThis,Symbol.for('anthys.testNetworkGuard'))!==true)throw Error('TEST_NETWORK_GUARD_REQUIRED');
for(const key of ['DATABASE_URL','RUNTIME_DATABASE_URL','QUEUE_DATABASE_URL','MIGRATION_DATABASE_URL']){const url=new URL(secret(key)!);if(url.hostname!=='127.0.0.1'||url.port!=='64711'||url.pathname!=='/anthys_test')throw Error('TEST_DATABASE_TARGET_REJECTED');}
for(const key of Object.keys(process.env))if(/^(DINGTALK_|GLM_API_KEY|AIDER_AI_|DWS_)/.test(key))throw Error('TEST_PROVIDER_CREDENTIAL_INHERITED');
