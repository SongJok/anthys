import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext, ToolDefinition } from '../../types/core.js';
import type {
  SemanticMemoryAdminFilter,
  SemanticMemoryAdminPort,
  SemanticMemoryPatch,
  SemanticMemoryRecord,
} from '../../types/bystander-and-memory.js';
import { PersonalMemoryService } from '../../personal/PersonalMemoryService.js';
import { PersonalMemoryToolProvider } from './PersonalMemoryToolProvider.js';

const NOW = 1_764_500_000_000;

function memoryAdmin(): SemanticMemoryAdminPort & {
  records: SemanticMemoryRecord[];
} {
  const records: SemanticMemoryRecord[] = [];
  return {
    records,
    async list(filter: SemanticMemoryAdminFilter) {
      const items = records.filter(
        (record) =>
          (filter.scope === undefined || record.scope === filter.scope) &&
          (filter.subjectKey === undefined ||
            record.subjectKey === filter.subjectKey),
      );
      return { total: items.length, items };
    },
    async get(id) {
      return records.find((record) => record.id === id) ?? null;
    },
    async update(id, patch: SemanticMemoryPatch) {
      const record = records.find((item) => item.id === id)!;
      Object.assign(record, patch);
      return record;
    },
    async remove() {
      return false;
    },
    async reassignSubjectKey() {
      return 0;
    },
  };
}

function context(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    conversationId: 'cid-1',
    messageId: 'msg-1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    conversationType: '1',
    personKey: 'staff:1',
    deadlineAt: NOW + 60_000,
    now: () => NOW,
    ...overrides,
  };
}

function setup() {
  const memories = memoryAdmin();
  const remember = vi.fn(async () => {});
  const service = new PersonalMemoryService({ memories, remember });
  return {
    memories,
    remember,
    provider: new PersonalMemoryToolProvider({ service }),
  };
}

async function toolsOf(
  provider: PersonalMemoryToolProvider,
  ctx: ExecutionContext,
): Promise<Map<string, ToolDefinition>> {
  return new Map((await provider.getTools(ctx)).map((tool) => [tool.name, tool]));
}

describe('PersonalMemoryToolProvider', () => {
  it('只在单聊且能识别身份时暴露工具', async () => {
    const { provider } = setup();
    expect(await provider.getTools(context({ conversationType: '2' }))).toEqual(
      [],
    );
    expect(await provider.getTools(context({ personKey: undefined }))).toEqual(
      [],
    );
    expect([...(await toolsOf(provider, context())).keys()]).toEqual([
      'personal_memory_list',
      'personal_memory_save',
      'personal_memory_set_sharing',
      'personal_memory_forget',
    ]);
  });

  it('保存工具默认仅本人可见并保留关键词', async () => {
    const { remember, provider } = setup();
    const save = (await toolsOf(provider, context())).get(
      'personal_memory_save',
    )!;
    const reply = await save.execute(
      { content: '负责华东区售后', keywords: ['售后', ' 华东 '] },
      context(),
    );
    expect(reply).toContain('仅你本人可见');
    expect(remember).toHaveBeenCalledWith({
      personKey: 'staff:1',
      conversationId: 'cid-1',
      messageId: 'msg-1',
      content: '负责华东区售后\n关键词：售后、华东',
      shareableInGroup: false,
    });

    await save.execute(
      { content: '公开偏好', shareableInGroup: true },
      context(),
    );
    expect(remember).toHaveBeenLastCalledWith(
      expect.objectContaining({ shareableInGroup: true }),
    );
  });

  it('列表工具只返回本人记忆', async () => {
    const { memories, provider } = setup();
    memories.records.push(
      {
        id: 'mem-0001',
        scope: 'user',
        subjectKey: 'staff:1',
        kind: 'profile',
        content: '偏好简洁回答',
        keywords: [],
        embedding: null,
        shareableInGroup: false,
        sensitivity: 'private',
        status: 'active',
        sourceConversationId: 'cid-1',
        sourceConversationType: '1',
        sourceMessageId: null,
        confidence: 0.95,
        expiresAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'mem-0002',
        scope: 'user',
        subjectKey: 'staff:2',
        kind: 'profile',
        content: '别人的记忆',
        keywords: [],
        embedding: null,
        shareableInGroup: false,
        sensitivity: 'private',
        status: 'active',
        sourceConversationId: 'cid-1',
        sourceConversationType: '1',
        sourceMessageId: null,
        confidence: 0.95,
        expiresAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    );
    const list = (await toolsOf(provider, context())).get(
      'personal_memory_list',
    )!;
    const reply = await list.execute({}, context());
    expect(reply).toContain('偏好简洁回答');
    expect(reply).not.toContain('别人的记忆');
  });
});
