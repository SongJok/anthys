import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext, ToolDefinition } from '../../types/core.js';
import type {
  ArtifactSendInput,
  ArtifactSendResult,
} from '../../dingtalk/MediaSender.js';
import { ArtifactToolProvider } from './ArtifactToolProvider.js';

function context(): ExecutionContext {
  return {
    conversationId: 'cid-1',
    messageId: 'msg-1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    conversationType: '1',
    deadlineAt: Date.now() + 60_000,
    now: () => Date.now(),
  };
}

describe('ArtifactToolProvider', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'artifact-root-'));
    outside = await mkdtemp(join(tmpdir(), 'artifact-outside-'));
    await writeFile(join(root, 'report.csv'), 'a,b\n1,2');
    await writeFile(join(outside, 'secret.txt'), 'secret');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  async function tool(send: (input: ArtifactSendInput) => Promise<ArtifactSendResult>, maxBytes = 1024): Promise<ToolDefinition> {
    const provider = new ArtifactToolProvider({
      sender: { send },
      allowedRoots: [root],
      maxBytes,
    });
    const tools = await provider.getTools(context());
    return tools[0]!;
  }

  it('相对路径按工作区解析并投递', async () => {
    const send = vi.fn().mockResolvedValue({
      ok: true,
      fileName: 'report.csv',
      fileSize: 8,
      mediaId: 'm-1',
    } satisfies ArtifactSendResult);
    const deliver = await tool(send);

    expect(deliver.name).toBe('deliver_artifact');
    expect(deliver.risk).toBe('write');
    const output = JSON.parse(
      await deliver.execute({ path: 'report.csv' }, context()),
    ) as Record<string, unknown>;
    expect(output).toMatchObject({ ok: true, fileName: 'report.csv' });

    const input = send.mock.calls[0]![0] as ArtifactSendInput;
    expect(input).toMatchObject({
      conversationId: 'cid-1',
      conversationType: '1',
      senderStaffId: 'staff-1',
      fileName: 'report.csv',
    });
    expect(input.filePath).toBe(resolve(root, 'report.csv').replace(/^\/var\//u, '/private/var/'));
  });

  it('拒绝发送工作区之外的文件', async () => {
    const send = vi.fn();
    const deliver = await tool(send);
    await expect(
      deliver.execute({ path: join(outside, 'secret.txt') }, context()),
    ).rejects.toThrow('工作区');
    expect(send).not.toHaveBeenCalled();
  });

  it('拒绝路径穿越', async () => {
    const send = vi.fn();
    const deliver = await tool(send);
    await expect(
      deliver.execute({ path: '../artifact-outside/secret.txt' }, context()),
    ).rejects.toThrow(/工作区|不存在/);
    expect(send).not.toHaveBeenCalled();
  });

  it('文件不存在时抛出可读错误', async () => {
    const deliver = await tool(vi.fn());
    await expect(
      deliver.execute({ path: 'missing.csv' }, context()),
    ).rejects.toThrow('文件不存在');
  });

  it('超过上限的文件不发送', async () => {
    const send = vi.fn();
    const deliver = await tool(send, 2);
    await expect(
      deliver.execute({ path: 'report.csv' }, context()),
    ).rejects.toThrow('上限');
    expect(send).not.toHaveBeenCalled();
  });

  it('发送失败时把错误抛给模型', async () => {
    const send = vi.fn().mockResolvedValue({
      ok: false,
      fileName: 'report.csv',
      fileSize: 8,
      error: 'HTTP 500',
    } satisfies ArtifactSendResult);
    const deliver = await tool(send);
    await expect(
      deliver.execute({ path: 'report.csv' }, context()),
    ).rejects.toThrow('HTTP 500');
  });

  it('artifact_generate 生成 xlsx 并自动投递到当前会话', async () => {
    const send = vi.fn().mockResolvedValue({
      ok: true,
      fileName: '指标.xlsx',
      fileSize: 1200,
      mediaId: 'm-xlsx',
    } satisfies ArtifactSendResult);
    const provider = new ArtifactToolProvider({
      sender: { send },
      allowedRoots: [root],
      maxBytes: 1024 * 1024,
    });
    const tools = await provider.getTools(context());
    const gen = tools.find((t) => t.name === 'artifact_generate');
    expect(gen).toBeDefined();

    const output = JSON.parse(
      await gen!.execute(
        {
          format: 'xlsx',
          fileName: '指标.xlsx',
          sheets: [{ name: '汇总', headers: ['项', '值'], rows: [['PV', 42]] }],
        },
        context(),
      ),
    ) as Record<string, unknown>;
    expect(output).toMatchObject({
      ok: true,
      delivered: true,
      fileName: '指标.xlsx',
      format: 'xlsx',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('artifact_generate 支持 deliver=false 仅落盘，随后由 deliver_artifact 发送', async () => {
    const send = vi.fn().mockResolvedValue({
      ok: true,
      fileName: 'note.md',
      fileSize: 10,
      mediaId: 'm-md',
    } satisfies ArtifactSendResult);
    const provider = new ArtifactToolProvider({
      sender: { send },
      allowedRoots: [root],
      maxBytes: 1024 * 1024,
    });
    const tools = await provider.getTools(context());
    const gen = tools.find((t) => t.name === 'artifact_generate')!;
    const deliver = tools.find((t) => t.name === 'deliver_artifact')!;

    const genOut = JSON.parse(
      await gen.execute(
        {
          format: 'md',
          fileName: 'note.md',
          content: '# 标题\n正文',
          deliver: false,
        },
        context(),
      ),
    ) as { ok: boolean; delivered: boolean; path: string };
    expect(genOut.ok).toBe(true);
    expect(genOut.delivered).toBe(false);
    expect(send).not.toHaveBeenCalled();

    const deliverOut = JSON.parse(
      await deliver.execute({ path: genOut.path }, context()),
    ) as { ok: boolean };
    expect(deliverOut.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
