import {z} from 'zod';
const code=z.string().min(1).max(4096),name=z.string().min(1).max(256);
const rawContent=z.preprocess(v=>typeof v==='string'?JSON.parse(v):v,z.unknown());
export interface MessageInput {goal:string;attachments:{downloadCode:string;fileName:string;kind:'FILE'|'PICTURE'}[]}
export function messageInput(raw:unknown):MessageInput{
 const message=z.object({msgtype:z.enum(['text','picture','richText','file']),text:z.object({content:z.string().min(1).max(10000)}).optional(),content:rawContent.optional()}).parse(raw);
 if(message.msgtype==='text')return {goal:z.object({content:z.string().min(1).max(10000)}).parse(message.text).content,attachments:[]};
 if(message.msgtype==='file'){const c=z.object({downloadCode:code,fileName:name}).parse(message.content);return {goal:'请处理我提交的文件；读取前先检查权限和文件安全。',attachments:[{...c,kind:'FILE'}]};}
 if(message.msgtype==='picture'){const c=z.object({downloadCode:code}).parse(message.content);return {goal:'请处理我提交的图片；未经验证的图像能力不得冒称已经看过图片。',attachments:[{...c,fileName:'picture',kind:'PICTURE'}]};}
 const c=z.object({richText:z.array(z.object({text:z.string().max(10000).optional(),downloadCode:code.optional(),fileName:name.optional(),type:z.string().optional()})).min(1).max(40)}).parse(message.content);
 const attachments=c.richText.filter(p=>p.downloadCode).map(p=>{if(p.type&&!['picture','file'].includes(p.type))throw Error('ATTACHMENT_KIND_UNSUPPORTED');return {downloadCode:p.downloadCode!,fileName:p.fileName??'picture',kind:p.type==='file'?'FILE' as const:'PICTURE' as const};});if(attachments.length>8)throw Error('ATTACHMENT_COUNT_LIMIT');
 const goal=c.richText.map(p=>p.text??'').join('\n').trim()||'请处理提交的附件；读取前先检查权限和文件安全。';if(goal.length>10000)throw Error('MESSAGE_SIZE_LIMIT');return {goal,attachments};
}
