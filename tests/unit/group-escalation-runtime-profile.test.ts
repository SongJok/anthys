import {it,expect} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,realpath,writeFile,chmod,rm,symlink,link,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {groupEscalationRuntimeProfile,groupEscalationRuntimeFingerprint,readGroupEscalationRuntimeProfile,type GroupEscalationRuntimeProfile} from '../../packages/config/src/group-escalation-runtime.js';
const profile=()=>({schemaVersion:1,approved:true,purpose:'GROUP_CASE_ESCALATION_RUN_ONCE',reviewReference:'SYNTHETIC_ESCALATION_REVIEW',sourceReviewHash:'a'.repeat(64),requiredSchemaHash:'b'.repeat(64),validFrom:'2026-10-20T00:00:00Z',expiresAt:'2026-10-20T00:02:00Z',maxNotifications:1,modelCalls:0,allowMentionAll:false,allowDirectMessages:false,target:{tenantId:randomUUID(),actorId:randomUUID(),groupId:'cidSynthetic==',proposalId:randomUUID(),previewHash:'c'.repeat(64),contractHash:'d'.repeat(64)}});
it('pins one exact target and canonical schema output; object key order does not change the fingerprint',()=>{
 const p=profile(),f=groupEscalationRuntimeFingerprint(p),typed:GroupEscalationRuntimeProfile=f.document;
 expect(typed.target).toEqual(p.target);expect(Object.isFrozen(f.document)).toBe(true);expect(Object.isFrozen(f.document.target)).toBe(true);expect(f.serialized).toBe(JSON.stringify(groupEscalationRuntimeProfile.parse(p)));expect(f.hash).toBe(createHash('sha256').update(f.serialized).digest('hex'));expect(groupEscalationRuntimeFingerprint(JSON.parse(f.serialized)).hash).toBe(f.hash);
 expect(groupEscalationRuntimeFingerprint(Object.fromEntries(Object.entries(p).reverse())).hash).toBe(f.hash);
 expect(groupEscalationRuntimeFingerprint({...p,validFrom:'2026-10-20T08:00:00+08:00',expiresAt:'2026-10-20T08:02:00+08:00'}).hash).toBe(f.hash);
});
it('every target and audit/schema pin changes the fingerprint but never installs authority or checks the current schema',()=>{
 const p=profile(),original=groupEscalationRuntimeFingerprint(p).hash;
 for(const target of [{...p.target,tenantId:randomUUID()},{...p.target,actorId:randomUUID()},{...p.target,groupId:'cidOther=='},{...p.target,proposalId:randomUUID()},{...p.target,previewHash:'e'.repeat(64)},{...p.target,contractHash:'e'.repeat(64)}])expect(groupEscalationRuntimeFingerprint({...p,target}).hash).not.toBe(original);
 for(const change of [{sourceReviewHash:'e'.repeat(64)},{requiredSchemaHash:'e'.repeat(64)},{reviewReference:'SYNTHETIC_DIFFERENT_REVIEW'}])expect(groupEscalationRuntimeFingerprint({...p,...change}).hash).not.toBe(original);
 // This pure document parser does not assert wall-clock validity or schema/ACL approval.
 expect(groupEscalationRuntimeProfile.safeParse(p).success).toBe(true);
});
it.each([{schemaVersion:2},{approved:false},{purpose:'GROUP_REMINDER_RUN_ONCE'},{purpose:'DAEMON'},{maxNotifications:0},{maxNotifications:2},{maxNotifications:1.5},{modelCalls:1},{allowMentionAll:true},{allowDirectMessages:true},{targets:[]},{allowEscalation:true},{credential:'SYNTHETIC_SECRET'},{requiredSchemaHash:'bad'},{sourceReviewHash:'A'.repeat(64)},{reviewReference:'short'},{reviewReference:'https://invalid.example/?secret=x'},{expiresAt:'2026-10-20T00:02:00.001Z'},{expiresAt:'2026-10-20T00:00:00Z'},{expiresAt:'2026-10-19T23:59:59Z'},{validFrom:'invalid'},{expiresAt:'2026-02-30T00:00:00Z'}])('rejects a broadened or malformed top-level profile %#',change=>{const p={...profile(),...change};expect(groupEscalationRuntimeProfile.safeParse(p).success).toBe(false);expect(()=>groupEscalationRuntimeFingerprint(p)).toThrow('GROUP_ESCALATION_RUNTIME_PROFILE_INVALID');});
it('requires a single strict concrete target; rejects arrays, wildcards, missing pins, scope/session and alternate recipients',()=>{
 const p=profile();for(const target of [undefined,null,[],[p.target],{...p.target,tenantId:'*'},{...p.target,actorId:'any'},{...p.target,groupId:'*'},{...p.target,groupId:'../secret'},{...p.target,groupId:'cid whitespace'},{...p.target,groupId:'https://example.invalid'},{...p.target,proposalId:'not-uuid'},{...p.target,previewHash:undefined},{...p.target,contractHash:'f'.repeat(63)},{...p.target,sessionId:randomUUID()},{...p.target,targets:[randomUUID()]},{...p.target,storagePath:'/private/secret'}])expect(groupEscalationRuntimeProfile.safeParse({...p,target}).success).toBe(false);
 const {target:_target,...without}=p;expect(groupEscalationRuntimeProfile.safeParse({...without,targets:[p.target]}).success).toBe(false);
});
async function privateFixture(){const root=await realpath(await mkdtemp(join(await realpath(tmpdir()),'oa-escalation-profile-')));await chmod(root,0o700);const path=join(root,'profile.json'),p=profile();await writeFile(path,JSON.stringify(p),{mode:0o600});return {root,path,p};}
async function refused(path:string){await expect(readGroupEscalationRuntimeProfile(path)).rejects.toThrow(/^GROUP_ESCALATION_RUNTIME_PRIVATE_PROFILE_REQUIRED$/);}
it('actual private 600 single-link canonical file in 700 directory reads only the supplied synthetic profile',async()=>{const f=await privateFixture();try{expect(await readGroupEscalationRuntimeProfile(f.path)).toEqual(groupEscalationRuntimeFingerprint(f.p));}finally{await rm(f.root,{recursive:true,force:true});}});
it('refuses relative/dot paths, file and parent symlinks, hard links, absent paths and directories',async()=>{const f=await privateFixture();try{
 await refused(relative(process.cwd(),f.path));await refused(f.root+'/./profile.json');await refused(join(f.root,'missing.json'));await refused(f.root);
 const alias=join(f.root,'alias.json');await symlink(f.path,alias);await refused(alias);
 const sub=join(f.root,'sub');await mkdir(sub,{mode:0o700});const nested=join(sub,'profile.json');await writeFile(nested,JSON.stringify(f.p),{mode:0o600});const parentAlias=join(f.root,'sub-link');await symlink(sub,parentAlias);await refused(join(parentAlias,'profile.json'));
 const hard=join(f.root,'hard.json');await link(f.path,hard);await refused(f.path);await refused(hard);
 }finally{await rm(f.root,{recursive:true,force:true});}});
