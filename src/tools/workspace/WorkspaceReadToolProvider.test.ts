import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionContext, ToolDefinition } from '../../types/core.js';
import { WorkspaceReadToolProvider } from './WorkspaceReadToolProvider.js';

const ctx: ExecutionContext = {
  conversationId: 'conv-workspace',
  messageId: 'msg-workspace',
  senderStaffId: 'staff-1',
  senderNick: '张三',
  conversationType: '1',
  deadlineAt: Date.now() + 60_000,
  now: () => Date.now(),
};

describe('WorkspaceReadToolProvider', () => {
  let workDir: string;
  let outsideFile: string;
  let provider: WorkspaceReadToolProvider;
  let tool: ToolDefinition;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'workspace-read-'));
    outsideFile = join(tmpdir(), `outside-${Date.now()}.txt`);
    await writeFile(outsideFile, '机密内容', 'utf8');
    await mkdir(join(workDir, 'attachments', 'msg-1'), { recursive: true });
    await writeFile(
      join(workDir, 'attachments', 'msg-1', '0-sales.csv'),
      '月份,收入\n1月,100\n2月,200\n',
      'utf8',
    );
    await writeFile(join(workDir, 'notes.md'), '# 标题\n正文\n', 'utf8');
    await writeFile(join(workDir, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(workDir, 'big.txt'), 'x'.repeat(10_000), 'utf8');
    await symlink(outsideFile, join(workDir, 'escape.txt'));
    provider = new WorkspaceReadToolProvider({ workspace: { hostDir: workDir, sandboxDir: '/workspace' } });
    const found = (await provider.getTools(ctx)).find(
      (item) => item.name === 'workspace_read_file',
    );
    if (!found) throw new Error('missing workspace_read_file');
    tool = found;
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
    await rm(outsideFile, { force: true });
  });

  it('读取相对路径附件并返回行数', async () => {
    const output = await tool.executeStructured!(
      { path: 'attachments/msg-1/0-sales.csv' },
      ctx,
    );
    expect(output.text).toContain('文件：attachments/msg-1/0-sales.csv');
    expect(output.text).toContain('行数：3');
    expect(output.text).toContain('1月,100');
    expect(output.summary).toContain('0-sales.csv');
  });

  it('接受工作区内绝对路径', async () => {
    const output = await tool.executeStructured!(
      { path: join(workDir, 'notes.md') },
      ctx,
    );
    expect(output.text).toContain('# 标题');
  });

  it('拒绝工作区外的路径与符号链接逃逸', async () => {
    await expect(
      tool.executeStructured!({ path: '../outside.txt' }, ctx),
    ).rejects.toThrow('只能读取工作区内的文件');
    await expect(
      tool.executeStructured!({ path: outsideFile }, ctx),
    ).rejects.toThrow('只能读取工作区内的文件');
    await expect(
      tool.executeStructured!({ path: 'escape.txt' }, ctx),
    ).rejects.toThrow('只能读取工作区内的文件');
  });

  it('拒绝二进制文件', async () => {
    await expect(
      tool.executeStructured!({ path: 'binary.bin' }, ctx),
    ).rejects.toThrow('二进制');
  });

  it('按 maxChars 截断长文本', async () => {
    const output = await tool.executeStructured!(
      { path: 'big.txt', maxChars: 300 },
      ctx,
    );
    expect(output.truncated).toBe(true);
    expect(output.text.length).toBeLessThan(1_000);
  });

  it('超过单次读取上限时提示改用沙盒', async () => {
    const small = new WorkspaceReadToolProvider({
      workspace: { hostDir: workDir, sandboxDir: '/workspace' },
      maxFileBytes: 1_000,
    });
    const smallTool = (await small.getTools(ctx)).find(
      (item) => item.name === 'workspace_read_file',
    )!;
    await expect(
      smallTool.executeStructured!({ path: 'big.txt' }, ctx),
    ).rejects.toThrow('sandbox_analyze_and_aggregate');
  });
});
