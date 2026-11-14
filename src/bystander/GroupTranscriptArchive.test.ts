import { mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GroupTranscriptArchive } from './GroupTranscriptArchive.js';
import { GroupTranscriptBuffer } from './GroupTranscriptBuffer.js';
import type { TranscriptEntry } from '../types/bystander-and-memory.js';

function entry(overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    conversationId: 'cid-1',
    messageId: 'msg-1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    text: '这个需求先挂起',
    isAtBot: false,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe('GroupTranscriptArchive', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'group-archive-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('按群追加 JSONL 并可读回', async () => {
    const archive = new GroupTranscriptArchive({ dir });
    expect(await archive.append(entry())).toBe(true);
    expect(
      await archive.append(entry({ messageId: 'msg-2', text: '黑话真多' })),
    ).toBe(true);

    const entries = await archive.read('cid-1');
    expect(entries.map((item) => item.messageId)).toEqual(['msg-1', 'msg-2']);

    const raw = await readFile(archive.filePathFor('cid-1'), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(2);
  });

  it('同一 messageId 只落盘一次', async () => {
    const archive = new GroupTranscriptArchive({ dir });
    expect(await archive.append(entry())).toBe(true);
    expect(await archive.append(entry({ text: '重投内容' }))).toBe(false);
    expect(await archive.read('cid-1')).toHaveLength(1);
  });

  it('跨重启仍按 messageId 去重', async () => {
    const first = new GroupTranscriptArchive({ dir });
    await first.append(entry());
    const second = new GroupTranscriptArchive({ dir });
    expect(await second.append(entry())).toBe(false);
    expect(await second.append(entry({ messageId: 'msg-9' }))).toBe(true);
    expect(await second.read('cid-1')).toHaveLength(2);
  });

  it('忽略系统播报与空文本', async () => {
    const archive = new GroupTranscriptArchive({ dir });
    expect(await archive.append(entry({ senderStaffId: 'scheduler' }))).toBe(
      false,
    );
    expect(await archive.append(entry({ text: '   ' }))).toBe(false);
    expect(await archive.read('cid-1')).toHaveLength(0);
  });

  it('read 默认只返回最近若干条', async () => {
    const archive = new GroupTranscriptArchive({ dir });
    for (let index = 0; index < 5; index += 1) {
      await archive.append(entry({ messageId: `m${index}`, timestamp: index }));
    }
    const recent = await archive.read('cid-1', { limit: 2 });
    expect(recent.map((item) => item.messageId)).toEqual(['m3', 'm4']);
  });

  it('listGroups 汇总条数与最后发言时间', async () => {
    const archive = new GroupTranscriptArchive({ dir });
    await archive.append(entry({ conversationId: 'cid-a', timestamp: 10 }));
    await archive.append(
      entry({ conversationId: 'cid-b', messageId: 'b1', timestamp: 20 }),
    );
    await archive.append(
      entry({ conversationId: 'cid-b', messageId: 'b2', timestamp: 30 }),
    );

    const groups = await archive.listGroups();
    expect(groups[0]).toMatchObject({ conversationId: 'cid-b', entryCount: 2 });
    expect(groups[1]).toMatchObject({ conversationId: 'cid-a', entryCount: 1 });
  });

  it('含 base64 特殊字符的 conversationId 也能安全落盘', async () => {
    const archive = new GroupTranscriptArchive({ dir });
    const cid = 'cidAB+/==';
    expect(await archive.append(entry({ conversationId: cid }))).toBe(true);
    expect(await archive.read(cid)).toHaveLength(1);
    expect((await archive.listGroups())[0]?.conversationId).toBe(cid);
  });

  it('不同群互不串档', async () => {
    const archive = new GroupTranscriptArchive({ dir });
    await archive.append(entry({ conversationId: 'cid-1' }));
    await archive.append(entry({ conversationId: 'cid-2', messageId: 'x' }));
    expect(await archive.read('cid-1')).toHaveLength(1);
    expect(await archive.read('cid-2')).toHaveLength(1);
  });

  it('pruneOlderThan 按 mtime 统计或清理过期群归档文件', async () => {
    const archive = new GroupTranscriptArchive({
      dir,
      maxSeenConversations: 2,
      maxSeenPerConversation: 2,
    });
    await archive.append(entry({ conversationId: 'cid-old', messageId: 'm1' }));
    await archive.append(entry({ conversationId: 'cid-new', messageId: 'm2' }));
    const oldTime = new Date(Date.now() - 10 * 86_400_000);
    await utimes(archive.filePathFor('cid-old'), oldTime, oldTime);

    const cutoff = Date.now() - 5 * 86_400_000;
    expect(await archive.pruneOlderThan(cutoff, { dryRun: true })).toBe(1);
    await expect(stat(archive.filePathFor('cid-old'))).resolves.toBeTruthy();

    expect(await archive.pruneOlderThan(cutoff)).toBe(1);
    await expect(stat(archive.filePathFor('cid-old'))).rejects.toThrow();
    await expect(stat(archive.filePathFor('cid-new'))).resolves.toBeTruthy();
  });
});

