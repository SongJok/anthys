import './dm-diagnostics-offline-guard.mjs';
import {runCaptureCli} from '../../scripts/capture-dm-metadata.js';
import {OwnedDmMetadataTransport} from '../../packages/dingtalk/src/dm-metadata-owned.js';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const [mode,trace,...args]=process.argv.slice(2),identity={corpId:'synthetic-corp',staffId:'synthetic-self',robotCode:'synthetic-robot'};
void runCaptureCli(args,{readConfig:async()=>({identity,credentials:{clientId:mode!,clientSecret:trace!}}),makeTransport:(credentials,purpose)=>{const transport=new OwnedDmMetadataTransport(credentials,new URL('./dm-metadata-child-fixture.ts',import.meta.url),purpose),start=transport.start.bind(transport);transport.start=(...input)=>{start(...input);if(!transport.ownedPid)throw Error('FIXTURE_FORK_PID_REQUIRED');writeFileSync(join(trace!,'fork-pid'),String(transport.ownedPid),{mode:0o600});};if(mode==='stop-hang')transport.stop=()=>new Promise<void>(()=>{});return transport;}}).then(code=>process.exit(code),()=>{process.stderr.write('DM_CAPTURE_FAILED\n');process.exit(1);});
