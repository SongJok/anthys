import { describe, expect, it } from 'vitest';
import { CooldownLimiter } from '../bystander/CooldownLimiter.js';
import { GroupTranscriptBuffer } from '../bystander/GroupTranscriptBuffer.js';
import { ClusterStateSync } from './ClusterStateSync.js';
import { MemorySharedStateStore } from './SharedStateStore.js';

function build(store: MemorySharedStateStore, wire = true) {
  let sync!: ClusterStateSync;
  const onChange = wire
    ? (conversationId: string) => sync.schedulePersist(conversationId)
    : undefined;
  const buffer = new GroupTranscriptBuffer({
    defaultWindowSize: 5,
    ...(onChange ? { onChange } : {}),
  });
  const cooldown = new CooldownLimiter({
    now: () => 10_000,
    ...(onChange ? { onChange } : {}),
  });
  sync = new ClusterStateSync({ store, buffer, cooldown, debounceMs: 0 });
  return { buffer, cooldown, sync };
}

describe('ClusterStateSync', () => {
  it('旁听缓冲与冷却可跨实例恢复', async () => {
    const store = new MemorySharedStateStore();
    const source = build(store);
    source.buffer.append({
      conversationId: 'cid-1',
      messageId: 'm1',
      senderStaffId: 's1',
      senderNick: '张三',
      text: '线上报错了',
      isAtBot: false,
      timestamp: 1_000,
    });
    source.cooldown.markReplied('cid-1', 9_000);
    await source.sync.flush();

    const target = build(store, false);
    await target.sync.hydrate();
    expect(target.buffer.recent('cid-1').map((entry) => entry.text)).toEqual([
      '线上报错了',
    ]);
    expect(target.cooldown.lastReplied('cid-1')).toBe(9_000);
    expect(target.buffer.windowSize('cid-1')).toBe(5);
  });

  it('共享状态不可用时 hydrate 不抛错', async () => {
    const store = new MemorySharedStateStore();
    store.getJson = async () => {
      throw new Error('db down');
    };
    const warned: string[] = [];
    const sync = new ClusterStateSync({
      store,
      buffer: new GroupTranscriptBuffer(),
      cooldown: new CooldownLimiter(),
      logger: {
        warn: (_obj, msg) => warned.push(msg),
      },
    });
    await expect(sync.hydrate()).resolves.toBeUndefined();
    expect(warned[0]).toContain('group index');
  });
});
