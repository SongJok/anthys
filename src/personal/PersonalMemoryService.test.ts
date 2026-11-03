import { describe, expect, it, vi } from 'vitest';
import type { InboundMessage } from '../types/core.js';
import type {
  SemanticMemoryAdminFilter,
  SemanticMemoryAdminPort,
  SemanticMemoryPatch,
  SemanticMemoryRecord,
} from '../types/bystander-and-memory.js';
import { PersonalMemoryService } from './PersonalMemoryService.js';

const NOW = 1_764_500_000_000;

class MemorySemanticStore implements SemanticMemoryAdminPort {
  public readonly records: SemanticMemoryRecord[] = [];

  public async list(
    filter: SemanticMemoryAdminFilter,
  ): Promise<{ total: number; items: SemanticMemoryRecord[] }> {
    const query = filter.query?.trim();
    const items = this.records.filter(
      (record) =>
        (filter.scope === undefined || record.scope === filter.scope) &&
        (filter.subjectKey === undefined ||
          record.subjectKey === filter.subjectKey) &&
        (filter.status === undefined || record.status === filter.status) &&
        (!query || record.content.includes(query)),
    );
    return { total: items.length, items: items.slice(0, filter.limit ?? 20) };
  }

  public async get(id: string): Promise<SemanticMemoryRecord | null> {
    return this.records.find((record) => record.id === id) ?? null;
  }

  public async update(
    id: string,
    patch: SemanticMemoryPatch,
  ): Promise<SemanticMemoryRecord> {
    const record = this.records.find((item) => item.id === id);
    if (!record) throw new Error('missing');
    Object.assign(record, patch, { updatedAt: NOW });
    return record;
  }

  public async remove(id: string): Promise<boolean> {
    const index = this.records.findIndex((record) => record.id === id);
    if (index < 0) return false;
    this.records.splice(index, 1);
    return true;
  }

  public async reassignSubjectKey(): Promise<number> {
    return 0;
  }
}

function record(
  overrides: Partial<SemanticMemoryRecord> = {},
): SemanticMemoryRecord {
  return {
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
    ...overrides,
  };
}

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'msg-1',
    conversationId: 'cid-1',
    conversationType: '1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    isAtBot: true,
    text: '',
    rawPayload: {},
    timestamp: NOW,
    ...overrides,
  };
}

function setup() {
  const memories = new MemorySemanticStore();
  const remember = vi.fn(async () => {});
  const service = new PersonalMemoryService({ memories, remember });
  return { memories, remember, service };
}

describe('PersonalMemoryService', () => {
  it('群聊拒绝个人记忆操作，单聊可查看本人条目', async () => {
    const { memories, service } = setup();
    memories.records.push(
      record(),
      record({ id: 'mem-0002', subjectKey: 'staff:2', content: '别人的记忆' }),
    );

    expect(
      await service.handleCommand(
        message({ conversationType: '2' }),
        ['list'],
        'staff:1',
      ),
    ).toContain('只能在单聊中');

    const list = await service.handleCommand(message(), [], 'staff:1');
    expect(list).toContain('偏好简洁回答');
    expect(list).not.toContain('别人的记忆');
    expect(list).toContain('仅本人');
  });

  it('添加记忆时写入本人画像并尊重 --share', async () => {
    const { remember, service } = setup();
    const reply = await service.handleCommand(
      message(),
      ['add', '--share', '负责华东区售后'],
      'staff:1',
    );
    expect(reply).toContain('允许在群聊中');
    expect(remember).toHaveBeenCalledWith({
      personKey: 'staff:1',
      conversationId: 'cid-1',
      messageId: 'msg-1',
      content: '负责华东区售后',
      shareableInGroup: true,
    });
  });

  it('可调整共享范围，敏感记忆不允许进入群聊', async () => {
    const { memories, service } = setup();
    memories.records.push(
      record(),
      record({ id: 'mem-0002', sensitivity: 'sensitive', content: '敏感信息' }),
    );

    const shared = await service.handleCommand(
      message(),
      ['share', 'mem-0001'],
      'staff:1',
    );
    expect(shared).toContain('已允许在群聊中召回');
    expect(memories.records[0]!.shareableInGroup).toBe(true);

    const sensitive = await service.handleCommand(
      message(),
      ['share', 'mem-0002'],
      'staff:1',
    );
    expect(sensitive).toContain('敏感');
    expect(memories.records[1]!.shareableInGroup).toBe(false);

    const privateReply = await service.handleCommand(
      message(),
      ['private', 'mem-0001'],
      'staff:1',
    );
    expect(privateReply).toContain('仅本人可见');
    expect(memories.records[0]!.shareableInGroup).toBe(false);
  });

  it('搜索与删除只作用于本人记忆', async () => {
    const { memories, service } = setup();
    memories.records.push(
      record({ content: '每周五复盘' }),
      record({ id: 'mem-0002', subjectKey: 'staff:2', content: '别人的周五安排' }),
    );

    const searched = await service.handleCommand(
      message(),
      ['search', '周五'],
      'staff:1',
    );
    expect(searched).toContain('每周五复盘');
    expect(searched).not.toContain('别人的周五安排');

    const removed = await service.handleCommand(
      message(),
      ['forget', 'mem-0001'],
      'staff:1',
    );
    expect(removed).toContain('已删除个人记忆');
    expect(memories.records.map((item) => item.id)).toEqual(['mem-0002']);
  });
});
