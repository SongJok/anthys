import { describe, expect, it } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import type { DynamicConfigCenter } from '../../config/DynamicConfigCenter.js';
import { recordWebAudit } from './configRoutes.js';

function centerWith(
  recordAudit: (input: unknown) => Promise<unknown>,
): DynamicConfigCenter {
  return { recordAudit } as unknown as DynamicConfigCenter;
}

describe('recordWebAudit 高危审计可靠写入', () => {
  it('非高危动作审计失败被吞掉，不阻断已生效的热更新', async () => {
    const center = centerWith(async () => {
      throw new Error('db down');
    });
    await expect(
      recordWebAudit(center, 'admin', 'UPDATE_LLM', {}, {}),
    ).resolves.toBeUndefined();
  });

  it('高危动作审计持续失败时 fail-closed 抛出 500，并重试 3 次', async () => {
    let calls = 0;
    const center = centerWith(async () => {
      calls += 1;
      throw new Error('db down');
    });
    await expect(
      recordWebAudit(center, 'admin', 'DELETE_SEMANTIC_MEMORY', {}, {}),
    ).rejects.toBeInstanceOf(HTTPException);
    expect(calls).toBe(3);
  });

  it('高危动作审计瞬时失败后重试成功', async () => {
    let calls = 0;
    const center = centerWith(async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
      return { id: 'audit-1' };
    });
    await expect(
      recordWebAudit(center, 'admin', 'PURGE_DATA', {}, {}),
    ).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it('高危动作首次审计成功只写一次', async () => {
    let calls = 0;
    const center = centerWith(async () => {
      calls += 1;
      return { id: 'audit-1' };
    });
    await recordWebAudit(center, 'admin', 'UPDATE_WHITELIST', {}, {});
    expect(calls).toBe(1);
  });

  it('显式 critical=true 覆盖默认分类，critical=false 放行高危动作', async () => {
    const failing = centerWith(async () => {
      throw new Error('db down');
    });
    await expect(
      recordWebAudit(failing, 'admin', 'UPDATE_LLM', {}, {}, { critical: true }),
    ).rejects.toBeInstanceOf(HTTPException);
    await expect(
      recordWebAudit(
        failing,
        'admin',
        'DELETE_PROJECT',
        {},
        {},
        { critical: false },
      ),
    ).resolves.toBeUndefined();
  });

  it('抛出的 HTTPException 状态码为 500 且消息含动作类型', async () => {
    const center = centerWith(async () => {
      throw new Error('db down');
    });
    try {
      await recordWebAudit(center, 'admin', 'UNINSTALL_PLUGIN', {}, {});
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPException);
      expect((error as HTTPException).status).toBe(500);
      expect((error as HTTPException).message).toContain('UNINSTALL_PLUGIN');
    }
  });
});