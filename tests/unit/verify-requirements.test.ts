import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,rm,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {verifyRequirements} from '../../scripts/verify-requirements.js';
const exec=promisify(execFile),script=join(resolve(import.meta.dirname,'../..'),'scripts/verify-requirements.ts');
async function cli(root:string,...mode:string[]):Promise<{code:number;stdout:string;stderr:string}>{try{const result=await exec(process.execPath,['--import','tsx',script,...mode],{env:{...process.env,VERIFY_REQUIREMENTS_ROOT:root},timeout:120000});return {code:0,stdout:result.stdout,stderr:result.stderr};}catch(error){const failed=error as {code:number;stdout:string;stderr:string};return {code:failed.code,stdout:failed.stdout,stderr:failed.stderr};}}

const ids=Array.from({length:130},(_,index)=>`T${String(index+1).padStart(3,'0')}`);
type Requirements=Record<string,{tests:string[];modules:string[];status:string}>;
type Catalog={id:string;implementation:string|null}[];

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'anthys-verify-requirements-'));
 await Promise.all(['config','apps','packages','src','tests'].map(directory=>mkdir(join(root,directory),{recursive:true})));
 await writeFile(join(root,'src/module.ts'),'export const implemented=1;\n');
 await writeFile(join(root,'apps/ok.ts'),'export const ok=true;\n');
 await writeFile(join(root,'tests/all.test.ts'),ids.join('\n'));
 const requirements:Requirements=Object.fromEntries(Array.from({length:36},(_,index)=>[`R${String(index+1).padStart(2,'0')}`,{tests:['T001'],modules:['src/module.ts'],status:'IMPLEMENTED'}]));
 const catalog:Catalog=ids.map(id=>({id,implementation:'tests/all.test.ts'}));
 const save=async()=>{
  await writeFile(join(root,'config/requirements.json'),JSON.stringify(requirements,null,2));
  await writeFile(join(root,'config/test-catalog.json'),JSON.stringify(catalog,null,2));
 };
 await save();
 return {root,requirements,catalog,save};
}

it('T128 accepts a complete fixture in both baseline and full modes',async()=>{
 const {root}=await fixture();
 try{
  await expect(verifyRequirements(true,root)).resolves.toEqual([]);
  await expect(verifyRequirements(false,root)).resolves.toEqual([]);
 }finally{await rm(root,{recursive:true,force:true});}
});

it('T128 reports missing baseline IDs, duplicate catalog rows, absent mappings and placeholders',async()=>{
 const {root,requirements,catalog,save}=await fixture();
 try{
  catalog.pop();catalog.push({...catalog[0]!});
  await save();
  const duplicate=await verifyRequirements(true,root);
  expect(duplicate).toContain('Missing baseline T130');
  expect(duplicate).toContain('Baseline test catalog changed/duplicated');

  catalog[1]!.implementation=null;
  await save();
  expect(await verifyRequirements(false,root)).toContain('T002:test implementation absent');

  catalog[1]!.implementation='tests/all.test.ts';
  await writeFile(join(root,'tests/all.test.ts'),ids.filter(id=>id!=='T003').join('\n'));
  await save();
  expect(await verifyRequirements(false,root)).toContain('T003:no stable ID in test');

  requirements['R01']!.status='IN_PROGRESS';
  await save();
  expect(await verifyRequirements(false,root)).toContain('R01:implementation incomplete');

  requirements['R01']!.status='IMPLEMENTED';
  await save();
  await unlink(join(root,'src/module.ts'));
  expect(await verifyRequirements(false,root)).toContain('R01:missing module src/module.ts');

  await writeFile(join(root,'apps/placeholder.ts'),'export function unfinished(){ return undefined; }\n');
  expect((await verifyRequirements(false,root)).some(error=>error.startsWith('Placeholder implementation:'))).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});

it('the gate CLI exits zero on a complete fixture and names the mode it ran',async()=>{
 const {root}=await fixture();
 try{
  const baseline=await cli(root,'--baseline');
  expect(baseline.code).toBe(0);expect(baseline.stderr).toBe('');
  expect(JSON.parse(baseline.stdout)).toEqual({mode:'BASELINE_INTEGRITY_ONLY',status:'PASS',errors:[]});
  const full=await cli(root);
  expect(full.code).toBe(0);expect(full.stderr).toBe('');
  expect(JSON.parse(full.stdout)).toEqual({mode:'FULL_IMPLEMENTATION',status:'PASS',errors:[]});
 }finally{await rm(root,{recursive:true,force:true});}
});

it('the gate CLI fails closed in full mode while baseline mode still passes the same tree',async()=>{
 const {root,requirements,save}=await fixture();
 try{
  requirements['R01']!.status='IN_PROGRESS';
  requirements['R02']!.modules=['src/absent.ts'];
  await save();
  const baseline=await cli(root,'--baseline');
  expect(baseline.code).toBe(1);expect(JSON.parse(baseline.stdout)).toEqual({mode:'BASELINE_INTEGRITY_ONLY',status:'FAIL',errors:['R02:missing module src/absent.ts']});
  requirements['R02']!.modules=['src/module.ts'];await save();
  const green=await cli(root,'--baseline');
  expect(green.code).toBe(0);expect(JSON.parse(green.stdout)).toEqual({mode:'BASELINE_INTEGRITY_ONLY',status:'PASS',errors:[]});
  const full=await cli(root);
  expect(full.code).toBe(1);expect(full.stderr).toBe('');
  expect(JSON.parse(full.stdout)).toEqual({mode:'FULL_IMPLEMENTATION',status:'FAIL',errors:['R01:implementation incomplete']});
 }finally{await rm(root,{recursive:true,force:true});}
});
