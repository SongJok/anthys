import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {lstat,mkdtemp,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Produces only verified public release files, never an installed CLI/profile copy.
const repository=fileURLToPath(new URL('../',import.meta.url));
const lock=JSON.parse(await readFile(join(repository,'config/dws/lock.json'),'utf8'));
const options={};
for(let index=2;index<process.argv.length;index+=2){const name=process.argv[index],value=process.argv[index+1];if(!['--platform','--output','--archive','--checksums'].includes(name)||!value||options[name])throw Error('USAGE: prepare-dws-release --platform linux-arm64|linux-amd64 --output NEW_ABSOLUTE_DIRECTORY [--archive FILE --checksums FILE]');options[name]=value;}
const platform=options['--platform'],output=options['--output'];
if(!['linux-arm64','linux-amd64'].includes(platform)||!output||!isAbsolute(output)||Boolean(options['--archive'])!==Boolean(options['--checksums']))throw Error('DWS_RELEASE_ARGUMENTS_INVALID');
const destination=resolve(output),spec=lock.platforms[platform];
if(await lstat(destination).catch(error=>{if(error.code==='ENOENT')return null;throw error;}))throw Error('DWS_RELEASE_OUTPUT_ALREADY_EXISTS');
const staging=await mkdtemp(join(dirname(destination),'.dws-release-'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function download(url){
 const signal=AbortSignal.timeout(120000);
 for(let redirect=0;redirect<6;redirect++){
  const target=new URL(url);if(target.protocol!=='https:'||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(target.hostname)||target.username||target.password)throw Error('DWS_RELEASE_DOWNLOAD_HOST_DENIED');
  const response=await fetch(target,{redirect:'manual',signal});
  if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');await response.body?.cancel();if(!location)throw Error('DWS_RELEASE_REDIRECT_INVALID');url=new URL(location,target).href;continue;}
  if(response.status!==200)throw Error('DWS_RELEASE_DOWNLOAD_FAILED');
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>64*1024*1024)throw Error('DWS_RELEASE_DOWNLOAD_TOO_LARGE');chunks.push(chunk);}return Buffer.concat(chunks);
 }
 throw Error('DWS_RELEASE_REDIRECT_LIMIT');
}
try{
 const archiveName=`dws-${platform}.tar.gz`,base=`${lock.officialRepository}/releases/download/${lock.version}/`;
 const checksums=options['--checksums']?await readFile(options['--checksums']):await download(lock.releaseChecksumsUrl);
 if(digest(checksums)!==lock.releaseChecksumsSha256)throw Error('DWS_RELEASE_CHECKSUMS_CHANGED');
 const expectedLine=checksums.toString('utf8').split(/\r?\n/).find(line=>line.endsWith(`  ${archiveName}`));
 if(expectedLine!==`${spec.archiveSha256}  ${archiveName}`)throw Error('DWS_RELEASE_ARCHIVE_NOT_IN_MANIFEST');
 const archive=options['--archive']?await readFile(options['--archive']):await download(base+archiveName);
 if(archive.length>64*1024*1024||digest(archive)!==spec.archiveSha256)throw Error('DWS_RELEASE_ARCHIVE_CHANGED');
 const archivePath=join(staging,'release.tar.gz');await writeFile(archivePath,archive,{mode:0o600,flag:'wx'});
 const tarOptions={env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},maxBuffer:64*1024*1024,timeout:30000};
 const binary=execFileSync('/usr/bin/tar',['-xOf',archivePath,'dws'],tarOptions);
 if(digest(binary)!==spec.binarySha256||!binary.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46])))throw Error('DWS_RELEASE_BINARY_CHANGED');
 await writeFile(join(staging,'dws'),binary,{mode:0o500,flag:'wx'});
 for(const name of ['LICENSE','NOTICE']){const contents=execFileSync('/usr/bin/tar',['-xOf',archivePath,name],tarOptions);await writeFile(join(staging,name),contents,{mode:0o444,flag:'wx'});}
 await rm(archivePath);
 const metadata={kind:'VERIFIED_PUBLIC_RELEASE',version:lock.version,sourceCommit:lock.sourceCommit,platform,archiveSha256:spec.archiveSha256,binarySha256:spec.binarySha256,checksumsSha256:lock.releaseChecksumsSha256,transport:options['--archive']?'LOCAL_LOCKED_ARCHIVE':'OFFICIAL_PUBLIC_HTTPS',businessCalls:0,credentialsRead:false};
 await writeFile(join(staging,'prepared.json'),JSON.stringify(metadata,null,2)+'\n',{mode:0o444,flag:'wx'});
 await rename(staging,destination);console.log(JSON.stringify({...metadata,output:destination},null,2));
}finally{await rm(staging,{recursive:true,force:true});}
