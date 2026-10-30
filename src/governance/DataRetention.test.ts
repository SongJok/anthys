import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DataRetentionService,
  DEFAULT_RETENTION_POLICY,
  normalizeRetentionPolicy,
  resolveRetentionPolicy,
  type RetentionCutoffs,
  type RetentionKind,
  type RetentionPolicy,
  type RetentionStore,
} from './DataRetention.js';

const NOW = new Date('2026-10-30T12:00:00Z').getTime();

class FakeStore implements RetentionStore {
  public totals: Record<RetentionKind, number> = {
    messages: 10,
    summaries: 4,
    traces: 20,
    audit: 5,
    usage: 30,
    attachments: 0,
  };
  public expired: Record<RetentionKind, number> = {
    messages: 3,
    summaries: 1,
    traces: 8,
    audit: 2,
    usage: 12,
    attachments: 0,
  };
  public purgeResult: Partial<Record<RetentionKind, number>> = {};
  public purgeCalls: Array<{
    kind: Exclude<RetentionKind, 'attachments'>;
    cutoffMs: number;
    limit: number;
  }> = [];
  public policy: RetentionPolicy | null = null;
  public deletedConversations: string[] = [];
  public deletedUsers: string[] = [];
  public messageIds: string[] = ['msg-1', 'msg-2'];

  async counts(_cutoffs: RetentionCutoffs) {
    return { totals: { ...this.totals }, expired: { ...this.expired } };
  }

  async purge(
    kind: Exclude<RetentionKind, 'attachments'>,
    cutoffMs: number,
    limit: number,
  ): Promise<number> {
    this.purgeCalls.push({ kind, cutoffMs, limit });
    return this.purgeResult[kind] ?? 2;
  }

  async deleteConversation(conversationId: string) {
    this.deletedConversations.push(conversationId);
    return {
      deleted: { messages: 2, traces: 1 },
      messageIds: this.messageIds,
    };
  }

  async deleteUser(staffId: string) {
    this.deletedUsers.push(staffId);
    return { deleted: { messages: 1 }, messageIds: this.messageIds };
  }

  async loadPolicy(): Promise<Partial<RetentionPolicy> | null> {
    return this.policy;
  }

  async savePolicy(policy: RetentionPolicy): Promise<void> {
    this.policy = policy;
  }
}

function service(
  store: FakeStore,
  overrides: Partial<ConstructorParameters<typeof DataRetentionService>[0]> = {},
): DataRetentionService {
  return new DataRetentionService({
    store,
    policy: { ...DEFAULT_RETENTION_POLICY, tracesDays: 30 },
    now: () => NOW,
    ...overrides,
  });
}

const tempDirs: string[] = [];

async function tempAttachmentRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'retention-test-'));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('retention policy', () => {
  it('从环境变量读取保留期并回退默认值', () => {
    expect(resolveRetentionPolicy({})).toEqual(DEFAULT_RETENTION_POLICY);
    expect(
      resolveRetentionPolicy({
        RETENTION_MESSAGES_DAYS: '30',
        RETENTION_TRACES_DAYS: 'oops',
        RETENTION_ATTACHMENTS_HOURS: '6',
        RETENTION_AUDIT_DAYS: '730',
        RETENTION_USAGE_DAYS: '90',
      }),
    ).toEqual({
      messagesDays: 30,
      tracesDays: 90,
      attachmentsHours: 6,
      auditDays: 730,
      usageDays: 90,
    });
  });

  it('拒绝越界值', () => {
    expect(() => normalizeRetentionPolicy({ messagesDays: 0 })).toThrow();
    expect(() => normalizeRetentionPolicy({ tracesDays: 9_999 })).toThrow();
    expect(normalizeRetentionPolicy({ tracesDays: 31.9 })).toMatchObject({
      tracesDays: 31,
    });
  });
});

