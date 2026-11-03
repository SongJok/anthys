import { describe, expect, it } from 'vitest';
import type { ExecutionContext, ToolDefinition } from '../../types/core.js';
import type {
  PersonMemoryConsent,
  PersonMemoryConsentStore,
  PersonPreferences,
  PersonPreferencesStore,
} from '../../types/personal-settings.js';
import { PersonSettingsService } from '../../personal/PersonSettingsService.js';
import { PersonSettingsToolProvider } from './PersonSettingsToolProvider.js';

const NOW = 1_764_500_000_000;

class MemoryPreferencesStore implements PersonPreferencesStore {
  public readonly rows = new Map<string, PersonPreferences>();

  public async get(personKey: string): Promise<PersonPreferences | null> {
    return this.rows.get(personKey) ?? null;
  }

  public async list(): Promise<PersonPreferences[]> {
    return [...this.rows.values()];
  }

  public async upsert(
    preferences: PersonPreferences,
  ): Promise<PersonPreferences> {
    const saved = { ...preferences };
    this.rows.set(saved.personKey, saved);
    return saved;
  }

  public async remove(personKey: string): Promise<void> {
    this.rows.delete(personKey);
  }
}

class MemoryConsentStore implements PersonMemoryConsentStore {
  public readonly rows = new Map<string, PersonMemoryConsent>();

  public async get(personKey: string): Promise<PersonMemoryConsent | null> {
    return this.rows.get(personKey) ?? null;
  }

  public async list(): Promise<PersonMemoryConsent[]> {
    return [...this.rows.values()];
  }

  public async upsert(consent: PersonMemoryConsent): Promise<PersonMemoryConsent> {
    const saved = { ...consent };
    this.rows.set(saved.personKey, saved);
    return saved;
  }

  public async remove(personKey: string): Promise<void> {
    this.rows.delete(personKey);
  }
}

function context(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    conversationId: 'cid-single-1',
    messageId: 'msg-1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    conversationType: '1',
    personKey: 'staff:1',
    deadlineAt: NOW + 60_000,
    now: () => NOW,
    ...overrides,
  };
}

function setup() {
  const preferences = new MemoryPreferencesStore();
  const consents = new MemoryConsentStore();
  const service = new PersonSettingsService({
    preferences,
    consents,
    now: () => NOW,
  });
  const provider = new PersonSettingsToolProvider({ service });
  return { preferences, consents, service, provider };
}

async function toolsOf(
  provider: PersonSettingsToolProvider,
  ctx: ExecutionContext,
): Promise<Map<string, ToolDefinition>> {
  return new Map((await provider.getTools(ctx)).map((tool) => [tool.name, tool]));
}

describe('PersonSettingsToolProvider', () => {
  it('只在有归一身份的单聊暴露工具', async () => {
    const { provider } = setup();
    expect(await provider.getTools(context({ conversationType: '2' }))).toEqual(
      [],
    );
    expect(
      await provider.getTools(context({ personKey: undefined })),
    ).toEqual([]);
    const tools = await toolsOf(provider, context());
    expect([...tools.keys()]).toEqual([
      'personal_preference_get',
      'personal_preference_set',
      'personal_memory_consent_get',
      'personal_memory_consent_set',
    ]);
  });

  it('读取默认偏好与授权', async () => {
    const { provider } = setup();
    const tools = await toolsOf(provider, context());
    const preference = await tools
      .get('personal_preference_get')!
      .execute({}, context());
    expect(preference).toContain('已启用');
    expect(preference).toContain('回答长度：balanced');
    expect(preference).toContain('回答语言：auto');
    expect(preference).toContain('称呼：未设置');

    const consent = await tools
      .get('personal_memory_consent_get')!
      .execute({}, context());
    expect(consent).toContain('群聊使用档位：shareable');
    expect(consent).toContain('生效群白名单：全部群');
  });

  it('更新偏好后立即生效，空字符串可清除字段', async () => {
    const { preferences, provider } = setup();
    const tools = await toolsOf(provider, context());
    const set = tools.get('personal_preference_set')!;

    expect(
      await set.execute(
        {
          replyLength: 'concise',
          language: 'zh',
          addressAs: '老张',
          extraInstructions: '先给结论',
        },
        context(),
      ),
    ).toContain('已更新');
    expect(preferences.rows.get('staff:1')).toMatchObject({
      replyLength: 'concise',
      language: 'zh',
      addressAs: '老张',
      extraInstructions: '先给结论',
      updatedBy: 'staff:1',
    });

    await set.execute({ addressAs: '', extraInstructions: '' }, context());
    expect(preferences.rows.get('staff:1')).toMatchObject({
      addressAs: '',
      extraInstructions: '',
    });
  });

  it('非法枚举与空更新不改库', async () => {
    const { preferences, provider } = setup();
    const set = (await toolsOf(provider, context())).get(
      'personal_preference_set',
    )!;
    expect(
      await set.execute({ replyLength: 'verbose' }, context()),
    ).toContain('未知回答长度');
    expect(
      await set.execute({ language: 'jp' }, context()),
    ).toContain('未知回答语言');
    expect(await set.execute({}, context())).toContain('没有要更新的偏好字段');
    expect(preferences.rows.size).toBe(0);
  });

  it('更新跨群授权时去重空值，非法档位不改库', async () => {
    const { consents, provider } = setup();
    const set = (await toolsOf(provider, context())).get(
      'personal_memory_consent_set',
    )!;

    expect(
      await set.execute({ groupSharing: 'always' }, context()),
    ).toContain('未知分享档位');
    expect(consents.rows.size).toBe(0);

    expect(
      await set.execute(
        {
          groupSharing: 'off',
          allowedConversationIds: [' cid-a ', 'cid-a', '', 'cid-b'],
        },
        context(),
      ),
    ).toContain('已更新');
    expect(consents.rows.get('staff:1')).toMatchObject({
      groupSharing: 'off',
      allowedConversationIds: ['cid-a', 'cid-b'],
      updatedBy: 'staff:1',
    });

    await set.execute({ allowedConversationIds: ['cid-b'] }, context());
    expect(consents.rows.get('staff:1')).toMatchObject({
      groupSharing: 'off',
      allowedConversationIds: ['cid-b'],
    });
  });
});
