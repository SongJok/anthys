export function redact(value:unknown):unknown {
 if(Array.isArray(value)) return value.map(redact);
 if(value&&typeof value==='object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/authorization|cookie|token|secret|password|reasoning|webhook|ciphertext/i.test(k)?'[REDACTED]':redact(v)]));
 if(typeof value==='string') return value.replace(/Bearer\s+[^\s]+/gi,'Bearer [REDACTED]').replace(/([?&](?:access_token|token|key)=)[^&\s]+/gi,'$1[REDACTED]');
 return value;
}