describe('DataRetentionService', () => {
  it('统计总行数与过期行数', async () => {
    const store = new FakeStore();
    const result = await service(store).stats();
    expect(result.totals.messages).toBe(10);
    expect(result.expired.traces).toBe(8);
    expect(result.policy.tracesDays).toBe(30);
  });

  it('dry-run 只统计不删除（含附件）', async () => {
    const root = await tempAttachmentRoot();
    const dir = join(root, 'msg-old');
    await mkdir(dir);
    await writeFile(join(dir, 'a.png'), 'x');
    await utimes(dir, new Date(NOW - 48 * 3_600_000), new Date(NOW - 48 * 3_600_000));

    const store = new FakeStore();
    const svc = service(store, { attachmentsDir: root });
    const result = await svc.cleanup({ dryRun: true });
    expect(store.purgeCalls).toEqual([]);
    expect(result.deleted).toMatchObject({
      messages: 3,
      summaries: 1,
      traces: 8,
      audit: 2,
      usage: 12,
      attachments: 1,
    });
    expect(await svc.stats()).toMatchObject({
      totals: { attachments: 1 },
      expired: { attachments: 1 },
    });
  });

  it('按保留下限清理各表并删除过期附件目录', async () => {
    const root = await tempAttachmentRoot();
    const oldDir = join(root, 'msg-old');
    const freshDir = join(root, 'msg-new');
    await mkdir(oldDir);
    await mkdir(freshDir);
    await writeFile(join(oldDir, 'a.png'), 'x');
    await utimes(oldDir, new Date(NOW - 48 * 3_600_000), new Date(NOW - 48 * 3_600_000));

    const store = new FakeStore();
    const svc = service(store, { attachmentsDir: root, batchSize: 100 });
    const result = await svc.cleanup();

    expect(store.purgeCalls.map((call) => call.kind)).toEqual([
      'messages',
      'summaries',
      'traces',
      'audit',
      'usage',
    ]);
    expect(store.purgeCalls[0]?.cutoffMs).toBe(NOW - 180 * 86_400_000);
    expect(store.purgeCalls[2]?.cutoffMs).toBe(NOW - 30 * 86_400_000);
    expect(store.purgeCalls[0]?.limit).toBe(100);
    expect(result.deleted.attachments).toBe(1);
    await expect(rm(oldDir)).rejects.toThrow();
    await expect(stat(freshDir)).resolves.toBeTruthy();
  });

  it('管理端更新保留期会持久化并校验', async () => {
    const store = new FakeStore();
    store.policy = { ...DEFAULT_RETENTION_POLICY, messagesDays: 60 };
    const svc = await service(store).init();
    expect(svc.getPolicy().messagesDays).toBe(60);

    const next = await svc.updatePolicy({ tracesDays: 45 });
    expect(next.tracesDays).toBe(45);
    expect(store.policy?.tracesDays).toBe(45);
    await expect(svc.updatePolicy({ usageDays: -1 })).rejects.toThrow();
  });

  it('按会话与用户级联删除并清理对应附件目录', async () => {
    const root = await tempAttachmentRoot();
    await mkdir(join(root, 'msg-1'));
    await mkdir(join(root, 'msg-2'));
    const store = new FakeStore();
    const svc = service(store, { attachmentsDir: root });

    const byConversation = await svc.deleteConversation('cid-1');
    expect(store.deletedConversations).toEqual(['cid-1']);
    expect(byConversation.attachmentsRemoved).toBe(2);
    await expect(rm(join(root, 'msg-1'))).rejects.toThrow();

    const byUser = await svc.deleteUser('staff-1');
    expect(store.deletedUsers).toEqual(['staff-1']);
    expect(byUser.deleted.messages).toBe(1);

    await expect(svc.deleteUser('  ')).rejects.toThrow();
  });

  it('定时清理在 standby 上跳过，leader 上执行', async () => {
    vi.useFakeTimers();
    const store = new FakeStore();
    let leader = false;
    const svc = service(store, { canRun: () => leader });
    svc.start(1_000);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.purgeCalls).toEqual([]);

    leader = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.purgeCalls.length).toBeGreaterThan(0);

    svc.stop();
    store.purgeCalls = [];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.purgeCalls).toEqual([]);
  });
});
