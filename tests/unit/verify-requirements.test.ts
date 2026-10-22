import {mkdtemp,mkdir,rm,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyRequirements} from '../../scripts/verify-requirements.js';

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
