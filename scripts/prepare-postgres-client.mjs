// Test tooling only. No project configuration, database, credentials, or services.
// Production operator profiles require independently reviewed executable pins.
import {mkdir,lstat,realpath,readFile,writeFile,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const sourceSha='dd27f2b3c59e73ed14aa3324901242bf69a032a6347805f274e6260322d42979',version='17.11';
export async function preparePostgresClient(){
 const root=join(await realpath('/tmp'),'open-aider-pg17-native'),env={PATH:'/usr/bin:/bin:/usr/local/bin',LC_ALL:'C',LANG:'C'};
 const inspect=async()=>{
  const pins={};for(const name of ['pg_dump','pg_restore']){const path=join(root,'bin',name),s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||await realpath(path)!==path||s.uid!==process.getuid?.()||(s.mode&0o022)||(s.mode&0o111)===0||s.size>256*1024*1024)throw Error('PG17_TEST_CLIENT_UNSAFE');const bytes=await readFile(path),observed=execFileSync(path,['--version'],{env,cwd:'/',timeout:10000,maxBuffer:4096,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();if(observed!==name+' (PostgreSQL) '+version)throw Error('PG17_TEST_CLIENT_VERSION_MISMATCH');pins[name]={path,sha256:createHash('sha256').update(bytes).digest('hex'),version:observed};}return pins;
 };
 let exists=true;try{await lstat(root);}catch(error){if(error.code!=='ENOENT')throw error;exists=false;}
 if(!exists){
  if(process.platform!=='linux')throw Error('PG17_TEST_NATIVE_CLIENT_REQUIRED: prepare the official PostgreSQL 17.11 client locally');
  await mkdir(root,{mode:0o700});const download=join(root,'postgresql-'+version+'.tar.bz2'),build=join(root,'postgresql-'+version),log=await open(join(root,'build.log'),'wx',0o600);
  try{
   const run=(file,args,timeout=600000)=>execFileSync(file,args,{cwd:root,env,timeout,maxBuffer:4096,stdio:['ignore',log.fd,log.fd]});
   run('/usr/bin/curl',['--fail','--silent','--show-error','--location','--proto','=https','--proto-redir','=https','--max-time','120','--max-filesize','24000000','--output',download,'https://ftp.postgresql.org/pub/source/v'+version+'/postgresql-'+version+'.tar.bz2'],130000);
   const bytes=await readFile(download);if(bytes.length>24000000||createHash('sha256').update(bytes).digest('hex')!==sourceSha)throw Error('PG17_TEST_SOURCE_HASH_REJECTED');
   run('/usr/bin/tar',['-xjf',download]);
   execFileSync(join(build,'configure'),['--prefix='+root,'--with-ssl=openssl','--without-readline','--without-icu','--without-lz4','--without-zstd'],{cwd:build,env,timeout:180000,stdio:['ignore',log.fd,log.fd]});
   run('/usr/bin/make',['-C',join(build,'src/backend'),'generated-headers']);
   run('/usr/bin/make',['-C',join(build,'src/bin/pg_dump'),'-j2']);
   run('/usr/bin/make',['-C',join(build,'src/interfaces/libpq'),'install']);
   run('/usr/bin/make',['-C',join(build,'src/bin/pg_dump'),'install']);
  }finally{await log.close();}
 }
 const pins=await inspect(),directory=resolve('.data/test-environment');await mkdir(directory,{recursive:true,mode:0o700});await writeFile(join(directory,'pg17-client.json'),JSON.stringify({schemaVersion:1,kind:'SYNTHETIC_TEST_NATIVE_POSTGRES_CLIENT',sourceVersion:version,sourceSha256:sourceSha,pins}),{mode:0o600});return pins;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){await preparePostgresClient();console.log('PostgreSQL 17 native test client prepared; no database accessed.');}
