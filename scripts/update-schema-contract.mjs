import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const mode=process.argv[2];if(process.argv.length!==3||!['--check','--write'].includes(mode))throw Error('USAGE: update-schema-contract --check|--write');
const names=(await readdir('db/migrations')).filter(n=>n.endsWith('.sql')).sort(),migrations=[];
if(!names.length)throw Error('SCHEMA_CONTRACT_EMPTY');
for(const [index,name]of names.entries()){if(!/^\d{3}_[a-z0-9_]+\.sql$/.test(name)||Number(name.slice(0,3))!==index+1)throw Error('SCHEMA_MIGRATION_SEQUENCE_INVALID');const bytes=await readFile('db/migrations/'+name);if(!bytes.toString('utf8').trim())throw Error('SCHEMA_MIGRATION_EMPTY');migrations.push({name,hash:createHash('sha256').update(bytes).digest('hex')});}
const contractHash=createHash('sha256').update(migrations.map(m=>m.name+'\0'+m.hash+'\0').join('')).digest('hex'),contract={schemaVersion:1,compatibility:'EXACT_SET',lastMigration:names.at(-1),contractHash,migrations},path='packages/storage/src/required-migrations.json',serialized=JSON.stringify(contract,null,2)+'\n';
if(mode==='--write')await writeFile(path,serialized);else if(await readFile(path,'utf8')!==serialized)throw Error('SCHEMA_CONTRACT_STALE: review migrations, then run pnpm schema:refresh');
console.log(JSON.stringify({status:'PASS',mode,migrations:names.length,lastMigration:contract.lastMigration,contractHash,databaseAccess:false}));
