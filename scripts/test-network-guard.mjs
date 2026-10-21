import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {lstatSync,realpathSync} from 'node:fs';
import {dirname,basename,join} from 'node:path';
import {tmpdir} from 'node:os';
const allowedPorts=new Set([64711,64702]);
export function permitted(host,port){return ['127.0.0.1','::1','localhost'].includes(host)&&allowedPorts.has(Number(port));}
// One local synthetic RPC socket namespace only; no Docker/keychain/personal
// sockets. The fixture directory and socket must already exist and be private.
export function permittedDwsSocket(path){try{if(typeof path!=='string')return false;const parent=dirname(path),root=realpathSync(tmpdir()),dir=lstatSync(parent),socket=lstatSync(path);return basename(path)==='runner.sock'&&/^oa-dws-rpc-[A-Za-z0-9]+$/.test(basename(parent))&&dirname(parent)===root&&realpathSync(parent)===parent&&dir.isDirectory()&&(dir.mode&0o077)===0&&dir.uid===process.getuid?.()&&socket.isSocket()&&(socket.mode&0o077)===0&&path===join(parent,'runner.sock');}catch{return false;}}
function check(args){let options=args[0];if(Array.isArray(options))options=options[0];if(options&&typeof options==='object'){if(options.path){if(permittedDwsSocket(options.path))return;throw Error('TEST_NETWORK_UNDECLARED_SOCKET');}if(permitted(options.host??options.hostname??'localhost',options.port))return;}else if((typeof options==='number'||/^\d+$/.test(String(options)))&&permitted(typeof args[1]==='string'?args[1]:'localhost',options))return;throw Error('TEST_NETWORK_UNDECLARED_DESTINATION');}
const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){check(args);return connect.apply(this,args);};
const tlsConnect=tls.connect;tls.connect=function(...args){check(args);return tlsConnect.apply(this,args);};
for(const module of [http,https])for(const method of ['request','get']){const original=module[method];module[method]=function(...args){const target=args[0];const options=typeof target==='string'||target instanceof URL?new URL(target):target;if(module===http&&options?.socketPath&&permittedDwsSocket(options.socketPath))return original.apply(this,args);if(!options||!permitted(options.hostname??options.host??'localhost',options.port??(module===https?443:80)))throw Error('TEST_NETWORK_UNDECLARED_DESTINATION');return original.apply(this,args);};}
const originalFetch=globalThis.fetch;globalThis.fetch=async function(input,init){const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!permitted(url.hostname,url.port|| (url.protocol==='https:'?443:80)))throw Error('TEST_NETWORK_UNDECLARED_DESTINATION');return originalFetch(input,init);};
syncBuiltinESMExports();
globalThis[Symbol.for('anthys.testNetworkGuard')]=true;
