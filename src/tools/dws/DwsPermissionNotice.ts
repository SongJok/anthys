import type { DwsDomain } from './DwsCliRunner.js';

export interface DwsPermissionGuide {
  label: string;
  keyword: string;
  scopes: string[];
}

export const DWS_PERMISSION_GUIDES: Record<DwsDomain, DwsPermissionGuide> = {
  doc: {
    label: '文档读写权限',
    keyword: '文档',
    scopes: [],
  },
  wiki: {
    label: '知识库读写权限',
    keyword: '知识库',
    scopes: [],
  },
  calendar: {
    label: '日历写权限',
    keyword: '日历',
    scopes: ['Calendar.Event.Write'],
  },
  todo: {
    label: '待办写权限',
    keyword: '待办',
    scopes: ['Todo.PersonalTodo.Write', 'Todo.Todo.Write'],
  },
  contact: {
    label: '通讯录管理权限',
    keyword: '通讯录',
    scopes: ['qyapi_manage_addresslist'],
  },
  approval: {
    label: '审批读写权限',
    keyword: '审批',
    scopes: [
      'Workflow.Instance.Read',
      'Workflow.Instance.Write',
      'Workflow.Form.Read',
      'Workflow.Form.Write',
    ],
  },
};

/** 应用/接口级权限点缺失，任何域都值得通知管理员 */
const STRONG_PERMISSION_PATTERN =
  /(AccessTokenPermissionDenied|Forbidden\.AccessDenied|insufficient[_ -]?(?:scope|permission)|missing[_ -]?scope|scope.{0,12}(?:invalid|missing|required)|没有调用该接口的权限|接口权限|应用权限|权限不足|无权限调用|无权调用|未开通.{0,16}权限)/i;

/** 资源级拒绝：文档/知识库多为单篇文档授权问题，不打扰管理员 */
const GENERIC_PERMISSION_PATTERN =
  /(permission[_ -]?denied|not authorized|无权限|没有权限|无权访问|无访问权限|不具(?:备|有).{0,8}权限)/i;

export function isDwsPermissionError(
  domain: DwsDomain,
  output: string,
): boolean {
  if (STRONG_PERMISSION_PATTERN.test(output)) return true;
  if (domain === 'doc' || domain === 'wiki') return false;
  return GENERIC_PERMISSION_PATTERN.test(output);
}

export interface DwsPermissionNotice {
  conversationId: string;
  conversationType: '1' | '2';
  senderStaffId: string;
  senderNick: string;
  toolName: string;
  domain: DwsDomain;
  action: string;
  command: string;
  error: string;
  occurredAt: number;
}

export type DwsPermissionNotifier = (
  notice: DwsPermissionNotice,
) => Promise<boolean> | boolean;

function formatBeijingTime(ms: number): string {
  return new Date(ms + 8 * 3_600_000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 16);
}

function compact(text: string, limit: number): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  return normalized.length > limit
    ? `${normalized.slice(0, limit)}…（已截断）`
    : normalized;
}

export function formatDwsPermissionNotice(
  notice: DwsPermissionNotice,
): string {
  const guide = DWS_PERMISSION_GUIDES[notice.domain];
  const scene =
    notice.conversationType === '2'
      ? `群聊 ${notice.conversationId}`
      : '单聊';
  const scopes =
    guide.scopes.length > 0
      ? guide.scopes.join('、')
      : `请在权限管理中搜索「${guide.keyword}」相关的读写权限点`;
  return [
    '【机器人权限不足】',
    `时间：${formatBeijingTime(notice.occurredAt)}（北京时间）`,
    `场景：${scene}`,
    `提问人：${notice.senderNick}（${notice.senderStaffId}）`,
    `操作：${notice.action}（工具 ${notice.toolName}）`,
    `命令：${compact(notice.command, 300)}`,
    `错误：${compact(notice.error, 600)}`,
    `需要开通：${scopes}`,
    '',
    '处理办法：',
    '1) 钉钉开放平台 → 企业内部应用 → 权限管理，搜索并开通上述权限点；',
    `2) 或用 CLI：dws dev app list 找到 unifiedAppId → dws dev app permission list --unified-app-id <ID> --keyword ${guide.keyword} → dws dev app permission add --unified-app-id <ID> --scope-values <权限点>；`,
    '3) 若权限点 requiredApproval=true，需按版本生效：version create → check-approval → publish → version status；',
    '4) 权限生效后，由用户本人在机器人单聊发送 /dws-login 刷新个人授权；',
    '5) 暂不开放写能力时：管理控制台 →「钉钉企业配置」关闭 DWS 开关，或设置 DWS_CLI_ENABLED=false。',
  ].join('\n');
}

export function formatDwsPermissionInstruction(
  notice: DwsPermissionNotice,
  adminNotified: boolean,
): string {
  const guide = DWS_PERMISSION_GUIDES[notice.domain];
  const scopes =
    guide.scopes.length > 0
      ? guide.scopes.join('、')
      : `「${guide.keyword}」相关权限点`;
  return [
    `机器人缺少「${guide.label}」，${adminNotified ? '已主动通知管理员' : '通知管理员失败，请在回答中提醒用户联系管理员'}。`,
    '不要重复调用该工具，也不要编造操作结果。',
    `请向用户说明：当前机器人没有该操作权限，管理员开通 ${scopes} 后，请用户在单聊发送 /dws-login 刷新个人授权即可使用；如果暂时不需要写能力，可以继续用查询类工具帮用户确认信息。`,
  ].join('');
}
