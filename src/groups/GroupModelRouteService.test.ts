import { describe, expect, it, vi } from 'vitest';
import type {
  GroupModelRoute,
  GroupModelRouteStore,
} from '../types/group-workspace.js';
import { GroupModelRouteService } from './GroupModelRouteService.js';

const NOW = 1_764_500_000_000;

class MemoryRouteStore implements GroupModelRouteStore {
  public readonly rows = new Map<string, GroupModelRoute>();

  public async get(conversationId: string): Promise<GroupModelRoute | null> {
    return this.rows.get(conversationId) ?? null;
  }

  public async list(): Promise<GroupModelRoute[]> {
    return [...this.rows.values()];
  }

  public async upsert(route: GroupModelRoute): Promise<GroupModelRoute> {
    this.rows.set(route.conversationId, route);
    return route;
  }

  public async remove(conversationId: string): Promise<boolean> {
    return this.rows.delete(conversationId);
  }
}

function makeService() {
  const store = new MemoryRouteStore();
  const onChange = vi.fn();
  const service = new GroupModelRouteService({
    store,
    onChange,
    now: () => NOW,
  });
  return { service, store, onChange };
}

describe('GroupModelRouteService', () => {
  it('创建路由时补全默认值并通知缓存失效', async () => {
    const { service, onChange } = makeService();
    const route = await service.update(
      ' cid-group-1 ',
      { model: 'qwen-max', provider: 'openai-compatible' },
      'admin',
    );
    expect(route.conversationId).toBe('cid-group-1');
    expect(route.enabled).toBe(true);
    expect(route.model).toBe('qwen-max');
    expect(route.provider).toBe('openai-compatible');
    expect(route.baseUrl).toBe('');
    expect(route.apiKeyEnv).toBe('');
    expect(route.temperature).toBeNull();
    expect(route.thinking).toBe('');
    expect(route.maxTokens).toBeNull();
    expect(route.updatedBy).toBe('admin');
    expect(route.updatedAt).toBe(NOW);
    expect(onChange).toHaveBeenCalledWith('cid-group-1');
  });

  it('部分更新沿用已有字段', async () => {
    const { service } = makeService();
    await service.update(
      'cid-group-1',
      {
        model: 'qwen-max',
        provider: 'openai-compatible',
        baseUrl: 'https://example.com/v1',
        apiKeyEnv: 'GROUP_ONE_KEY',
        temperature: 0.4,
        thinking: 'low',
        maxTokens: 4_096,
      },
      'admin',
    );
    const updated = await service.update(
      'cid-group-1',
      { temperature: 0.8, enabled: false },
      'admin-2',
    );
    expect(updated.model).toBe('qwen-max');
    expect(updated.provider).toBe('openai-compatible');
    expect(updated.baseUrl).toBe('https://example.com/v1');
    expect(updated.apiKeyEnv).toBe('GROUP_ONE_KEY');
    expect(updated.temperature).toBe(0.8);
    expect(updated.thinking).toBe('low');
    expect(updated.maxTokens).toBe(4_096);
    expect(updated.enabled).toBe(false);
    expect(updated.updatedBy).toBe('admin-2');
  });

  it('拒绝空模型与非法 provider / thinking / temperature / maxTokens', async () => {
    const { service, onChange } = makeService();
    await expect(
      service.update('cid-group-1', { model: '  ' }, 'admin'),
    ).rejects.toThrow('model 不能为空');
    await expect(
      service.update('', { model: 'm' }, 'admin'),
    ).rejects.toThrow('conversationId 不能为空');
    await expect(
      service.update('cid-group-1', { model: 'm', provider: 'openai' as never }, 'admin'),
    ).rejects.toThrow('provider 必须是');
    await expect(
      service.update('cid-group-1', { model: 'm', thinking: 'extreme' as never }, 'admin'),
    ).rejects.toThrow('thinking 必须是');
    await expect(
      service.update('cid-group-1', { model: 'm', temperature: 2.5 }, 'admin'),
    ).rejects.toThrow('temperature 必须在 0 到 2 之间');
    await expect(
      service.update('cid-group-1', { model: 'm', maxTokens: 1.5 }, 'admin'),
    ).rejects.toThrow('maxTokens 必须是');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('拒绝非法 baseUrl 与 apiKeyEnv，密钥只记录变量名', async () => {
    const { service } = makeService();
    await expect(
      service.update('cid-group-1', { model: 'm', baseUrl: 'ftp://example.com' }, 'admin'),
    ).rejects.toThrow('baseUrl 必须是 http(s) 地址');
    await expect(
      service.update('cid-group-1', { model: 'm', apiKeyEnv: '123-BAD' }, 'admin'),
    ).rejects.toThrow('apiKeyEnv 必须是合法的环境变量名');
    const route = await service.update(
      'cid-group-1',
      { model: 'm', apiKeyEnv: 'GROUP_ONE_KEY' },
      'admin',
    );
    expect(route.apiKeyEnv).toBe('GROUP_ONE_KEY');
    expect(route).not.toHaveProperty('apiKey');
  });

  it('删除路由时通知缓存失效，空 ID 直接返回 false', async () => {
    const { service, onChange } = makeService();
    await service.update('cid-group-1', { model: 'm' }, 'admin');
    expect(await service.remove('')).toBe(false);
    expect(await service.remove('cid-group-missing')).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(await service.remove('cid-group-1')).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith('cid-group-1');
    expect(await service.get('cid-group-1')).toBeNull();
    expect(await service.list()).toEqual([]);
  });
});
