import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp,realpath,writeFile,chmod,link,symlink,rm} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {compareRecoverySafety} from '../../packages/operations/src/recovery-safety-comparison.js';
import {comparePostgresInventories,type PostgresInventory} from '../../packages/operations/src/postgres-inventory.js';
import * as privateFile from '../../packages/operations/src/private-file.js';
import {restoreVerificationCommand} from '../../scripts/restore-verification.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function inventory(patch:Partial<PostgresInventory>={}):PostgresInventory{
 const raw={schemaVersion:1 as const,kind:'POSTGRES_RESTORE_INVENTORY' as const,database:'synthetic_recovery',systemIdentifier:'123456',serverVersionNum:170011,capturedAt:'2026-10-20T08:00:00.000Z',migrationCount:73,schemaFingerprint:hash('SYNTHETIC_SCHEMA'),metadataSha256:hash('SYNTHETIC_METADATA'),tables:[{schema:'public',name:'memory_deletions',rows:1,bytes:7,sha256:hash('SYNTHETIC_ROWS')}],sequences:[{schema:'public',name:'synthetic_sequence',lastValue:'17',isCalled:true}],consistency:'REPEATABLE_READ_TABLES_SEQUENCES_OBSERVED_STABLE' as const,externalDispatchResumeAuthorized:false as const,...patch};
 return {...raw,contentFingerprint:hash(JSON.stringify({schemaFingerprint:raw.schemaFingerprint,metadataSha256:raw.metadataSha256,tables:raw.tables,sequences:raw.sequences}))};
}
let directory:string;
beforeEach(async()=>{
 directory=await realpath(await mkdtemp(join(tmpdir(),'oa-recovery-safety-')));await chmod(directory,0o700);
 vi.spyOn(pg.Client.prototype,'connect').mockImplementation(()=>{throw Error('UNEXPECTED_DATABASE_CONNECT');});
 vi.stubGlobal('fetch',vi.fn(()=>{throw Error('UNEXPECTED_NETWORK_FETCH');}));
});
afterEach(async()=>{expect(pg.Client.prototype.connect).not.toHaveBeenCalled();expect(globalThis.fetch).not.toHaveBeenCalled();vi.restoreAllMocks();vi.unstubAllGlobals();await rm(directory,{recursive:true,force:true});});
async function stored(name:string,value:unknown){const path=join(directory,name);await writeFile(path,JSON.stringify(value),{mode:0o600});return path;}
const signal=()=>new AbortController().signal;
const noAuthority={externalDispatchResumeAuthorized:false,currentAuthorityFreshnessVerified:false,safetyFactsReplayed:false,revocationAndExternalStateReconciliationRequired:true};

