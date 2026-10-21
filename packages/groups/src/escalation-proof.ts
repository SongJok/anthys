import {groupEscalationPreviewSchema,type GroupEscalationPreview} from './escalation-contracts.js';
/** Only a deterministic plain-text projection of the reviewed preview. It
 * contains no platform mention directive, URL fetch or execution instruction. */
export function renderGroupEscalationNotification(raw:GroupEscalationPreview){
 const p=groupEscalationPreviewSchema.parse(raw),text=`单事项同群升级通知 ${p.proposalId}\n事项 ${p.case.id} · v${p.case.version}\n标题：${p.case.title}\n资源：${p.case.resourceRef}\n当前负责人：${p.case.ownerId??'未设置'}；状态：${p.case.state}\n升级理由（申请人输入）：${p.intent.reason}\n当前审核升级对象：${p.targets.map(t=>t.name+' · '+t.id).join('；')}\n合同版本 ${p.contract.version}。仅为本群已登记事项，不覆盖全部群聊；未使用平台@全员、个人私信或平台@通知，不证明对象已收到/阅读。\n${p.notice}`;
 if(Buffer.byteLength(text)>6000)throw Error('GROUP_ESCALATION_LIMIT');return text;
}