describe('GroupTranscriptArchive 有界化', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'group-archive-bound-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('read 只取尾部窗口即可返回最近 N 条（大文件不全量入内存）', async () => {
    const archive = new GroupTranscriptArchive({ dir });
    const text = 'x'.repeat(300);
    for (let index = 0; index < 300; index += 1) {
      await archive.append(
        entry({ messageId: `m${index}`, text, timestamp: index }),
      );
    }
    const recent = await archive.read('cid-1', { limit: 5 });
    expect(recent.map((item) => item.messageId)).toEqual([
      'm295',
      'm296',
      'm297',
      'm298',
      'm299',
    ]);
  });

  it('文件超过字节上限后旋转，只保留最近条目且仍可读取最新发言', async () => {
    const archive = new GroupTranscriptArchive({
      dir,
      maxFileBytes: 64 * 1024,
      maxRetainedEntries: 2,
    });
    const text = 'y'.repeat(9000);
    for (let index = 0; index < 10; index += 1) {
      expect(
        await archive.append(
          entry({ messageId: `m${index}`, text, timestamp: index }),
        ),
      ).toBe(true);
    }
    const raw = await readFile(archive.filePathFor('cid-1'), 'utf8');
    const lineCount = raw.trim().split('\n').length;
    expect(lineCount).toBeLessThan(10);
    expect(lineCount).toBeGreaterThanOrEqual(2);

    const recent = await archive.read('cid-1', { limit: 2 });
    expect(recent.map((item) => item.messageId)).toEqual(['m8', 'm9']);

    const groups = await archive.listGroups();
    expect(groups[0]?.entryCount).toBe(lineCount);
    expect(groups[0]?.lastTimestamp).toBe(9);

    // 旋转后最近 messageId 仍去重
    expect(await archive.append(entry({ messageId: 'm9', text }))).toBe(false);
  });

  it('listGroups 流式统计的条数与逐行解析一致', async () => {
    const archive = new GroupTranscriptArchive({ dir });
    for (let index = 0; index < 120; index += 1) {
      await archive.append(
        entry({ messageId: `m${index}`, timestamp: index }),
      );
    }
    const raw = await readFile(archive.filePathFor('cid-1'), 'utf8');
    const lineCount = raw.trim().split('\n').length;
    const groups = await archive.listGroups();
    expect(groups[0]?.entryCount).toBe(lineCount);
    expect(groups[0]?.lastTimestamp).toBe(119);
  });
});

describe('GroupTranscriptBuffer onAppend 钩子', () => {
  it('只在新发言入池时触发，重投不触发', () => {
    const appended: TranscriptEntry[] = [];
    const buffer = new GroupTranscriptBuffer({
      defaultWindowSize: 3,
      onAppend: (item) => appended.push(item),
    });
    buffer.append(entry());
    buffer.append(entry());
    buffer.append(entry({ messageId: 'msg-2' }));
    expect(appended.map((item) => item.messageId)).toEqual(['msg-1', 'msg-2']);
  });
});