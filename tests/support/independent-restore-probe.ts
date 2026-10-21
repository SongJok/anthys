import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {EncryptedFileStore} from '../../packages/storage/src/files.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import pg from 'pg';
// Test-only verification in an owned network=none namespace. The application
// key is supplied independently from the backup encryption key, never installed
// as project configuration or printed. This probe does not start a service.
const [profileFile]=process.argv.slice(2);if(!profileFile)throw Error('PROBE_USAGE');
const p=JSON.parse(await readFile(profileFile,'utf8')) as {keyFile:string;keyVersion:string;root:string;fileKey:string;expectedSha256:string;connectionFile:string;credentialId:string;credentialAad:string;credentialSha256:string};
const key=await readFile(p.keyFile),hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
try{
 const vault=new Vault(new Map([[p.keyVersion,key]]),p.keyVersion),value=await new EncryptedFileStore(p.root,vault).get(p.fileKey);if(hash(value)!==p.expectedSha256)throw Error('PROBE_CONTENT_MISMATCH');
 const c=new pg.Client({connectionString:(await readFile(p.connectionFile,'utf8')).trim(),connectionTimeoutMillis:3000,query_timeout:5000});
 let credentialSha256:string;try{await c.connect();const row=(await c.query('SELECT ciphertext FROM credentials WHERE id=$1',[p.credentialId])).rows[0];credentialSha256=hash(Buffer.from(vault.open(JSON.parse(row.ciphertext),p.credentialAad)));if(credentialSha256!==p.credentialSha256)throw Error('PROBE_CREDENTIAL_MISMATCH');}finally{await c.end();}
 console.log(JSON.stringify({status:'SYNTHETIC_APPLICATION_KEY_RECOVERY_VERIFIED',contentSha256:hash(value),credentialSha256,servicesStarted:false,externalDispatchResumeAuthorized:false}));value.fill(0);
}catch{console.log(JSON.stringify({status:'SYNTHETIC_APPLICATION_KEY_REJECTED',servicesStarted:false,externalDispatchResumeAuthorized:false}));process.exitCode=1;}finally{key.fill(0);}
