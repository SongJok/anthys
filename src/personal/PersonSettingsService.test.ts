import { describe, expect, it } from 'vitest';
import type { InboundMessage } from '../types/core.js';
import type {
  PersonMemoryConsent,
  PersonMemoryConsentStore,
  PersonPreferences,
  PersonPreferencesStore,
} from '../types/personal-settings.js';
import { PersonSettingsService } from './PersonSettingsService.js';

const NOW = 1_764_500_000_000;

class MemoryPreferenceStore implements PersonPreferencesStore {
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
    this.rows.set(preferences.personKey, preferences);
    return preferences;
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
    this.rows.set(consent.personKey, consent);
    return consent;
  }
}

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'msg-1',
    conversationId: 'cid-dm',
    conversationType: '1',
    senderStaffId: 'staff-1',
    senderNick: '张三',
    isAtBot: true,
    text: '',
    rawPayload: {},
    timestamp: NOW,
    ...overrides,
  };
}

function makeService() {
  const preferences = new MemoryPreferenceStore();
  const consents = new MemoryConsentStore();
  const service = new PersonSettingsService({
    preferences,
    consents,
    now: () => NOW,
  });
  return { service, preferences, consents };
}

describe('PersonSettingsService', () => {
  it('未配置时返回默认偏好与默认授权', async () => {
    const { service } = makeService();
    const preferences = await service.getPreferences('staff:1');
    expect(preferences.replyLength).toBe('balanced');
    expect(preferences.language).toBe('auto');
    expect(preferences.enabled).toBe(true);

    const consent = await service.getConsent('staff:1');
    expect(consent.groupSharing).toBe('shareable');
    expect(consent.allowedConversationIds).toEqual([]);
  });

  it('个人偏好只在单聊注入，群聊不注入', async () => {
    const { service } = makeService();
    expect(await service.buildPrompt('staff:1', '1')).toBeUndefined();
    expect(await service.buildPrompt('staff:1', '2')).toBeUndefined();

    await service.updatePreferences(
      'staff:1',
      {
        replyLength: 'concise',
        language: 'en',
        addressAs: '小明',
        extraInstructions: '先给结论',
      },
      'staff:1',
    );
    const prompt = await service.buildPrompt('staff:1', '1');
    expect(prompt).toContain('【员工个人偏好】');
    expect(prompt).toContain('回答尽量简短');
    expect(prompt).toContain('Answer in English.');
    expect(prompt).toContain('称呼这位员工为「小明」');
    expect(prompt).toContain('额外要求：先给结论');
    expect(await service.buildPrompt('staff:1', '2')).toBeUndefined();
  });

  it('停用偏好后不再注入提示，更新时保留未提交字段', async () => {
    const { service } = makeService();
    await service.updatePreferences(
      'staff:1',
      { replyLength: 'detailed', addressAs: '小明' },
      'staff:1',
    );
    const disabled = await service.updatePreferences(
      'staff:1',
      { enabled: false },
      'staff:2',
    );
    expect(disabled.replyLength).toBe('detailed');
    expect(disabled.addressAs).toBe('小明');
    expect(disabled.updatedBy).toBe('staff:2');
    expect(await service.buildPrompt('staff:1', '1')).toBeUndefined();
  });

  it('按跨群授权档位与白名单解析群聊记忆模式', async () => {
    const { service } = makeService();
    expect(await service.resolveGroupMode('staff:1', 'cid-group-1')).toBe(
      'shareable',
    );
    expect(await service.resolveGroupMode('', 'cid-group-1')).toBe('off');
    expect(await service.resolveGroupMode('staff:1', '')).toBe('off');

    await service.updateConsent('staff:1', { groupSharing: 'all' }, 'staff:1');
    expect(await service.resolveGroupMode('staff:1', 'cid-group-1')).toBe('all');

    await service.updateConsent(
      'staff:1',
      { allowedConversationIds: ['cid-group-1', ' cid-group-1 ', ''] },
      'staff:1',
    );
    const consent = await service.getConsent('staff:1');
    expect(consent.allowedConversationIds).toEqual(['cid-group-1']);
    expect(await service.resolveGroupMode('staff:1', 'cid-group-1')).toBe('all');
    expect(await service.resolveGroupMode('staff:1', 'cid-group-2')).toBe('off');

    await service.updateConsent('staff:1', { groupSharing: 'off' }, 'staff:1');
    expect(await service.resolveGroupMode('staff:1', 'cid-group-1')).toBe('off');
  });

  it('/pref 只在单聊可用，并能设置长度、语言、称呼与重置', async () => {
    const { service } = makeService();
    expect(
      await service.handlePreferenceCommand(
        message({ conversationType: '2' }),
        ['length', 'concise'],
        'staff:1',
      ),
    ).toContain('只能在单聊中设置');

    expect(
      await service.handlePreferenceCommand(message(), ['length', 'huge'], 'staff:1'),
    ).toContain('个人偏好用法');

    expect(
      await service.handlePreferenceCommand(message(), ['length', 'concise'], 'staff:1'),
    ).toContain('已设为「concise」');
    expect(
      await service.handlePreferenceCommand(message(), ['lang', 'en'], 'staff:1'),
    ).toContain('已设为「en」');
    expect(
      await service.handlePreferenceCommand(message(), ['address', '小明'], 'staff:1'),
    ).toContain('已设置称呼');

    const shown = await service.handlePreferenceCommand(message(), [], 'staff:1');
    expect(shown).toContain('concise');
    expect(shown).toContain('en');
    expect(shown).toContain('小明');

    expect(
      await service.handlePreferenceCommand(message(), ['off'], 'staff:1'),
    ).toContain('已停用');
    expect(
      await service.handlePreferenceCommand(message(), ['on'], 'staff:1'),
    ).toContain('已启用');
    expect(
      await service.handlePreferenceCommand(message(), ['reset'], 'staff:1'),
    ).toContain('已恢复默认');
    const reset = await service.getPreferences('staff:1');
    expect(reset.replyLength).toBe('balanced');
    expect(reset.addressAs).toBe('');
    expect(reset.enabled).toBe(true);
  });

  it('/privacy 只在单聊可用，并能维护档位与白名单', async () => {
    const { service } = makeService();
    expect(
      await service.handleConsentCommand(
        message({ conversationType: '2' }),
        ['groups', 'off'],
        'staff:1',
      ),
    ).toContain('只能在单聊中设置');

    expect(
      await service.handleConsentCommand(message(), ['groups', 'wide'], 'staff:1'),
    ).toContain('跨群记忆授权用法');

    expect(
      await service.handleConsentCommand(message(), ['groups', 'all'], 'staff:1'),
    ).toContain('已设为「all」');
    expect(
      await service.handleConsentCommand(message(), ['allow', 'cid-group-1'], 'staff:1'),
    ).toContain('已加入白名单');
    expect(
      await service.handleConsentCommand(message(), ['allow', 'cid-group-1'], 'staff:1'),
    ).toContain('已在白名单中');

    const shown = await service.handleConsentCommand(message(), [], 'staff:1');
    expect(shown).toContain('all');
    expect(shown).toContain('cid-group-1');

    expect(
      await service.handleConsentCommand(message(), ['deny', 'cid-group-1'], 'staff:1'),
    ).toContain('已移出白名单');
    expect(
      await service.handleConsentCommand(message(), ['clear'], 'staff:1'),
    ).toContain('已清除群白名单');
    const consent = await service.getConsent('staff:1');
    expect(consent.allowedConversationIds).toEqual([]);
    expect(consent.groupSharing).toBe('all');
  });
});
