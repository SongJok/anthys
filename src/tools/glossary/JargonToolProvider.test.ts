import { describe, expect, it } from 'vitest';
import { JargonToolProvider } from './JargonToolProvider.js';
import type {
  GroupArchiveSummary,
  GroupTranscriptArchive,
} from '../../bystander/GroupTranscriptArchive.js';
import type { TranscriptEntry } from '../../types/bystander-and-memory.js';
import type {
  GlossaryCandidate,
  GlossaryCandidateInput,
} from '../../types/glossary-candidates.js';
import type { ExecutionContext } from '../../types/core.js';

function ctx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    conversationId: 'cid-1',
    messageId: 'msg-1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    conversationType: '2',
    deadlineAt: Date.now() + 60_000,
    now: Date.now,
    ...overrides,
  };
}

function entry(overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    conversationId: 'cid-1',
    messageId: 'm1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    text: '这个需求先拉齐一下',
    isAtBot: false,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

function fakeArchive(entries: TranscriptEntry[] = [entry()]) {
  const calls: Array<{ cid: string; limit?: number }> = [];
  const archive = {
    async read(cid: string, options?: { limit?: number }) {
      calls.push({ cid, ...(options?.limit !== undefined ? { limit: options.limit } : {}) });
      return entries.filter((item) => item.conversationId === cid);
    },
    async listGroups(): Promise<GroupArchiveSummary[]> {
      return [{ conversationId: 'cid-1', entryCount: entries.length, lastTimestamp: 1 }];
    },
  } as unknown as GroupTranscriptArchive;
  return { archive, calls };
}

function fakeCandidates() {
  const submitted: GlossaryCandidateInput[] = [];
  const port = {
    async submit(input: GlossaryCandidateInput): Promise<GlossaryCandidate> {
      submitted.push(input);
      return {
        id: 'cand-1',
        status: 'pending',
        standardName: input.standardName,
        aliases: input.aliases ?? [],
        definition: input.definition,
        usageScenarios: input.usageScenarios ?? '',
        examples: input.examples ?? [],
        misconceptions: input.misconceptions ?? '',
        department: input.department ?? '',
        timeliness: input.timeliness ?? 'long_term',
        sensitivity: input.sensitivity ?? 'team',
        docLinks: [],
        injectToPrompt: true,
        promptPriority: 0,
        sourceConversationId: input.sourceConversationId ?? '',
        evidence: input.evidence ?? '',
        submittedBy: input.submittedBy ?? '',
        reviewedBy: '',
        reviewedAt: null,
        reviewNote: '',
        glossaryTermId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    },
  };
  return { port, submitted };
}

async function tool(
  provider: JargonToolProvider,
  name: string,
  context: ExecutionContext = ctx(),
) {
  const tools = await provider.getTools(context);
  const found = tools.find((item) => item.name === name);
  if (!found) throw new Error(`tool not found: ${name}`);
  return found;
}

describe('JargonToolProvider', () => {
  it('启用时暴露读取与提交两个工具', async () => {
    const { archive } = fakeArchive();
    const { port } = fakeCandidates();
    const provider = new JargonToolProvider({ archive, candidates: port });
    const tools = await provider.getTools(ctx());
    expect(tools.map((item) => item.name).sort()).toEqual([
      'glossary_candidate_submit',
      'group_transcript_read',
    ]);
  });

  it('禁用时不暴露工具', async () => {
    const { archive } = fakeArchive();
    const { port } = fakeCandidates();
    const provider = new JargonToolProvider({
      archive,
      candidates: port,
      enabled: () => false,
    });
    expect(await provider.getTools(ctx())).toHaveLength(0);
  });

  it('读取当前群归档并格式化发言', async () => {
    const { archive, calls } = fakeArchive();
    const { port } = fakeCandidates();
    const provider = new JargonToolProvider({ archive, candidates: port });
    const read = await tool(provider, 'group_transcript_read');
    const text = await read.execute({}, ctx());
    expect(calls[0]?.cid).toBe('cid-1');
    expect(text).toContain('张三');
    expect(text).toContain('这个需求先拉齐一下');
  });

  it('非管理员不能跨群读取', async () => {
    const { archive } = fakeArchive();
    const { port } = fakeCandidates();
    const provider = new JargonToolProvider({ archive, candidates: port });
    const read = await tool(provider, 'group_transcript_read');
    const text = await read.execute({ conversationId: 'cid-other' }, ctx());
    expect(text).toContain('仅管理员');
  });

  it('管理员可跨群读取', async () => {
    const { archive, calls } = fakeArchive([entry({ conversationId: 'cid-other' })]);
    const { port } = fakeCandidates();
    const provider = new JargonToolProvider({
      archive,
      candidates: port,
      isAdmin: () => true,
    });
    const read = await tool(provider, 'group_transcript_read');
    await read.execute({ conversationId: 'cid-other' }, ctx());
    expect(calls[0]?.cid).toBe('cid-other');
  });

  it('listGroups 仅管理员可用', async () => {
    const { archive } = fakeArchive();
    const { port } = fakeCandidates();
    const provider = new JargonToolProvider({ archive, candidates: port });
    const read = await tool(provider, 'group_transcript_read');
    expect(await read.execute({ listGroups: true }, ctx())).toContain('仅管理员');

    const adminProvider = new JargonToolProvider({
      archive,
      candidates: port,
      isAdmin: () => true,
    });
    const adminRead = await tool(adminProvider, 'group_transcript_read');
    expect(await adminRead.execute({ listGroups: true }, ctx())).toContain('cid-1');
  });

  it('提交候选默认来源为当前群且标记待审批', async () => {
    const { archive } = fakeArchive();
    const { port, submitted } = fakeCandidates();
    const provider = new JargonToolProvider({ archive, candidates: port });
    const submit = await tool(provider, 'glossary_candidate_submit');
    const text = await submit.execute(
      { standardName: '拉齐', definition: '同步认知', evidence: '群里常说“拉齐一下”' },
      ctx(),
    );
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.sourceConversationId).toBe('cid-1');
    expect(submitted[0]?.submittedBy).toBe('staff-1');
    expect(text).toContain('待审批');
    expect(text).toContain('管理员');
  });

  it('提交缺少必填字段时拒绝', async () => {
    const { archive } = fakeArchive();
    const { port, submitted } = fakeCandidates();
    const provider = new JargonToolProvider({ archive, candidates: port });
    const submit = await tool(provider, 'glossary_candidate_submit');
    expect(await submit.execute({ definition: 'x' }, ctx())).toContain('standardName');
    expect(await submit.execute({ standardName: 'x' }, ctx())).toContain('definition');
    expect(submitted).toHaveLength(0);
  });

  it('提交非法时效性/敏感级别时拒绝', async () => {
    const { archive } = fakeArchive();
    const { port, submitted } = fakeCandidates();
    const provider = new JargonToolProvider({ archive, candidates: port });
    const submit = await tool(provider, 'glossary_candidate_submit');
    const text = await submit.execute(
      { standardName: 'x', definition: 'y', timeliness: 'bogus' },
      ctx(),
    );
    expect(text).toContain('timeliness');
    expect(submitted).toHaveLength(0);
  });
});