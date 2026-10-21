import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import type {ClientRequest,IncomingMessage} from 'node:http';
import {z} from 'zod';
import {AttachmentFailure} from './errors.js';
export interface DownloadedFile {bytes:Buffer;mime:string}
export function publicAddress(address:string):boolean{
 const family=isIP(address);if(family===4){const n=address.split('.').map(Number),a=n[0]!,b=n[1]!,c=n[2]!;return !(a===0||a===10||a===127||a>=224||a===100&&b>=64&&b<=127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===88&&c===99)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);}
 if(family===6){const ip=new URL(`http://[${address}]/`).hostname.slice(1,-1),second=parseInt(ip.split(':')[1]??'0',16);return /^[23][0-9a-f]{3}:/.test(ip)&&!(ip.startsWith('2001:')&&(second<0x200||second===0xdb8))&&!/^(?:2002|3ffe|3fff):/.test(ip);}return false;
}
export class RestrictedDownloader {
 constructor(private options:{hosts:ReadonlySet<string>;maxBytes?:number;resolve?:(host:string)=>Promise<{address:string;family:number}[]>;request?:(url:URL,options:https.RequestOptions,callback:(res:IncomingMessage)=>void)=>ClientRequest}){}
 async download(initial:string,signal:AbortSignal,beforeRequest:()=>Promise<void>):Promise<DownloadedFile>{
  let url:URL;try{url=new URL(initial);}catch{throw new AttachmentFailure('DOWNLOAD_URL_INVALID');}const max=this.options.maxBytes??8*1024*1024;
  for(let hop=0;hop<4;hop++){
   if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash||url.hostname.startsWith('[')||isIP(url.hostname)||!this.options.hosts.has(url.hostname))throw new AttachmentFailure('DOWNLOAD_DESTINATION_DENIED');
   const addresses=await (this.options.resolve??(host=>lookup(host,{all:true,verbatim:true})))(url.hostname);if(!addresses.length||addresses.some(a=>!publicAddress(a.address)||isIP(a.address)!==a.family))throw new AttachmentFailure('DOWNLOAD_DNS_DENIED');const chosen=addresses.find(a=>a.family===4)??addresses[0]!;
   await beforeRequest();signal.throwIfAborted();
   const response=await new Promise<IncomingMessage>((resolve,reject)=>{const request=(this.options.request??https.request)(url,{method:'GET',agent:false,servername:url.hostname,family:chosen.family,lookup:(_host,_options,cb)=>cb(null,chosen.address,chosen.family),headers:{accept:'*/*','accept-encoding':'identity'},maxHeaderSize:16384,signal},resolve);request.setTimeout(15000,()=>request.destroy(new AttachmentFailure('DOWNLOAD_TIMEOUT',true)));request.once('error',()=>reject(new AttachmentFailure('DOWNLOAD_NETWORK_FAILED',true)));request.end();});
   if([301,302,303,307,308].includes(response.statusCode??0)){const location=response.headers.location;response.destroy();if(!location)throw new AttachmentFailure('DOWNLOAD_REDIRECT_INVALID');try{url=new URL(location,url);}catch{throw new AttachmentFailure('DOWNLOAD_REDIRECT_INVALID');}continue;}
   if(response.statusCode!==200){response.destroy();throw new AttachmentFailure('DOWNLOAD_HTTP_REJECTED',(response.statusCode??0)>=500||response.statusCode===429);}
   const length=response.headers['content-length'];if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>max)){response.destroy();throw new AttachmentFailure('ATTACHMENT_SIZE_LIMIT');}
   if(response.headers['content-encoding']&&response.headers['content-encoding']!=='identity'){response.destroy();throw new AttachmentFailure('DOWNLOAD_ENCODING_DENIED');}
   const chunks:Buffer[]=[];let size=0;try{for await(const chunk of response){signal.throwIfAborted();const b=Buffer.from(chunk as Uint8Array);size+=b.length;if(size>max)throw new AttachmentFailure('ATTACHMENT_SIZE_LIMIT');chunks.push(b);}}catch(e){response.destroy();if(e instanceof AttachmentFailure)throw e;throw new AttachmentFailure('DOWNLOAD_BODY_INTERRUPTED',true);}
   if(length!==undefined&&size!==Number(length))throw new AttachmentFailure('DOWNLOAD_LENGTH_MISMATCH',true);if(!size)throw new AttachmentFailure('ATTACHMENT_EMPTY');return {bytes:Buffer.concat(chunks),mime:(response.headers['content-type']??'application/octet-stream').split(';')[0]!.toLowerCase()};
  }throw new AttachmentFailure('DOWNLOAD_REDIRECT_LIMIT');
 }
}
export interface AttachmentSource {download(code:string,signal:AbortSignal,beforeRequest:()=>Promise<void>):Promise<DownloadedFile>}
export class DingTalkAttachmentSource implements AttachmentSource {
 constructor(private options:{robotCode:string;token:(signal:AbortSignal)=>Promise<string>;downloader:RestrictedDownloader;fetch?:typeof fetch}){}
 async download(code:string,signal:AbortSignal,beforeRequest:()=>Promise<void>):Promise<DownloadedFile>{
  await beforeRequest();const token=await this.options.token(signal);await beforeRequest();const r=await (this.options.fetch??fetch)('https://api.dingtalk.com/v1.0/robot/messageFiles/download',{method:'POST',headers:{'content-type':'application/json','x-acs-dingtalk-access-token':token},body:JSON.stringify({downloadCode:code,robotCode:this.options.robotCode}),signal,redirect:'error'});
  if(!r.ok){await r.body?.cancel();throw new AttachmentFailure('PROVIDER_DOWNLOAD_REJECTED',r.status>=500||r.status===429);}const reply=z.object({downloadUrl:z.url()}).safeParse(await r.json());if(!reply.success)throw new AttachmentFailure('PROVIDER_DOWNLOAD_REPLY_INVALID');return this.options.downloader.download(reply.data.downloadUrl,signal,beforeRequest);
 }
}
