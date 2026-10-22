import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {analysisJobSubjectSchema,type AnalysisJobSubject} from '../../analysis/src/job-contract.js';

const methodPattern=/^[A-Z]{1,16}$/,pathPattern=/^\/(?:[A-Za-z0-9._~/-]|%[0-9A-Fa-f]{2})*$/,timestampPattern=/^[0-9]{1,15}$/,signaturePattern=/^[A-Za-z0-9_-]{43}$/,subjectPattern=/^[A-Za-z0-9_-]{1,682}$/;
const domain='ANTHYS_SANDBOX_BROKER_V1',maxSkewMs=60_000,minKeyBytes=32,maxKeyBytes=512;
export const sandboxBrokerAuthHeaders=Object.freeze({subject:'x-anthys-broker-subject',timestamp:'x-anthys-broker-timestamp',signature:'x-anthys-broker-signature'});

export type SandboxBrokerAuthErrorCode='SANDBOX_BROKER_AUTH_KEY_UNSAFE'|'SANDBOX_BROKER_AUTH_INVALID'|'SANDBOX_BROKER_AUTH_STALE';
export class SandboxBrokerAuthError extends Error {
 constructor(readonly code:SandboxBrokerAuthErrorCode){super(code);this.name='SandboxBrokerAuthError';}
}

/** Raw key files are newline-trimmed printable strings; hex or base64url both work. */
export function parseSandboxBrokerAuthKey(raw:string|Uint8Array):Buffer {
 const bytes=typeof raw==='string'?Buffer.from(raw,'utf8'):Buffer.from(raw);
 let value=bytes;
 while(value.length&&(value[value.length-1]===0x0a||value[value.length-1]===0x0d))value=value.subarray(0,value.length-1);
 if(value.length<minKeyBytes||value.length>maxKeyBytes)throw new SandboxBrokerAuthError('SANDBOX_BROKER_AUTH_KEY_UNSAFE');
 for(const byte of value)if(byte<0x21||byte>0x7e)throw new SandboxBrokerAuthError('SANDBOX_BROKER_AUTH_KEY_UNSAFE');
 return Buffer.from(value);
}

/** Rejects symlinks, group/world-writable files and oversized key material. Compose secrets mounted 0444 are accepted. */
export async function readSandboxBrokerAuthKey(path:string):Promise<Buffer> {
 if(!isAbsolute(path))throw new SandboxBrokerAuthError('SANDBOX_BROKER_AUTH_KEY_UNSAFE');
 let handle;
 try{handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);}catch{throw new SandboxBrokerAuthError('SANDBOX_BROKER_AUTH_KEY_UNSAFE');}
 try{
  const info=await handle.stat();
  if(!info.isFile()||(info.mode&0o022)!==0||info.size<minKeyBytes||info.size>4096)throw new SandboxBrokerAuthError('SANDBOX_BROKER_AUTH_KEY_UNSAFE');
  return parseSandboxBrokerAuthKey(await handle.readFile());
 }finally{await handle.close();}
}

