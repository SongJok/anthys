import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';import tls from 'node:tls';import http from 'node:http';import dns from 'node:dns';import dgram from 'node:dgram';import pg from 'pg';
import {resolve} from 'node:path';
import {DmDiagnosticCounters} from '../../packages/dingtalk/src/dm-metadata-diagnostics.js';
assert.equal(Reflect.get(globalThis,Symbol.for('anthys.dmDiagnosticsOfflineGuard')),true,'explicit offline preload is required');
test('offline diagnostics tests hard-reject TCP, HTTP, DNS, TLS, UDP, fetch and PG before IO',()=>{
 for(const call of [()=>net.connect(64711,'127.0.0.1'),()=>http.get('https://example.invalid'),()=>dns.lookup('example.invalid',()=>{}),()=>dns.promises.lookup('example.invalid'),()=>tls.connect(443),()=>dgram.createSocket('udp4'),()=>fetch('https://example.invalid'),()=>Reflect.apply(pg.Client.prototype.connect,{},[]),()=>Reflect.apply(pg.Pool.prototype.query,{},['SELECT 1'])])assert.throws(call,/DM_DIAGNOSTIC_OFFLINE_IO_FORBIDDEN/);
});
test('offline tests cannot read the actual project env or secret mounts',async()=>{
 for(const path of [resolve('.env'),'/Users/tuwan/work/code/anthys/anthys/.env','/Users/tuwan/.codex/worktrees/dm-metadata-capture/anthys/.env',resolve('.secrets/migration_database_url')]){assert.throws(()=>fs.readFileSync(path),/DM_DIAGNOSTIC_REAL_ENV_FORBIDDEN/);await assert.rejects(fs.promises.open(path,'r'),/DM_DIAGNOSTIC_REAL_ENV_FORBIDDEN/);}
});
test('counter overflow saturates and marks observations incomplete instead of wrapping',()=>{
 const counts=new DmDiagnosticCounters();for(let i=0;i<1000002;i++)counts.increment('callbacks');counts.increment('accepted');counts.increment('accepted');const snapshot=counts.snapshot();assert.equal(snapshot.callbacks,1000000);assert.equal(snapshot.accepted,1);assert.equal(snapshot.truncated,true);assert.equal(snapshot.topicCallbacks,0);
});
