import {readFile,readdir,access} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {hasImplementationPlaceholder} from './implementation-placeholder.js';
const row=z.object({tests:z.array(z.string().regex(/^T\d{3}$/)).min(1),modules:z.array(z.string()),status:z.enum(['NOT_STARTED','IN_PROGRESS','IMPLEMENTED','TESTED','LIVE_VERIFIED','BLOCKED_EXTERNAL'])});
export async function verifyRequirements(baselineOnly=false,root=process.cwd()):Promise<string[]> {
 const requirements=z.record(z.string(),row).parse(JSON.parse(await readFile(join(root,'config/requirements.json'),'utf8'))),catalog=z.array(z.object({id:z.string(),implementation:z.string().nullable()})).parse(JSON.parse(await readFile(join(root,'config/test-catalog.json'),'utf8')));
 const errors:string[]=[],ids=new Set(catalog.map(t=>t.id));
 for(let i=1;i<=130;i++)if(!ids.has(`T${String(i).padStart(3,'0')}`))errors.push(`Missing baseline T${String(i).padStart(3,'0')}`);
 if(ids.size!==130||catalog.length!==130) errors.push('Baseline test catalog changed/duplicated');
 for(let i=1;i<=36;i++) {const id=`R${String(i).padStart(2,'0')}`,r=requirements[id];if(!r){errors.push(`Missing ${id}`);continue;}
  for(const t of r.tests) if(!ids.has(t)) errors.push(`${id}:unknown test ${t}`);
  if(!baselineOnly&&(!r.modules.length||!['IMPLEMENTED','TESTED','LIVE_VERIFIED'].includes(r.status)))errors.push(`${id}:implementation incomplete`);
  for(const module of r.modules)try{await access(join(root,module));}catch{errors.push(`${id}:missing module ${module}`);}
 }
 if(!baselineOnly) for(const t of catalog) {if(!t.implementation)errors.push(`${t.id}:test implementation absent`);else try{const code=await readFile(join(root,t.implementation),'utf8');if(!code.includes(t.id))errors.push(`${t.id}:no stable ID in test`);}catch{errors.push(`${t.id}:test file absent`);}}
 async function scan(dir:string):Promise<void>{for(const ent of await readdir(dir,{withFileTypes:true})) {const path=join(dir,ent.name);if(ent.isDirectory())await scan(path);else if(/\.(ts|tsx)$/.test(path)&&hasImplementationPlaceholder(await readFile(path,'utf8'),path))errors.push(`Placeholder implementation:${path}`);}}
 for(const dir of ['apps','packages'])await scan(join(root,dir));return errors;
}
if(import.meta.url===`file://${process.argv[1]}`){const baseline=process.argv.includes('--baseline');const errors=await verifyRequirements(baseline,process.env['VERIFY_REQUIREMENTS_ROOT']??process.cwd());console.log(JSON.stringify({mode:baseline?'BASELINE_INTEGRITY_ONLY':'FULL_IMPLEMENTATION',status:errors.length?'FAIL':'PASS',errors},null,2));if(errors.length)process.exitCode=1;}