function checkedKey(key:Buffer){
 if(!Buffer.isBuffer(key)||key.length<minKeyBytes||key.length>maxKeyBytes)throw new SandboxBrokerAuthError('SANDBOX_BROKER_AUTH_INVALID');
}
function checkedRequest(method:string,path:string,timestamp:number){
 if(typeof method!=='string'||!methodPattern.test(method)||typeof path!=='string'||!pathPattern.test(path)||path.includes('?')||path.includes('#')||!Number.isSafeInteger(timestamp)||timestamp<0)throw new SandboxBrokerAuthError('SANDBOX_BROKER_AUTH_INVALID');
}
function canonical(method:string,path:string,timestamp:number,subjectHeader:string,body:Uint8Array|string){
 const bytes=typeof body==='string'?Buffer.from(body,'utf8'):Buffer.from(body);
 return Buffer.from(`${domain}\n${method}\n${path}\n${timestamp}\n${subjectHeader}\n${createHash('sha256').update(bytes).digest('hex')}`,'utf8');
}
export type SandboxBrokerSignatureInput=Readonly<{method:string;path:string;subjectHeader:string;timestamp:number;body:Uint8Array|string;key:Buffer}>;
export function sandboxBrokerRequestSignature(input:SandboxBrokerSignatureInput):string {
 checkedKey(input.key);checkedRequest(input.method,input.path,input.timestamp);
 if(typeof input.subjectHeader!=='string'||!subjectPattern.test(input.subjectHeader))throw new SandboxBrokerAuthError('SANDBOX_BROKER_AUTH_INVALID');
 return createHmac('sha256',input.key).update(canonical(input.method,input.path,input.timestamp,input.subjectHeader,input.body)).digest('base64url');
}
export type SandboxBrokerSignedRequest=Readonly<{headers:Record<string,string>;timestamp:number;subjectHeader:string}>;
/** The subject is authenticated by the service key, never inferred from the job wire. */
export function signSandboxBrokerRequest(input:{method:string;path:string;subject:AnalysisJobSubject;body?:Uint8Array|string;key:Buffer;timestamp?:number}):SandboxBrokerSignedRequest {
 const subject=analysisJobSubjectSchema.parse(input.subject),subjectHeader=Buffer.from(JSON.stringify(subject),'utf8').toString('base64url'),timestamp=input.timestamp??Date.now();
 const signature=sandboxBrokerRequestSignature({method:input.method,path:input.path,subjectHeader,timestamp,body:input.body??new Uint8Array(),key:input.key});
 return Object.freeze({timestamp,subjectHeader,headers:Object.freeze({[sandboxBrokerAuthHeaders.subject]:subjectHeader,[sandboxBrokerAuthHeaders.timestamp]:String(timestamp),[sandboxBrokerAuthHeaders.signature]:signature})});
}
function header(headers:Record<string,string|string[]|undefined>,name:string):string{
 const value=headers[name];
 if(typeof value!=='string')throw new SandboxBrokerAuthError('SANDBOX_BROKER_AUTH_INVALID');
 return value;
}
export function verifySandboxBrokerRequest(input:{method:string;path:string;headers:Record<string,string|string[]|undefined>;body:Uint8Array|string;key:Buffer;now?:number}):AnalysisJobSubject {
 checkedKey(input.key);
 const method=input.method.toUpperCase();checkedRequest(method,input.path,input.now??Date.now());
 const timestampHeader=header(input.headers,sandboxBrokerAuthHeaders.timestamp),signatureHeader=header(input.headers,sandboxBrokerAuthHeaders.signature),subjectHeader=header(input.headers,sandboxBrokerAuthHeaders.subject);
 if(!timestampPattern.test(timestampHeader)||!signaturePattern.test(signatureHeader)||!subjectPattern.test(subjectHeader))throw new SandboxBrokerAuthError('SANDBOX_BROKER_AUTH_INVALID');
 const timestamp=Number(timestampHeader),now=input.now??Date.now();
 if(!Number.isSafeInteger(timestamp)||Math.abs(now-timestamp)>maxSkewMs)throw new SandboxBrokerAuthError('SANDBOX_BROKER_AUTH_STALE');
 let raw:Buffer;
 try{raw=Buffer.from(subjectHeader,'base64url');}catch{throw new SandboxBrokerAuthError('SANDBOX_BROKER_AUTH_INVALID');}
 if(raw.toString('base64url')!==subjectHeader)throw new SandboxBrokerAuthError('SANDBOX_BROKER_AUTH_INVALID');
 let decoded:unknown;
 try{decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{throw new SandboxBrokerAuthError('SANDBOX_BROKER_AUTH_INVALID');}
 const parsed=analysisJobSubjectSchema.safeParse(decoded);
 if(!parsed.success)throw new SandboxBrokerAuthError('SANDBOX_BROKER_AUTH_INVALID');
 const expected=Buffer.from(sandboxBrokerRequestSignature({method,path:input.path,subjectHeader,timestamp,body:input.body,key:input.key}),'base64url'),provided=Buffer.from(signatureHeader,'base64url');
 if(provided.length!==expected.length||!timingSafeEqual(provided,expected))throw new SandboxBrokerAuthError('SANDBOX_BROKER_AUTH_INVALID');
 return parsed.data;
}
