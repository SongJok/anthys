import type { InboundMessage } from '../types/core.js';
import type {
  SemanticMemoryAdminPort,
  SemanticMemoryRecord,
} from '../types/bystander-and-memory.js';
import { formatShanghaiDateTime } from '../time/shanghaiTime.js';

const CONTENT_LIMIT = 500;

const USAGE = [
  '个人记忆用法（仅单聊）：',
  '- `/memory` 或 `/memory list` 查看已保存的个人记忆',
  '- `/memory search <关键词>` 检索',
  '- `/memory add [--share] <内容>` 添加；--share 表示允许在群聊中召回',
  '- `/memory share|private <ID>` 设置该条是否可在群聊中使用',
  '- `/memory forget <ID>` 删除该条记忆',
].join('\n');

export interface PersonalMemoryServiceOptions {
  memories: SemanticMemoryAdminPort;
  /** 写入个人语义记忆；由上层负责向量化与去重 */
  remember: (input: {
    personKey: string;
    conversationId: string;
    messageId?: string;
    content: string;
    shareableInGroup: boolean;
  }) => Promise<void>;
}

function clip(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function parseShareFlag(parts: string[]): { text: string; share: boolean } {
  let share = false;
  const text: string[] = [];
  for (const part of parts) {
    if (part === '--share') {
      share = true;
      continue;
    }
    text.push(part);
  }
  return { text: text.join(' ').trim(), share };
}

function resolveByPrefix(
  records: SemanticMemoryRecord[],
  id: string,
): { record: SemanticMemoryRecord } | { error: string } {
  const needle = id.trim().toLowerCase();
  if (!needle) return { error: '请输入个人记忆 ID 前缀。' };
  const exact = records.find((record) => record.id.toLowerCase() === needle);
  if (exact) return { record: exact };
  const matches = records.filter((record) =>
    record.id.toLowerCase().startsWith(needle),
  );
  if (matches.length === 1 && matches[0]) return { record: matches[0] };
  if (matches.length > 1) {
    return { error: `ID 前缀 ${id} 匹配到多条个人记忆，请多输入几位。` };
  }
  return { error: `未找到个人记忆 ${id}。` };
}

/**
 * 员工自助管理自己的语义记忆：
 * - 只能操作 scope=user 且 subjectKey 等于本人 personKey 的条目；
 * - 单聊中查看与修改，群聊一律拒绝，避免个人记忆进入群上下文。
 */
export class PersonalMemoryService {
  private readonly memories: SemanticMemoryAdminPort;
  private readonly rememberFact: PersonalMemoryServiceOptions['remember'];

  constructor(options: PersonalMemoryServiceOptions) {
    this.memories = options.memories;
    this.rememberFact = options.remember;
  }

  public usage(): string {
    return USAGE;
  }

  public async list(
    personKey: string,
    options: { query?: string; limit?: number } = {},
  ): Promise<SemanticMemoryRecord[]> {
    if (!personKey.trim()) return [];
    const query = options.query?.trim();
    const result = await this.memories.list({
      scope: 'user',
      subjectKey: personKey,
      status: 'active',
      ...(query ? { query } : {}),
      limit: Math.max(1, Math.min(200, options.limit ?? 20)),
      offset: 0,
    });
    return result.items.filter(
      (record) =>
        record.scope === 'user' &&
        record.subjectKey === personKey &&
        record.status === 'active',
    );
  }

  public async add(input: {
    personKey: string;
    conversationId: string;
    content: string;
    shareableInGroup: boolean;
    messageId?: string;
  }): Promise<string> {
    const text = clip(input.content, CONTENT_LIMIT);
    if (!text) return '要记住的内容不能为空。';
    await this.rememberFact({
      personKey: input.personKey,
      conversationId: input.conversationId,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      content: text,
      shareableInGroup: input.shareableInGroup,
    });
    return input.shareableInGroup
      ? '已记住，并允许在群聊中按授权档位召回。'
      : '已记住，仅你本人可见。';
  }

  public async setShareable(
    personKey: string,
    idOrPrefix: string,
    shareable: boolean,
  ): Promise<string> {
    const resolved = resolveByPrefix(
      await this.list(personKey, { limit: 200 }),
      idOrPrefix,
    );
    if ('error' in resolved) return resolved.error;
    if (resolved.record.sensitivity === 'sensitive') {
      return '该条记忆被标记为敏感，不能用于群聊。';
    }
    await this.memories.update(resolved.record.id, { shareableInGroup: shareable });
    return shareable
      ? `已允许在群聊中召回：${clip(resolved.record.content, 80)}`
      : `已设为仅本人可见：${clip(resolved.record.content, 80)}`;
  }

  public async forget(
    personKey: string,
    idOrPrefix: string,
  ): Promise<string> {
    const resolved = resolveByPrefix(
      await this.list(personKey, { limit: 200 }),
      idOrPrefix,
    );
    if ('error' in resolved) return resolved.error;
    const removed = await this.memories.remove(resolved.record.id);
    return removed
      ? `已删除个人记忆：${clip(resolved.record.content, 80)}`
      : '删除失败，记忆可能已被移除。';
  }

  public async handleCommand(
    message: InboundMessage,
    args: string[],
    personKey: string,
  ): Promise<string> {
    if (message.conversationType !== '1') {
      return '个人记忆只能在单聊中查看和管理，避免在群里暴露个人信息。';
    }
    if (!personKey.trim()) return '无法识别你的个人身份，请稍后再试。';
    const [action, ...rest] = args;
    switch (action?.toLowerCase()) {
      case undefined:
      case 'list':
        return this.formatList(await this.list(personKey, { limit: 20 }), false);
      case 'search': {
        const query = rest.join(' ').trim();
        if (!query) return '用法：`/memory search <关键词>`。';
        return this.formatList(
          await this.list(personKey, { query, limit: 20 }),
          true,
        );
      }
      case 'add': {
        const { text, share } = parseShareFlag(rest);
        if (!text) return '用法：`/memory add [--share] <内容>`。';
        return this.add({
          personKey,
          conversationId: message.conversationId,
          messageId: message.messageId,
          content: text,
          shareableInGroup: share,
        });
      }
      case 'share':
      case 'private': {
        const id = rest[0]?.trim();
        if (!id) {
          return `用法：\`/memory ${action} <ID>\`。`;
        }
        return this.setShareable(personKey, id, action === 'share');
      }
      case 'forget':
        return this.forget(personKey, rest[0] ?? '');
      default:
        return USAGE;
    }
  }

  private formatList(
    records: SemanticMemoryRecord[],
    searched: boolean,
  ): string {
    if (records.length === 0) {
      return searched
        ? '没有找到匹配的个人记忆。'
        : '你还没有个人记忆；发送 `/memory add <内容>` 添加。';
    }
    return [
      searched ? '匹配的个人记忆：' : '【个人记忆】',
      ...records.map(
        (record) =>
          `- ${record.id.slice(0, 8)} · ${clip(record.content, 160)}（${record.shareableInGroup ? '群聊可用' : '仅本人'} · 更新 ${formatShanghaiDateTime(record.updatedAt)}）`,
      ),
      '调整：`/memory share|private <ID>`，删除：`/memory forget <ID>`。',
    ].join('\n');
  }
}