it('refuses unsafe file/parent permissions and bounded byte/JSON/schema/UTF8 failures without reflecting content or paths',async()=>{const f=await privateFixture();try{
 for(const mode of [0o644,0o640,0o400,0o700]){await chmod(f.path,mode);await refused(f.path);}await chmod(f.path,0o600);
 for(const mode of [0o755,0o750,0o777,0o500,0o600]){await chmod(f.root,mode);await refused(f.path);}await chmod(f.root,0o700);
 for(const bytes of [Buffer.alloc(0),Buffer.from(' '.repeat(32769)),Buffer.from('{bad SYNTHETIC_SECRET'),Buffer.from(JSON.stringify({...f.p,credential:'SYNTHETIC_SECRET'})),Buffer.from([255,254]),Buffer.from('null')]){await writeFile(f.path,bytes);try{await readGroupEscalationRuntimeProfile(f.path);throw Error('EXPECTED_REFUSAL');}catch(error){expect(String(error)).toBe('Error: GROUP_ESCALATION_RUNTIME_PRIVATE_PROFILE_REQUIRED');expect(String(error)).not.toContain(f.root);expect(String(error)).not.toContain('SYNTHETIC_SECRET');}}
 }finally{await chmod(f.root,0o700);await rm(f.root,{recursive:true,force:true});}});
