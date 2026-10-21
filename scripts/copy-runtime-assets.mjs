import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist/packages/dws/src',{recursive:true});
await copyFile('packages/dws/src/process-supervisor.mjs','dist/packages/dws/src/process-supervisor.mjs');

await mkdir('dist/scripts',{recursive:true});
await copyFile('scripts/probe-docker-network-guard.mjs','dist/scripts/probe-docker-network-guard.mjs');
