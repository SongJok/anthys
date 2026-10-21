import fs from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
import net from 'node:net';import tls from 'node:tls';import http from 'node:http';import https from 'node:https';import dns from 'node:dns';import dgram from 'node:dgram';import pg from 'pg';
const roots=[process.cwd(),'/Users/tuwan/work/code/anthys/anthys','/Users/tuwan/.codex/worktrees/dm-metadata-capture/anthys'].map(p=>resolve(p));
const deny=()=>{throw Error('DM_DIAGNOSTIC_OFFLINE_IO_FORBIDDEN');};
net.Socket.prototype.connect=deny;net.Server.prototype.listen=deny;tls.connect=deny;for(const m of [http,https])for(const k of ['request','get'])m[k]=deny;globalThis.fetch=deny;dgram.createSocket=deny;
for(const k of ['lookup','lookupService','resolve','resolve4','resolve6','resolveAny','resolveCname','resolveMx','resolveNaptr','resolveNs','resolvePtr','resolveSoa','resolveSrv','resolveTxt','reverse']){dns[k]=deny;dns.promises[k]=deny;}
for(const k of ['connect','query']){pg.Client.prototype[k]=deny;pg.Pool.prototype[k]=deny;}
function allowed(value){if(typeof value==='number')return;let path;if(typeof value==='string')path=resolve(value);else if(value instanceof URL&&value.protocol==='file:')path=fileURLToPath(value);else return;if(roots.some(r=>path===r+'/.env'||path.startsWith(r+'/.env.')||path===r+'/.secrets'||path.startsWith(r+'/.secrets/')))throw Error('DM_DIAGNOSTIC_REAL_ENV_FORBIDDEN');}
for(const k of ['readFileSync','readFile','openSync','open']){const original=fs[k];fs[k]=function(path,...args){allowed(path);return Reflect.apply(original,this,[path,...args]);};}
for(const k of ['readFile','open']){const original=fs.promises[k];fs.promises[k]=async function(path,...args){allowed(path);return Reflect.apply(original,this,[path,...args]);};}
syncBuiltinESMExports();globalThis[Symbol.for('anthys.dmDiagnosticsOfflineGuard')]=true;
