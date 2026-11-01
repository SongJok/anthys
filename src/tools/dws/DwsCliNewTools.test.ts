import { readFile, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { ExecutionContext, ToolDefinition } from '../../types/core.js';
import type { DwsCommandRequest } from '../../types/mcp-and-sandbox.js';
import { DwsCliToolProvider } from './DwsCliToolProvider.js';
import type { DwsCliRunner, DwsRunResult } from './DwsCliRunner.js';

const ctx: ExecutionContext = {
  conversationId: 'conv-dws',
  messageId: 'msg-dws',
  senderStaffId: 'staff-1',
  senderNick: '张三',
  conversationType: '1',
  deadlineAt: Date.now() + 60_000,
  now: () => Date.now(),
};

function succeeded(request: DwsCommandRequest): DwsRunResult {
  return {
    command: ['dws', ...request.subcommand.split(' ')],
    exitCode: 0,
    stdout: '{"ok":true}',
    stderr: '',
    truncated: false,
    page: 1,
    totalPages: 1,
    hasMore: false,
    timedOut: false,
  };
}

function setup(): {
  provider: DwsCliToolProvider;
  runs: DwsCommandRequest[];
  files: Map<string, string>;
} {
  const runs: DwsCommandRequest[] = [];
  const files = new Map<string, string>();
  const runner = {
    run: async (request: DwsCommandRequest) => {
      runs.push(request);
      for (const flag of ['content-file', 'contents-file']) {
        const path = request.flags[flag];
        if (typeof path === 'string') {
          files.set(flag, await readFile(path, 'utf8'));
        }
      }
      return succeeded(request);
    },
  } as unknown as DwsCliRunner;
  return { provider: new DwsCliToolProvider({ runner }), runs, files };
}

async function tool(
  provider: DwsCliToolProvider,
  name: string,
): Promise<ToolDefinition> {
  const found = (await provider.getTools(ctx)).find((item) => item.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
}

describe('DWS 文档写工具', () => {
  it('create 用临时文件传递 Markdown，执行后清理', async () => {
    const { provider, runs, files } = setup();
    const docTool = await tool(provider, 'dws_doc_manage');
    const content = '# 周报\n\n本周完成 **三件事**。';
    await docTool.execute(
      { action: 'create', name: '周报', content, folder: 'folder-1' },
      ctx,
    );
    expect(runs[0]).toMatchObject({
      domain: 'doc',
      subcommand: 'create',
      flags: { name: '周报', folder: 'folder-1', 'content-format': 'markdown' },
    });
    expect(files.get('content-file')).toBe(content);
    const path = runs[0]!.flags['content-file'] as string;
    await expect(stat(path)).rejects.toThrow();
  });

  it('append 追加且不会带 yes；overwrite 需要显式确认', async () => {
    const { provider, runs } = setup();
    const docTool = await tool(provider, 'dws_doc_manage');
    await docTool.execute(
      { action: 'append', documentId: 'doc-1', content: '补充' },
      ctx,
    );
    expect(runs[0]).toMatchObject({
      domain: 'doc',
      subcommand: 'update',
      flags: { node: 'doc-1', mode: 'append' },
    });
    expect(runs[0]!.flags.yes).toBeUndefined();

    await expect(
      docTool.execute(
        { action: 'overwrite', documentId: 'doc-1', content: '新内容' },
        ctx,
      ),
    ).rejects.toThrow('confirmOverwrite=true');

    await docTool.execute(
      {
        action: 'overwrite',
        documentId: 'doc-1',
        content: '新内容',
        confirmOverwrite: true,
      },
      ctx,
    );
    expect(runs[1]).toMatchObject({
      flags: { node: 'doc-1', mode: 'overwrite', yes: true },
    });
  });

  it('拒绝超长文档内容', async () => {
    const { provider } = setup();
    const docTool = await tool(provider, 'dws_doc_manage');
    await expect(
      docTool.execute(
        { action: 'create', name: '长文', content: 'x'.repeat(30_001) },
        ctx,
      ),
    ).rejects.toThrow('30000');
  });
});

describe('DWS 日志工具', () => {
  it('inbox 必须提供时间范围并传递过滤条件', async () => {
    const { provider, runs } = setup();
    const report = await tool(provider, 'dws_report_read');
    await expect(report.execute({ action: 'inbox' }, ctx)).rejects.toThrow(
      'start 与 end',
    );
    await report.execute(
      {
        action: 'inbox',
        start: '2026-03-01T00:00:00+08:00',
        end: '2026-03-10T23:59:59+08:00',
        senderUserIds: ['u1', 'u2'],
        size: 20,
      },
      ctx,
    );
    expect(runs[0]).toMatchObject({
      domain: 'report',
      subcommand: 'inbox list',
      flags: {
        start: '2026-03-01T00:00:00+08:00',
        end: '2026-03-10T23:59:59+08:00',
        'sender-user-ids': 'u1,u2',
        size: 20,
      },
    });
  });

  it('template get 与 entry get 使用正确参数名', async () => {
    const { provider, runs } = setup();
    const report = await tool(provider, 'dws_report_read');
    await report.execute({ action: 'template', templateName: '日报' }, ctx);
    expect(runs[0]).toMatchObject({
      subcommand: 'template get',
      flags: { name: '日报' },
    });
    await report.execute({ action: 'entry', reportId: 'r-1' }, ctx);
    expect(runs[1]).toMatchObject({
      subcommand: 'entry get',
      flags: { 'report-id': 'r-1' },
    });
  });

  it('submit 规范化字段并通过 contents-file 提交', async () => {
    const { provider, runs, files } = setup();
    const submit = await tool(provider, 'dws_report_submit');
    await expect(
      submit.execute(
        { templateId: 'tpl-1', contents: [], toUserIds: ['u1'] },
        ctx,
      ),
    ).rejects.toThrow('非空数组');
    await expect(
      submit.execute(
        {
          templateId: 'tpl-1',
          contents: [{ key: '今日完成', content: '联调' }],
          toUserIds: [],
        },
        ctx,
      ),
    ).rejects.toThrow('至少需要一个接收人');

    await submit.execute(
      {
        templateId: 'tpl-1',
        contents: [
          { key: '今日完成', content: '联调' },
          { key: '明日计划', content: '上线', sort: '1' },
        ],
        toUserIds: ['u1', 'u2'],
        toChat: true,
      },
      ctx,
    );
    expect(runs[0]).toMatchObject({
      domain: 'report',
      subcommand: 'entry submit',
      flags: { 'template-id': 'tpl-1', 'to-user-ids': 'u1,u2', 'to-chat': true },
    });
    expect(JSON.parse(files.get('contents-file')!)).toEqual([
      {
        key: '今日完成',
        sort: '0',
        content: '联调',
        contentType: 'markdown',
        type: '1',
      },
      {
        key: '明日计划',
        sort: '1',
        content: '上线',
        contentType: 'markdown',
        type: '1',
      },
    ]);
  });
});

describe('DWS AI 表格工具', () => {
  it('record query 传递过滤、排序与字段列表', async () => {
    const { provider, runs } = setup();
    const aitable = await tool(provider, 'dws_aitable');
    await aitable.execute(
      {
        action: 'record_query',
        baseId: 'base-1',
        tableId: 'tbl-1',
        query: '华东',
        fieldIds: ['fldA', 'fldB'],
        limit: 50,
        filters: {
          operator: 'and',
          operands: [{ operator: 'eq', operands: ['fldA', '本科'] }],
        },
        sort: [{ fieldId: 'fldA', direction: 'desc' }],
      },
      ctx,
    );
    expect(runs[0]).toMatchObject({
      domain: 'aitable',
      subcommand: 'record query',
      flags: {
        'base-id': 'base-1',
        'table-id': 'tbl-1',
        query: '华东',
        'field-ids': 'fldA,fldB',
        limit: 50,
      },
    });
    expect(JSON.parse(runs[0]!.flags.filters as string)).toMatchObject({
      operator: 'and',
    });
    expect(JSON.parse(runs[0]!.flags.sort as string)).toEqual([
      { fieldId: 'fldA', direction: 'desc' },
    ]);
  });

  it('record stats 必须提供 stats，limit 上限按动作校验', async () => {
    const { provider } = setup();
    const aitable = await tool(provider, 'dws_aitable');
    await expect(
      aitable.execute(
        { action: 'record_stats', baseId: 'b', tableId: 't' },
        ctx,
      ),
    ).rejects.toThrow('必须提供 stats');
    await expect(
      aitable.execute(
        { action: 'record_query', baseId: 'b', tableId: 't', limit: 101 },
        ctx,
      ),
    ).rejects.toThrow('limit 最大为 100');
  });
});

describe('DWS 听记工具', () => {
  it('list 默认 mine，search 至少一个条件，详情必须有 id', async () => {
    const { provider, runs } = setup();
    const minutes = await tool(provider, 'dws_minutes');
    await minutes.execute({ action: 'list' }, ctx);
    expect(runs[0]).toMatchObject({
      subcommand: 'list mine',
      flags: {},
    });
    await minutes.execute({ action: 'list', scope: 'all', limit: 5 }, ctx);
    expect(runs[1]).toMatchObject({
      subcommand: 'list all',
      flags: { limit: 5 },
    });
    await expect(minutes.execute({ action: 'search' }, ctx)).rejects.toThrow(
      '至少提供',
    );
    await expect(minutes.execute({ action: 'summary' }, ctx)).rejects.toThrow(
      '必须提供 id',
    );
  });

  it('transcript 传 direction，action_items 可不带 id', async () => {
    const { provider, runs } = setup();
    const minutes = await tool(provider, 'dws_minutes');
    await minutes.execute(
      { action: 'transcript', id: 'task-1', direction: '1' },
      ctx,
    );
    expect(runs[0]).toMatchObject({
      subcommand: 'get transcription',
      flags: { id: 'task-1', direction: '1' },
    });
    await minutes.execute({ action: 'action_items' }, ctx);
    expect(runs[1]).toMatchObject({ subcommand: '+action-items', flags: {} });
  });
});
