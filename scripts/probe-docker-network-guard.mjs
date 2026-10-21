import {readFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import dgram from 'node:dgram';
import {syncBuiltinESMExports} from 'node:module';
// Only the explicit image test harness loads this guard. The normal host test
// runner and its fixed 127.0.0.1:64711 guard remain unchanged.
assert.equal(process.env.APP_ENV,'test');assert.equal(process.env.OA_TEST_ISOLATED,'true');assert.equal(process.getuid(),10001);assert.equal(existsSync('/.dockerenv'),true);
const boundary=JSON.parse(readFileSync('/run/oa/probe-boundary.json','utf8'));
assert.equal(boundary.schemaVersion,1);assert.equal(boundary.host,'synthetic-db');assert.equal(boundary.port,5432);assert.equal(boundary.database,'anthys_test');assert.match(boundary.network,/^oa-app-probe-[a-f0-9-]{36}$/);assert.match(boundary.postgresContainer,/^[a-f0-9]{64}$/);assert.match(boundary.imageId,/^sha256:[a-f0-9]{64}$/);
for(const [name,role] of [['RUNTIME_DATABASE_URL','oa_runtime'],['QUEUE_DATABASE_URL','oa_queue'],['MIGRATION_DATABASE_URL','oa_migrator']]){const u=new URL(process.env[name]);assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,boundary.host);assert.equal(u.port,String(boundary.port));assert.equal(u.pathname,'/'+boundary.database);assert.equal(u.username,role);assert.equal(u.search,'');assert.equal(u.hash,'');}
let denied=0,allowed=0;
const reject=()=>{denied++;throw Error('DOCKER_TEST_EGRESS_DENIED');};
function target(args){let a=args[0];if(Array.isArray(a))a=a[0];if(a&&typeof a==='object')return {host:a.host??'localhost',port:Number(a.port)};return {host:typeof args[1]==='string'?args[1]:'localhost',port:Number(a)};}
const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){const t=target(args);if(t.host!==boundary.host||t.port!==boundary.port)reject();allowed++;return Reflect.apply(connect,this,args);};
net.Server.prototype.listen=reject;tls.connect=reject;http.request=reject;http.get=reject;https.request=reject;https.get=reject;globalThis.fetch=async()=>reject();
const lookup=dns.lookup.bind(dns);dns.lookup=function(host,...args){if(host!==boundary.host)reject();return lookup(host,...args);};const promisedLookup=dns.promises.lookup.bind(dns.promises);dns.promises.lookup=async(host,...args)=>{if(host!==boundary.host)reject();return promisedLookup(host,...args);};
for(const key of Object.keys(dns)){if(key==='lookup')continue;if(key.startsWith('resolve')||key==='reverse'||key==='lookupService')dns[key]=reject;}
for(const key of Object.keys(dns.promises)){if(key==='lookup')continue;if(key.startsWith('resolve')||key==='reverse'||key==='lookupService')dns.promises[key]=async()=>reject();}
for(const Resolver of [dns.Resolver,dns.promises.Resolver])for(const key of Object.getOwnPropertyNames(Resolver.prototype))if(key.startsWith('resolve')||key==='reverse')Resolver.prototype[key]=reject;
dgram.createSocket=reject;dgram.Socket.prototype.connect=reject;dgram.Socket.prototype.send=reject;dgram.Socket.prototype.bind=reject;syncBuiltinESMExports();
// Prove denial before attesting the existing synthetic budget gate.
assert.throws(()=>new net.Socket().connect(443,'external.invalid'),/DOCKER_TEST_EGRESS_DENIED/);assert.throws(()=>tls.connect({host:'external.invalid',port:443}),/DOCKER_TEST_EGRESS_DENIED/);assert.throws(()=>http.get('http://external.invalid'),/DOCKER_TEST_EGRESS_DENIED/);assert.throws(()=>dns.lookup('external.invalid',()=>{}),/DOCKER_TEST_EGRESS_DENIED/);await assert.rejects(fetch('https://external.invalid'),/DOCKER_TEST_EGRESS_DENIED/);assert.throws(()=>new dns.Resolver().resolve4('external.invalid',()=>{}),/DOCKER_TEST_EGRESS_DENIED/);assert.throws(()=>new dns.promises.Resolver().resolve4('external.invalid'),/DOCKER_TEST_EGRESS_DENIED/);assert.throws(()=>dgram.createSocket('udp4'),/DOCKER_TEST_EGRESS_DENIED/);assert.equal(denied,8);denied=0;
Object.defineProperty(globalThis,Symbol.for('anthys.dockerProbeBoundary'),{value:Object.freeze({stats:()=>({denied,allowed}),scope:'OWNED_INTERNAL_SYNTHETIC_DB_ONLY'}),configurable:false,writable:false});
Object.defineProperty(globalThis,Symbol.for('anthys.testNetworkGuard'),{value:true,configurable:false,writable:false});