it('identical content at different capture times and independent target identities observes no difference without granting freshness or dispatch',()=>{
 const current=inventory(),restored=inventory({capturedAt:'2026-10-20T09:00:00.000Z',database:'synthetic_new_target',systemIdentifier:'654321'});
 expect(comparePostgresInventories(current,restored).status).toBe('MATCH');
 expect(compareRecoverySafety(current,restored)).toMatchObject({status:'NO_DIFFERENCE_OBSERVED',...noAuthority,current:{capturedAt:current.capturedAt,migrationCount:73,contentFingerprint:current.contentFingerprint},restored:{capturedAt:restored.capturedAt},tables:{matches:true,added:[],missing:[],changed:[]},sequences:{matches:true,added:[],missing:[],changed:[]}});
});
it('compares unknown business tables and all current/restored table bytes, rows and hashes with explicit added/missing direction',()=>{
 const table=(name:string,rows=1)=>({schema:'public',name,rows,bytes:rows*7,sha256:hash(name+rows)});
 const current=inventory({tables:[table('z_missing'),table('arbitrary_business'),table('a_missing')]});
 const restored=inventory({tables:[table('z_added'),table('arbitrary_business',2),table('a_added')]});
 const result=compareRecoverySafety(current,restored);
 expect(result).toMatchObject({status:'DIFFERENCE_REQUIRES_RECONCILIATION',differenceDirection:'RESTORED_RELATIVE_TO_CURRENT',...noAuthority});
 expect(result.tables.added.map(row=>row.name)).toEqual(['a_added','z_added']);expect(result.tables.missing.map(row=>row.name)).toEqual(['a_missing','z_missing']);
 expect(result.tables.changed).toEqual([{schema:'public',name:'arbitrary_business',current:{rows:1,bytes:7,sha256:hash('arbitrary_business1')},restored:{rows:2,bytes:14,sha256:hash('arbitrary_business2')}}]);
});
it.each(['rows','bytes','sha256'] as const)('independently detects table %s changes',field=>{
 const current=inventory(),row={...current.tables[0]!,[field]:field==='sha256'?hash('SYNTHETIC_CHANGED'):2};
 expect(compareRecoverySafety(current,inventory({tables:[row]})).tables.changed).toHaveLength(1);
});
it('keys tables by both schema and name without concatenation collisions',()=>{
 const table={rows:1,bytes:1,sha256:hash('ROW')};
 const current=inventory({tables:[{schema:'a:b',name:'c',...table},{schema:'a',name:'b:c',...table}]}),restored=inventory({tables:[{schema:'a:b',name:'c',...table,rows:2},{schema:'a',name:'b:c',...table}]});
 expect(compareRecoverySafety(current,restored).tables.changed.map(row=>[row.schema,row.name])).toEqual([['a:b','c']]);
});
it('reports all sequence additions, removals, value and isCalled changes without lossy numeric conversion',()=>{
 const seq=(name:string,lastValue='17',isCalled=true)=>({schema:'public',name,lastValue,isCalled});
 const result=compareRecoverySafety(inventory({sequences:[seq('missing'),seq('value','9223372036854775806'),seq('called')]}),inventory({sequences:[seq('added'),seq('value','9223372036854775807'),seq('called','17',false)]}));
 expect(result.status).toBe('DIFFERENCE_REQUIRES_RECONCILIATION');expect(result.sequences.added.map(row=>row.name)).toEqual(['added']);expect(result.sequences.missing.map(row=>row.name)).toEqual(['missing']);expect(result.sequences.changed).toEqual([{schema:'public',name:'called',current:{lastValue:'17',isCalled:true},restored:{lastValue:'17',isCalled:false}},{schema:'public',name:'value',current:{lastValue:'9223372036854775806',isCalled:true},restored:{lastValue:'9223372036854775807',isCalled:true}}]);
});
it.each(['schemaFingerprint','metadataSha256'] as const)('blocks equality for %s drift even without table changes',field=>{
 const result=compareRecoverySafety(inventory(),inventory({[field]:hash('DRIFT')}));
 expect(result.status).toBe('DIFFERENCE_REQUIRES_RECONCILIATION');expect(result[field==='schemaFingerprint'?'schemaMatches':'metadataMatches']).toBe(false);expect(result.tables.changed).toEqual([]);
});
it('migration count mismatch is explicit even if the supplied schema/content hashes are unchanged',()=>{
 const result=compareRecoverySafety(inventory(),inventory({migrationCount:74}));expect(result.status).toBe('DIFFERENCE_REQUIRES_RECONCILIATION');expect(result.migrationCountMatches).toBe(false);expect(result.schemaMatches).toBe(false);
});
it('preserves existing array-order comparison rather than masking differences with sorted map projections',()=>{
 const first=inventory().tables[0]!,second={...first,name:'second'};
 const result=compareRecoverySafety(inventory({tables:[first,second]}),inventory({tables:[second,first]}));
 expect(result.status).toBe('DIFFERENCE_REQUIRES_RECONCILIATION');expect(result.tables.matches).toBe(false);expect(result.tables.changed).toEqual([]);
});
it.each(['tables','sequences'] as const)('rejects duplicate %s keys rather than silently overwriting data',field=>{
 const base=inventory(),rows=field==='tables'?{tables:[base.tables[0]!,base.tables[0]!]}:{sequences:[base.sequences[0]!,base.sequences[0]!]};
 const duplicate=inventory(rows);
 expect(()=>compareRecoverySafety(base,duplicate)).toThrowError('INVALID_INVENTORY');expect(()=>compareRecoverySafety(duplicate,base)).toThrowError('INVALID_INVENTORY');
});
it.each(['tables','sequences'] as const)('rejects %s beyond the existing 4096-entry bound',field=>{
 const base=inventory(),patch=field==='tables'?{tables:Array.from({length:4097},(_,i)=>({...base.tables[0]!,name:'t'+i}))}:{sequences:Array.from({length:4097},(_,i)=>({...base.sequences[0]!,name:'s'+i}))};
 expect(()=>compareRecoverySafety(base,inventory(patch))).toThrowError('INVALID_INVENTORY');
});
it('accepts and accounts for the complete 4096-table bound without mutating inputs',()=>{
 const base=inventory(),current=inventory({tables:Array.from({length:4096},(_,i)=>({...base.tables[0]!,name:'table_'+i}))}),before=JSON.stringify(current),result=compareRecoverySafety(current,inventory({tables:[]}));
 expect(result.tables.missing).toHaveLength(4096);expect(JSON.stringify(current)).toBe(before);expect(result.tables.missing[0]!.name).toBe('table_0');
});
it.each([null,{}, {...inventory(),unexpected:'SYNTHETIC_PRIVATE'}, {...inventory(),contentFingerprint:hash('WRONG')},inventory({tables:[{...inventory().tables[0]!,rows:NaN}]})])('rejects malformed or self-inconsistent inventories',raw=>{
 expect(()=>compareRecoverySafety(raw,inventory())).toThrowError('INVALID_INVENTORY');expect(()=>compareRecoverySafety(inventory(),raw)).toThrowError('INVALID_INVENTORY');
});
it('comparison results contain summaries, never raw business values or connection credentials',()=>{
 const result=compareRecoverySafety(inventory(),inventory());expect(JSON.stringify(result)).not.toContain('synthetic_recovery');expect(JSON.stringify(result)).not.toContain('123456');expect(Object.keys(result.current).sort()).toEqual(['capturedAt','contentFingerprint','metadataSha256','migrationCount','schemaFingerprint']);
});
it('compare-safety reads only the two explicit private files and retains original compare behavior',async()=>{
 const before=await stored('before.json',inventory()),after=await stored('after.json',inventory());
 const observed=vi.spyOn(privateFile,'readOperationsPrivateFile');
 expect(await restoreVerificationCommand(['compare-safety','--current',before,'--restored',after],signal())).toMatchObject({status:'NO_DIFFERENCE_OBSERVED',...noAuthority});
 expect(observed.mock.calls).toEqual([[before,4*1024*1024],[after,4*1024*1024]]);
 observed.mockClear();expect(await restoreVerificationCommand(['compare','--before',before,'--after',after],signal())).toEqual(comparePostgresInventories(inventory(),inventory()));
 expect(observed.mock.calls).toHaveLength(2);
});
it.each([[],['compare-safety'],['compare-safety','--current','/SYNTHETIC'],['compare-safety','--current','/SYNTHETIC','--current','/OTHER'],['compare-safety','--current','/SYNTHETIC','--restored','/OTHER','--unknown','x'],['compare-safety','--before','/SYNTHETIC','--after','/OTHER'],['compare-safety','--current=/SYNTHETIC','--restored','/OTHER']].map(args=>({args})))('rejects ambiguous/duplicate/unknown arguments before private-file access',async({args})=>{
 const read=vi.spyOn(privateFile,'readOperationsPrivateFile');await expect(restoreVerificationCommand(args,signal())).rejects.toThrow();expect(read).not.toHaveBeenCalled();
});
it('pre-cancellation prevents even private-file reads',async()=>{
 const controller=new AbortController();controller.abort();const read=vi.spyOn(privateFile,'readOperationsPrivateFile');await expect(restoreVerificationCommand(['compare-safety','--current','/SYNTHETIC','--restored','/OTHER'],controller.signal)).rejects.toThrow();expect(read).not.toHaveBeenCalled();
});
it('cancellation after the first actual bounded read prevents the second and returns no comparison',async()=>{
 const first=await stored('first.json',inventory()),second=await stored('second.json',inventory()),controller=new AbortController(),read=privateFile.readOperationsPrivateFile;
 const observe=vi.spyOn(privateFile,'readOperationsPrivateFile').mockImplementation(async(...args)=>{const bytes=await read(...args);controller.abort();return bytes;});
 await expect(restoreVerificationCommand(['compare-safety','--current',first,'--restored',second],controller.signal)).rejects.toThrow();expect(observe).toHaveBeenCalledTimes(1);
});
it.each(['mode','parent-mode','symlink','hardlink','relative','dot-path','empty','too-large','invalid-utf8','invalid-json'] as const)('rejects actual private-file boundary %s',async fault=>{
 let current=await stored('current.json',inventory());const restored=await stored('restored.json',inventory());
 if(fault==='mode')await chmod(current,0o644);
 if(fault==='parent-mode')await chmod(directory,0o755);
 if(fault==='symlink'){const alias=join(directory,'alias');await symlink(current,alias);current=alias;}
 if(fault==='hardlink')await link(current,join(directory,'alias'));
 if(fault==='relative')current='SYNTHETIC_RELATIVE';
 if(fault==='dot-path')current=directory+'/./current.json';
 if(fault==='empty')await writeFile(current,'');
 if(fault==='too-large')await writeFile(current,Buffer.alloc(4*1024*1024+1,120));
 if(fault==='invalid-utf8')await writeFile(current,Buffer.from([0xff]));
 if(fault==='invalid-json')await writeFile(current,'{"SYNTHETIC":');
 await expect(restoreVerificationCommand(['compare-safety','--current',current,'--restored',restored],signal())).rejects.toThrow();
});
const cli=fileURLToPath(new URL('../../scripts/restore-verification.ts',import.meta.url));
function command(args:string[]){return spawnSync(process.execPath,['--import','tsx',cli,...args],{cwd:resolve(dirname(cli),'..'),env:{PATH:dirname(process.execPath),LANG:'C'},encoding:'utf8',timeout:10000,maxBuffer:1024*1024});}
it('actual CLI exits zero for no observed difference and one for unknown-table drift, preserving fixed safety flags',async()=>{
 const current=await stored('current.json',inventory()),same=await stored('same.json',inventory()),changed=await stored('changed.json',inventory({tables:[...inventory().tables,{schema:'public',name:'unclassified_new_table',rows:0,bytes:0,sha256:hash('EMPTY')}]}));
 const okay=command(['compare-safety','--current',current,'--restored',same]);expect(okay.error).toBeUndefined();expect(okay.status).toBe(0);expect(okay.stderr).toBe('');expect(JSON.parse(okay.stdout)).toMatchObject({status:'NO_DIFFERENCE_OBSERVED',...noAuthority});
 const difference=command(['compare-safety','--current',current,'--restored',changed]);expect(difference.error).toBeUndefined();expect(difference.status).toBe(1);expect(JSON.parse(difference.stdout)).toMatchObject({status:'DIFFERENCE_REQUIRES_RECONCILIATION',tables:{added:[{name:'unclassified_new_table'}]},...noAuthority});
});
it('actual old compare CLI output/status remains unchanged',async()=>{
 const current=await stored('current.json',inventory()),restored=await stored('restored.json',inventory({metadataSha256:hash('CHANGED')}));
 const result=command(['compare','--before',current,'--after',restored]);expect(result.status).toBe(1);expect(JSON.parse(result.stdout)).toEqual(comparePostgresInventories(inventory(),inventory({metadataSha256:hash('CHANGED')})));
});
it('actual CLI rejects malformed files with safe fixed errors, without echoing path or private content',async()=>{
 const invalid=await stored('SYNTHETIC_PRIVATE_PATH.json',{SYNTHETIC_PRIVATE_VALUE:'do not echo'}),valid=await stored('valid.json',inventory());
 const result=command(['compare-safety','--current',invalid,'--restored',valid]);expect(result.status).toBe(1);expect(JSON.parse(result.stdout)).toEqual({schemaVersion:1,status:'REJECTED',code:'INVALID_INVENTORY'});expect(result.stdout+result.stderr).not.toContain(directory);expect(result.stdout+result.stderr).not.toContain('SYNTHETIC_PRIVATE');expect(result.stderr).toBe('');
 const bad=command(['compare-safety','--current',invalid,'--restored',valid,'--unexpected','SYNTHETIC_PRIVATE_VALUE']);expect(bad.status).toBe(1);expect(JSON.parse(bad.stdout)).toEqual({schemaVersion:1,status:'REJECTED',code:'PRIVATE_INPUT_OR_COMMAND_INVALID'});expect(bad.stdout+bad.stderr).not.toContain('SYNTHETIC_PRIVATE');
});
