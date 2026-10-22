import {createHash} from 'node:crypto';
import {SearchError} from './errors.js';
import {normalizePublicUrl} from './egress.js';

const maxQueryLength=256;
const denied:[RegExp,string][]=[
 [/\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}/i,'AUTH'],
 [/\bsk-[a-z0-9_-]{10,}/i,'KEY'],
 [/\bAKIA[0-9A-Z]{16}\b/,'KEY'],
 [/\b(?:gh[pousr]_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{10,})\b/i,'TOKEN'],
 [/\b(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key)\s*[:=]\s*\S+/i,'CREDENTIAL'],
 [/-----BEGIN [A-Z ]*PRIVATE KEY-----/,'KEY'],
 [/\b(?:jdbc:|postgres(?:ql)?:\/\/|mysql:\/\/|redis:\/\/|mongodb(?:\+srv)?:\/\/|amqp:\/\/)/i,'CONNECTION'],
 [/\.secrets\b|(?:^|[\\/])\.env\b/i,'SECRET_FILE'],
 [/\bMCP_[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)\b/,'ENV_SECRET'],
 [/\b(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|\[?::1\]?)\b/i,'INTERNAL_HOST'],
 [/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i,'EMAIL'],
 [/\b\d{11,}\b/,'LONG_NUMBER'],
 [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,'IDENTIFIER'],
 [/\b[0-9a-f]{32,}\b/i,'IDENTIFIER'],
 [/\b\d{17}[\dXx]\b/,'IDENTIFIER'],
 [/(?:客户|租户|账号|用户|customer|cust|tenant|client|account|user)[-_:#：\s]*[a-z]*\d[a-z0-9]{2,}/i,'CUSTOMER_ID']
];
export type ReviewedPublicQuery=Readonly<{text:string;hash:string;classification:'PUBLIC'}>;
/** Outbound DLP for public search. Only an explicit PUBLIC classification may leave the system. */
export function reviewPublicSearchQuery(raw:unknown,classification:string):ReviewedPublicQuery{
 const deny=():never=>{throw new SearchError('SEARCH_QUERY_DENIED',403);};
 if(classification!=='PUBLIC')throw new SearchError('SEARCH_CLASSIFICATION_DENIED',403);
 if(typeof raw!=='string')throw new SearchError('SEARCH_QUERY_DENIED',403);
 const text=raw.normalize('NFC').trim().replace(/\s+/g,' ');
 if(!text||text.length>maxQueryLength||/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(text))deny();
 for(const [pattern] of denied)if(pattern.test(text))deny();
 for(const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)){
  const candidate=match[0].replace(/[),.;:!?]+$/,'');
  if(!candidate.startsWith('https://'))deny();
  try{normalizePublicUrl(candidate);}catch{deny();}
 }
 return Object.freeze({text,hash:createHash('sha256').update('anthys.search.query.v1\0'+text).digest('hex'),classification:'PUBLIC'});
}
