import {extname} from 'node:path';
import {AttachmentFailure} from './errors.js';
export function safeFileName(name:string):void {if(!name||name.length>256||/[\\/\x00-\x1f\x7f]/.test(name)||name==='.'||name==='..'||/^[. ]|[. ]$/.test(name)||/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(name))throw new AttachmentFailure('ATTACHMENT_NAME_DENIED');}
export interface Inspection {state:'READY'|'QUARANTINED';mime:string;method:string;reason:string|null}
export function inspectFile(bytes:Buffer,name:string,declaredMime:string):Inspection{
 safeFileName(name);const starts=(hex:string)=>bytes.subarray(0,hex.length/2).equals(Buffer.from(hex,'hex'));
 const binary=starts('504b0304')?'application/zip':starts('1f8b')?'application/gzip':starts('89504e470d0a1a0a')?'image/png':starts('ffd8ff')?'image/jpeg':bytes.subarray(0,5).toString()==='%PDF-'?'application/pdf':starts('47494638')?'image/gif':starts('7f454c46')||starts('4d5a')?'application/x-executable':null;
 if(binary)return {state:'QUARANTINED',mime:binary,method:'MAGIC_SIGNATURE_QUARANTINE_NO_DECOMPRESSION',reason:'BINARY_INSPECTOR_OR_VERIFIED_MODALITY_REQUIRED'};
 let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new AttachmentFailure('ATTACHMENT_UNKNOWN_BINARY');}if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))throw new AttachmentFailure('ATTACHMENT_BINARY_CONTROLS');
 if(/^\s*<\??(?:html|svg|xml|script|!doctype)/i.test(text)||/^\s*#!/.test(text)||/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)||/\b(?:api[_-]?key|access[_-]?token|authorization|client[_-]?secret|password)\b["']?\s*[:=]\s*["']?\S+/i.test(text))return {state:'QUARANTINED',mime:'text/plain',method:'ACTIVE_CONTENT_OR_PRIVATE_KEY_QUARANTINE',reason:'ACTIVE_CONTENT_OR_CREDENTIAL'};
 const ext=extname(name).toLowerCase();if(!['','.txt','.md','.csv','.json'].includes(ext))return {state:'QUARANTINED',mime:'text/plain',method:'UNREVIEWED_EXTENSION_QUARANTINE',reason:'FORMAT_INSPECTOR_REQUIRED'};
 const mime=ext==='.json'?'application/json':ext==='.csv'?'text/csv':ext==='.md'?'text/markdown':'text/plain';if(ext==='.json')try{JSON.parse(text);}catch{throw new AttachmentFailure('ATTACHMENT_INVALID_JSON');}
 if(!['application/octet-stream','text/plain',mime].includes(declaredMime))throw new AttachmentFailure('ATTACHMENT_MIME_MISMATCH');return {state:'READY',mime,method:'STRICT_UTF8_INERT_TEXT_NO_EXECUTION',reason:null};
}
