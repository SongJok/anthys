import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
async function command(cwd:string,mode:string){const child=spawn(process.execPath,[resolve('scripts/update-schema-contract.mjs'),mode],{cwd,env:{PATH:process.env['PATH'],LANG:'C.UTF-8',NODE_OPTIONS:process.env['NODE_OPTIONS']},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>{output+=String(b);});child.stderr.on('data',b=>{output+=String(b);});return {code:await new Promise<number|null>(r=>child.once('exit',r)),output};}
it.each(['new-migration','changed-sql','invalid-sequence'])('build contract rejects %s without rewriting the release artifact or touching a database',async kind=>{
 const root=await mkdtemp(join(tmpdir(),'oa-schema-contract-'));try{await mkdir(join(root,'db/migrations'),{recursive:true});await mkdir(join(root,'packages/storage/src'),{recursive:true});await writeFile(join(root,'db/migrations/001_synthetic.sql'),'SELECT 1;\n');expect((await command(root,'--write')).code).toBe(0);expect((await command(root,'--check')).code).toBe(0);const contract=await readFile(join(root,'packages/storage/src/required-migrations.json'));
  if(kind==='new-migration')await writeFile(join(root,'db/migrations/002_synthetic.sql'),'SELECT 2;\n');if(kind==='changed-sql')await writeFile(join(root,'db/migrations/001_synthetic.sql'),'SELECT 3;\n');if(kind==='invalid-sequence')await writeFile(join(root,'db/migrations/003_synthetic.sql'),'SELECT 3;\n');const result=await command(root,'--check');expect(result.code).toBe(1);expect(result.output).toContain(kind==='invalid-sequence'?'SCHEMA_MIGRATION_SEQUENCE_INVALID':'SCHEMA_CONTRACT_STALE');expect(await readFile(join(root,'packages/storage/src/required-migrations.json'))).toEqual(contract);
 }finally{await rm(root,{recursive:true,force:true});}
});
