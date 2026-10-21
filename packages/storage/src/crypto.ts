import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
export type Sealed={version:string;iv:string;tag:string;data:string};
export const hash=(s:string):string=>createHash('sha256').update(s).digest('hex');
export class Vault {
 constructor(private keys:ReadonlyMap<string,Buffer>,readonly activeVersion:string) {for(const k of keys.values()) if(k.length!==32) throw Error('KEY_LENGTH');if(!keys.has(activeVersion)) throw Error('KEY_VERSION');}
 seal(value:string,aad:string):Sealed {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.keys.get(this.activeVersion)!,iv);cipher.setAAD(Buffer.from(aad));
  const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return {version:this.activeVersion,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};
 }
 open(value:Sealed,aad:string):string {
  const key=this.keys.get(value.version);if(!key) throw Error('KEY_VERSION');
  const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(value.iv,'base64'));cipher.setAAD(Buffer.from(aad));cipher.setAuthTag(Buffer.from(value.tag,'base64'));
  return Buffer.concat([cipher.update(Buffer.from(value.data,'base64')),cipher.final()]).toString('utf8');
 }
}
