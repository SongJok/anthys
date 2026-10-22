#!/usr/bin/env node
// Generates the sandbox broker deployment material consumed by
// deploy/compose/compose.dev.yml and compose.prod.yml:
//
//   <broker-secrets>/config.json                  (0600, paths and image digest)
//   <broker-secrets>/auth_key                     (0600, service HMAC key)
//   <broker-secrets>/producer-private.pem         (0600, Ed25519 job signing)
//   <broker-secrets>/producer-public.pem          (0600, broker verification)
//
// Default <broker-secrets> is .secrets/sandbox-broker next to the checkout; set
// ANTHYS_SANDBOX_SECRETS_DIR to use another 0700 directory. Values are derived
// from the host checkout and the built sandbox image. The script never prints
// key material. Run it on the Docker host, not inside a container: the compose
// project name determines the workspace volume and the pinned image digest.
// seccompPath is the broker container's read-only mount; the Docker CLI reads
// that file client-side, so it must not be rewritten to a daemon host path.
import {execFile} from 'node:child_process';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {access,chmod,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const deployDir=dirname(fileURLToPath(import.meta.url));
const repoRoot=resolve(deployDir,'..');
const args=process.argv.slice(2);
const value=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
const flag=name=>args.includes(name);
const image=value('--image')??process.env.ANTHYS_ANALYSIS_SANDBOX_IMAGE??'anthys-analysis-sandbox:dev';
const project=value('--project')??process.env.ANTHYS_SANDBOX_COMPOSE_PROJECT??'anthys-dev';
const brokerId=value('--broker-id')??`broker-${project.replace(/[^A-Za-z0-9_.-]/g,'-').slice(0,50)}`;
const keyId=value('--key-id')??'producer-main';
const digest=value('--digest')??process.env.ANTHYS_ANALYSIS_SANDBOX_DIGEST;
const secretsDir=resolve(process.env.ANTHYS_SANDBOX_SECRETS_DIR??join(repoRoot,'.secrets','sandbox-broker'));
const brokerDir=secretsDir;
const configPath=join(brokerDir,'config.json');
const authKeyPath=join(brokerDir,'auth_key');
const privateKeyPath=join(brokerDir,'producer-private.pem');
const publicKeyPath=join(brokerDir,'producer-public.pem');

async function exists(path){try{await access(path);return true;}catch{return false;}}
function run(file,commandArgs){return new Promise((resolvePromise,reject)=>{execFile(file,commandArgs,{timeout:120_000,maxBuffer:1024*1024,encoding:'utf8'},(error,stdout,stderr)=>{if(error)reject(new Error(`${file} ${commandArgs.join(' ')} failed: ${stderr.trim()||error.message}`));else resolvePromise(stdout);});});}

if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(brokerId))throw new Error('SANDBOX_BROKER_ID_INVALID');
if(!/^[A-Za-z0-9_-]{1,64}$/.test(keyId))throw new Error('SANDBOX_BROKER_KEY_ID_INVALID');
if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(project))throw new Error('SANDBOX_COMPOSE_PROJECT_INVALID');
if(digest!==undefined&&!/^sha256:[a-f0-9]{64}$/.test(digest))throw new Error('SANDBOX_IMAGE_DIGEST_INVALID');

await mkdir(brokerDir,{recursive:true,mode:0o700});
await chmod(brokerDir,0o700);

let imageDigest=digest;
if(!imageDigest){
 try{
  imageDigest=(await run('docker',['image','inspect',image,'--format','{{.Id}}'])).trim();
 }catch{
  if(!flag('--build'))throw new Error(`SANDBOX_IMAGE_NOT_FOUND:${image}. Build it with --build or pass --digest sha256:<64 hex>.`);
  const emptyContext=await mkdtemp(join(tmpdir(),'anthys-sandbox-build-'));
  try{
   console.log(`Building ${image} from deploy/images/analysis-sandbox.Dockerfile (empty build context).`);
   await run('docker',['build','--file',join(deployDir,'images','analysis-sandbox.Dockerfile'),'--tag',image,emptyContext]);
  }finally{await rm(emptyContext,{recursive:true,force:true});}
  imageDigest=(await run('docker',['image','inspect',image,'--format','{{.Id}}'])).trim();
 }
}
if(!/^sha256:[a-f0-9]{64}$/.test(imageDigest))throw new Error('SANDBOX_IMAGE_DIGEST_INVALID');

let authKey='';
try{authKey=(await readFile(authKeyPath,'utf8')).trim();}catch(error){if(error.code!=='ENOENT')throw error;}
if(!authKey){await writeFile(authKeyPath,`${randomBytes(32).toString('hex')}\n`,{mode:0o600,flag:'wx'});authKey=(await readFile(authKeyPath,'utf8')).trim();}
if(!/^[\x21-\x7e]{32,512}$/.test(authKey))throw new Error('SANDBOX_BROKER_AUTH_KEY_INVALID');
await chmod(authKeyPath,0o600);

const privateExists=await exists(privateKeyPath),publicExists=await exists(publicKeyPath);
if(privateExists!==publicExists)throw new Error('SANDBOX_PRODUCER_KEYPAIR_INCOMPLETE');
if(!privateExists){
 const pair=generateKeyPairSync('ed25519');
 await writeFile(privateKeyPath,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});
 await writeFile(publicKeyPath,pair.publicKey.export({type:'spki',format:'pem'}),{mode:0o600,flag:'wx'});
}
await chmod(privateKeyPath,0o600);
await chmod(publicKeyPath,0o600);

const config={
 schemaVersion:1,
 brokerId,
 keyId,
 publicKeyFile:'/run/secrets/sandbox_broker_public_key',
 imageDigest,
 seccompPath:'/run/anthys-policies/seccomp.json',
 workspaceRoot:'/var/lib/anthys-sandbox',
 workspaceVolume:`${project}_sandbox_workspaces`,
 dockerBinary:'/usr/local/bin/docker',
 fileStoreRoot:'/data/artifacts',
 host:'0.0.0.0',
 port:8092
};
await writeFile(configPath,`${JSON.stringify(config,null,2)}\n`,{mode:0o600});
await chmod(configPath,0o600);

console.log(`Sandbox broker material ready under ${brokerDir} (0700, files 0600).`);
console.log(`Broker ${brokerId}, image ${imageDigest}, workspace volume ${project}_sandbox_workspaces.`);
console.log('The producer private key stays on the host; only the public key and config are mounted read-only.');
