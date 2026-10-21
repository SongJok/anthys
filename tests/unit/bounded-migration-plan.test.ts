import {afterEach,beforeAll,beforeEach,describe,expect,test} from 'vitest';
import {mkdtemp,mkdir,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {requiredSchema} from '../../packages/storage/src/schema.js';

const root=resolve(import.meta.dirname,'../..'),script=join(root,'scripts/bounded-migration-plan.ts'),guard=join(root,'scripts/test-network-guard.mjs');
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const fingerprint=(rows:readonly {name:string;hash:string}[])=>digest(rows.map(row=>row.name+'\0'+row.hash+'\0').join(''));
let directory:string,ledger:string;const sql=new Map<string,Buffer>();
beforeAll(async()=>{for(const item of requiredSchema.migrations)sql.set(item.name,await readFile(join(root,'db/migrations',item.name)));});
beforeEach(async()=>{
 directory=await mkdtemp(join(tmpdir(),'oa-bounded-plan-'));ledger=join(directory,'captured-ledger.json');
 await mkdir(join(directory,'packages/storage/src'),{recursive:true});await mkdir(join(directory,'db/migrations'),{recursive:true});
 await writeFile(join(directory,'packages/storage/src/required-migrations.json'),JSON.stringify(requiredSchema));
 for(const [name,bytes] of sql)await writeFile(join(directory,'db/migrations',name),bytes);
 await writeFile(ledger,JSON.stringify(requiredSchema.migrations.slice(0,73)));
 // This invalid synthetic .env is intentionally not loaded, even on success.
 await writeFile(join(directory,'.env'),'SYNTHETIC_PRIVATE_SENTINEL=must_not_be_read_or_echoed\n');
});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
async function cli(extra:readonly string[]=[],base=true){
 const args=base?['--repository',directory,'--ledger',ledger,'--from','73','--to','98',...extra]:[...extra];
 return new Promise<{code:number|null;stdout:string;stderr:string;value:Record<string,unknown>}>((resolvePromise,reject)=>{
  const child=spawn(process.execPath,['--import',guard,'--import',join(root,'node_modules/tsx/dist/loader.mjs'),script,...args],{cwd:directory,env:{PATH:process.env['PATH']??'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=String(chunk);});child.stderr.on('data',chunk=>{stderr+=String(chunk);});child.once('error',reject);
  child.once('close',code=>{try{resolvePromise({code,stdout,stderr,value:JSON.parse(stdout) as Record<string,unknown>});}catch(error){reject(error);}});
 });
}
async function reject(code:string,extra:readonly string[]=[],base=true){const result=await cli(extra,base);expect(result.code).toBe(1);expect(result.value).toEqual({schemaVersion:1,status:'REJECTED',error:{code}});expect(result.stderr).toBe('');expect(result.stdout).not.toContain(directory);expect(result.stdout).not.toContain('SYNTHETIC_PRIVATE_SENTINEL');}
async function withLedger(value:unknown){await writeFile(ledger,JSON.stringify(value));}
const explicit=(from:number,to:number)=>['--repository',directory,'--ledger',ledger,'--from',String(from),'--to',String(to)];

describe('bounded offline migration plan: actual CLI, no database or executor',()=>{
 test('73 to 98 validates the complete captured prefix and every pinned SQL without writing inputs',async()=>{
  const before=await readFile(ledger),names=await readdir(directory),result=await cli();expect(result.code).toBe(0);expect(result.stderr).toBe('');
  expect(result.value).toMatchObject({schemaVersion:1,status:'OFFLINE_PLAN_ONLY',authorization:'NOT_AUTHORIZED',executionImplemented:false,interval:{from:73,to:98,firstSelected:74,lastSelected:98,selectedCount:25,repositoryLast:requiredSchema.migrations.length},source:{capturedLedgerSha256:digest(before),contractFingerprint:requiredSchema.contractHash,ledgerEntries:73,allRepositorySqlHashesVerified:true},start:{migration:requiredSchema.migrations[72]!.name,fingerprint:fingerprint(requiredSchema.migrations.slice(0,73))},target:{migration:requiredSchema.migrations[97]!.name,fingerprint:fingerprint(requiredSchema.migrations.slice(0,98))}});
  const selected=result.value['migrations'] as {ordinal:number;name:string;sha256:string;byteSize:number;semanticReview:string}[];
  expect(selected).toEqual(requiredSchema.migrations.slice(73,98).map((m,index)=>({ordinal:74+index,name:m.name,sha256:m.hash,byteSize:sql.get(m.name)!.length,semanticReview:'REQUIRED_NOT_PERFORMED'})));
  expect(result.value['prerequisites']).toEqual(expect.arrayContaining(['INDEPENDENT_ENCRYPTED_BACKUP_BEFORE_ANY_MIGRATION','CONTROLLED_KEY_RECOVERY_AND_CIPHERTEXT_RESTORE_VERIFIED','RESTORE_DRILL_IN_SEPARATE_CONTROLLED_ENVIRONMENT','STOP_QUEUE_WORKER_NOTIFIER_SCHEDULER_INGRESS_AND_OTHER_DISPATCHERS','PRESERVE_REVOKED_AUTHORIZATIONS_AND_CLOSED_TRIAL_TOMBSTONES','RECONCILE_EXTERNAL_IN_FLIGHT_AND_UNKNOWN_ACTIONS_WITHOUT_RESENDING']));
  expect(result.value['riskBoundaries']).toMatchObject({liveDatabaseVerified:false,sqlSemanticsVerified:false,backupVerified:false,restoreVerified:false,authorizationGranted:false,automaticRollbackSql:false,reactivateRevokedAuthority:false,treatUnknownExternalActionAsUnsent:false});
  expect(await readFile(ledger)).toEqual(before);expect(await readdir(directory)).toEqual(names);
  for(const [name,bytes] of sql)expect(await readFile(join(directory,'db/migrations',name))).toEqual(bytes);
 });
 test('range is generic through the installed contract end, without an implicit latest target',async()=>{
  const from=requiredSchema.migrations.length-1;await withLedger(requiredSchema.migrations.slice(0,from));const result=await cli(explicit(from,requiredSchema.migrations.length),false);
  expect(result.code).toBe(0);expect(result.value).toMatchObject({interval:{from,to:requiredSchema.migrations.length,selectedCount:1,selectsAllRemaining:true},target:{fingerprint:requiredSchema.contractHash}});
 });
 test('explicit zero prefix is distinct from a missing or incomplete captured ledger',async()=>{await withLedger([]);const result=await cli(explicit(0,1),false);expect(result.code).toBe(0);expect(result.value).toMatchObject({start:{migration:null,fingerprint:digest('')},interval:{from:0,to:1,selectedCount:1}});});
 test.each([
  ['missing explicit to',['--repository','REPO','--ledger','LEDGER','--from','73']],
  ['unsupported executor flag',['--execute']],
  ['duplicate range flag',['--from','73','--from','73','--to','98','--repository','REPO','--ledger','LEDGER']],
  ['noncanonical range',['--from','073','--to','98','--repository','REPO','--ledger','LEDGER']],
 ])('rejects %s',async(_label,args)=>{await reject('USAGE_INVALID',args.map(v=>v==='REPO'?directory:v==='LEDGER'?ledger:v),false);});
 test('rejects target beyond contract and backward/no-op intervals',async()=>{await reject('RANGE_INVALID',explicit(73,requiredSchema.migrations.length+1),false);await reject('RANGE_INVALID',explicit(73,73),false);await reject('RANGE_INVALID',explicit(73,72),false);});
 test('requires an absolute explicitly selected data repository and ledger',async()=>{await reject('PATH_INVALID',['--repository','.','--ledger',ledger,'--from','73','--to','98'],false);});
 test('rejects a missing captured prefix entry and incorrect declared source version',async()=>{await withLedger(requiredSchema.migrations.slice(0,72));await reject('LEDGER_PREFIX_MISMATCH');});
 test('rejects reordered and duplicate migration names even with matching official rows',async()=>{const rows=requiredSchema.migrations.slice(0,73);[rows[0],rows[1]]=[rows[1]!,rows[0]!];await withLedger(rows);await reject('LEDGER_PREFIX_MISMATCH');rows[0]=rows[1]!;await withLedger(rows);await reject('LEDGER_PREFIX_MISMATCH');});
 test('rejects ledger hash drift and cannot relabel old source SQL',async()=>{const rows=requiredSchema.migrations.slice(0,73).map(r=>({...r}));rows[0]!.hash='0'.repeat(64);await withLedger(rows);await reject('LEDGER_PREFIX_MISMATCH');});
 test.each([
  {label:'extra instruction',value:[{name:requiredSchema.migrations[0]!.name,hash:requiredSchema.migrations[0]!.hash,sql:'SYNTHETIC_PRIVATE_SENTINEL'}]},
  {label:'wrong hash type',value:[{name:requiredSchema.migrations[0]!.name,hash:123}]},
  {label:'identity envelope',value:{tenantId:'SYNTHETIC_PRIVATE_SENTINEL',migrations:[]}},
 ])('strict ledger refuses $label',async({value})=>{await withLedger(value);await reject('LEDGER_INVALID');});
 test('rejects malformed JSON and bounded oversized input without echoing it',async()=>{await writeFile(ledger,'{"SYNTHETIC_PRIVATE_SENTINEL":');await reject('INPUT_INVALID_JSON');await writeFile(ledger,' '.repeat(256*1024+1));await reject('INPUT_TOO_LARGE');});
 test('rejects non-UTF8 JSON and directory input',async()=>{await writeFile(ledger,Buffer.from([255]));await reject('INPUT_INVALID_JSON');await reject('INPUT_NOT_REGULAR',['--repository',directory,'--ledger',directory,'--from','73','--to','98'],false);});
 test('rejects symlink input instead of following it',async()=>{const original=join(directory,'original.json');await writeFile(original,await readFile(ledger));await rm(ledger);await symlink(original,ledger);await reject('INPUT_UNREADABLE');});
 test('rejects a target repository whose contract differs from this validated CLI contract',async()=>{await writeFile(join(directory,'packages/storage/src/required-migrations.json'),JSON.stringify({...requiredSchema,contractHash:'0'.repeat(64)}));await reject('CONTRACT_MISMATCH');});
 test('detects rewritten already-applied SQL, not only the selected interval',async()=>{await writeFile(join(directory,'db/migrations',requiredSchema.migrations[0]!.name),'-- changed old source');await reject('MIGRATION_HASH_MISMATCH');});
 test('validates future contract SQL beyond the selected end too',async()=>{await writeFile(join(directory,'db/migrations',requiredSchema.migrations.at(-1)!.name),'-- changed future source');await reject('MIGRATION_HASH_MISMATCH');});
 test('rejects missing or extra SQL rather than inventing a partial contract',async()=>{const path=join(directory,'db/migrations',requiredSchema.migrations[75]!.name);await rm(path);await reject('MIGRATION_SET_MISMATCH');await writeFile(path,sql.get(requiredSchema.migrations[75]!.name)!);await writeFile(join(directory,'db/migrations','999_unreviewed.sql'),'SELECT 1;');await reject('MIGRATION_SET_MISMATCH');});
 test('unreadable input returns only a fixed error code',async()=>{await reject('INPUT_UNREADABLE',['--repository',directory,'--ledger',join(directory,'SYNTHETIC_PRIVATE_SENTINEL.json'),'--from','73','--to','98'],false);});
});
