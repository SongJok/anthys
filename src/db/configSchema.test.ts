import { describe, expect, it } from 'vitest';
import { mergeKnownGroups } from './configSchema.js';
import type { GroupBystanderPolicy } from '../types/admin-and-console.js';

function policy(
  conversationId: string,
  overrides: Partial<GroupBystanderPolicy> = {},
): GroupBystanderPolicy {
  return {
    conversationId,
    bystanderEnabled: true,
    proactiveReplyEnabled: true,
    slidingWindowSize: 20,
    cooldownSeconds: 180,
    confidenceThreshold: 0.82,
    triggerTopics: [],
    ...overrides,
  };
}

describe('mergeKnownGroups', () => {
  it('用群策略补全列表里的开关状态', () => {
    const groups = mergeKnownGroups(
      [{ conversationId: 'cid-1', title: '研发大群', lastActiveAt: 1000 }],
      [policy('cid-1', { bystanderEnabled: false })],
    );
    expect(groups).toEqual([
      {
        conversationId: 'cid-1',
        title: '研发大群',
        conversationType: '2',
        bystanderEnabled: false,
        proactiveReplyEnabled: true,
        lastActiveAt: 1000,
      },
    ]);
  });

  it('没收到过消息但配过策略的群也要出现，便于再编辑或关闭', () => {
    const groups = mergeKnownGroups([], [policy('cid-2')]);
    expect(groups).toEqual([
      {
        conversationId: 'cid-2',
        title: null,
        conversationType: '2',
        bystanderEnabled: true,
        proactiveReplyEnabled: true,
        lastActiveAt: null,
      },
    ]);
  });

  it('没见过也没配过策略的群不重复出现', () => {
    const groups = mergeKnownGroups(
      [
        { conversationId: 'cid-1', title: '研发大群', lastActiveAt: 1000 },
        { conversationId: 'cid-1', title: '研发大群', lastActiveAt: 2000 },
      ],
      [policy('cid-1')],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.lastActiveAt).toBe(1000);
  });

  it('已知群没有策略时开关状态为 null，由控制台回退默认值', () => {
    const [group] = mergeKnownGroups(
      [{ conversationId: 'cid-1', title: '研发大群', lastActiveAt: 5 }],
      [],
    );
    expect(group?.bystanderEnabled).toBeNull();
    expect(group?.proactiveReplyEnabled).toBeNull();
  });
});
