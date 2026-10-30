import { describe, expect, it } from 'vitest';
import { GlossaryToolProvider } from './GlossaryToolProvider.js';
import type {
  GlossaryLookupInput,
  GlossaryLookupResult,
  GlossaryTerm,
} from '../../types/glossary.js';
import type { ExecutionContext } from '../../types/core.js';

function term(
  overrides: Partial<GlossaryTerm> & { id: string; standardName: string },
): GlossaryTerm {
  return {
    aliases: [],
    definition: `${overrides.standardName} 的定义`,
    usageScenarios: '',
    examples: [],
    misconceptions: '',
    department: '',
    timeliness: 'long_term',
    sensitivity: 'team',
    docLinks: [],
    injectToPrompt: true,
    promptPriority: 0,
    hitCount: 0,
    lastUpdatedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'tester',
    ...overrides,
  };
}

function context(conversationType: '1' | '2'): ExecutionContext {
  return {
    conversationId: 'cid-1',
    messageId: 'msg-1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    conversationType,
    deadlineAt: Date.now() + 10_000,
    now: Date.now,
  };
}

class FakeService {
  public hasTermsValue = true;
  public readonly calls: Array<{ term: string; input: GlossaryLookupInput }> = [];

  constructor(private readonly result: GlossaryLookupResult) {}

  async hasTerms(): Promise<boolean> {
    return this.hasTermsValue;
  }

  async lookup(
    term: string,
    input: GlossaryLookupInput,
  ): Promise<GlossaryLookupResult> {
    this.calls.push({ term, input });
    return this.result;
  }

  formatCard(item: GlossaryTerm): string {
    return `CARD:${item.standardName}`;
  }
}

describe('GlossaryToolProvider', () => {
  it('术语库为空时不暴露工具，避免浪费模型上下文', async () => {
    const service = new FakeService({ exact: [], related: [] });
    service.hasTermsValue = false;
    const provider = new GlossaryToolProvider({ service });
    expect(await provider.getTools(context('1'))).toEqual([]);
  });

  it('查询命中时返回精确卡片、相关卡片与来源信息', async () => {
    const exact = term({
      id: 'g-1',
      standardName: 'CQ',
      aliases: ['变更请求'],
      definition: '变更请求单',
    });
    const related = term({ id: 'g-2', standardName: 'CQ 预算' });
    const service = new FakeService({ exact: [exact], related: [related] });
    const provider = new GlossaryToolProvider({ service });

    const [tool] = await provider.getTools(context('1'));
    expect(tool?.name).toBe('glossary_lookup');
    expect(tool?.risk).toBe('read');

    const output = await tool!.execute(
      { term: 'CQ', limit: 3 },
      context('1'),
    );
    expect(output).toContain('## 精确匹配');
    expect(output).toContain('CARD:CQ');
    expect(output).toContain('## 相关术语');
    expect(output).toContain('CARD:CQ 预算');
    expect(service.calls[0]).toMatchObject({
      term: 'CQ',
      input: { conversationType: '1', limit: 3 },
    });
  });

  it('未收录时提示向提问者确认，群聊额外说明敏感排除', async () => {
    const service = new FakeService({ exact: [], related: [] });
    const provider = new GlossaryToolProvider({ service });
    const [tool] = await provider.getTools(context('2'));

    const output = await tool!.execute({ term: 'XYZ' }, context('2'));
    expect(output).toContain('未收录');
    expect(output).toContain('不要凭空猜测');
    expect(output).not.toContain('敏感级别术语已自动排除');

    const related = term({ id: 'g-2', standardName: '相关术语' });
    const hitService = new FakeService({ exact: [], related: [related] });
    const hitProvider = new GlossaryToolProvider({ service: hitService });
    const [hitTool] = await hitProvider.getTools(context('2'));
    const hitOutput = await hitTool!.execute({ term: 'XYZ' }, context('2'));
    expect(hitOutput).toContain('当前为群聊，敏感级别术语已自动排除。');
  });

  it('拒绝空术语参数', async () => {
    const service = new FakeService({ exact: [], related: [] });
    const provider = new GlossaryToolProvider({ service });
    const [tool] = await provider.getTools(context('1'));
    await expect(tool!.execute({ term: '  ' }, context('1'))).rejects.toThrow(
      'term',
    );
  });
});
