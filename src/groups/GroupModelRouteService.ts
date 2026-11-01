import type {
  GroupModelRoute,
  GroupModelRouteInput,
  GroupModelRouteStore,
} from '../types/group-workspace.js';
import type { ThinkingMode } from '../types/core.js';

const PROVIDERS = ['', 'openai-compatible', 'anthropic'] as const;
const THINKING_MODES: readonly ThinkingMode[] = [
  'off',
  'auto',
  'low',
  'high',
  'max',
];
const MODEL_LIMIT = 200;
const URL_LIMIT = 500;
const ENV_NAME_LIMIT = 100;

export interface GroupModelRouteServiceOptions {
  store: GroupModelRouteStore;
  /** 路由变化后通知运行时刷新缓存 */
  onChange?: (conversationId?: string) => void;
  now?: () => number;
}

function clip(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

function normalizeProvider(value: string): GroupModelRoute['provider'] {
  if (!(PROVIDERS as readonly string[]).includes(value)) {
    throw new Error('provider 必须是 openai-compatible 或 anthropic（留空表示沿用默认）');
  }
  return value as GroupModelRoute['provider'];
}

function normalizeThinking(value: string): GroupModelRoute['thinking'] {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (!THINKING_MODES.includes(trimmed as ThinkingMode)) {
    throw new Error(`thinking 必须是 ${THINKING_MODES.join(' / ')} 之一`);
  }
  return trimmed as ThinkingMode;
}

function normalizeTemperature(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new Error('temperature 必须在 0 到 2 之间');
  }
  return value;
}

function normalizeMaxTokens(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value <= 0 || value > 200_000) {
    throw new Error('maxTokens 必须是 1 到 200000 之间的整数');
  }
  return value;
}

/** 按群模型路由的校验与读写；密钥只记录环境变量名 */
export class GroupModelRouteService {
  private readonly store: GroupModelRouteStore;
  private readonly onChange?: (conversationId?: string) => void;
  private readonly now: () => number;

  constructor(options: GroupModelRouteServiceOptions) {
    this.store = options.store;
    this.onChange = options.onChange;
    this.now = options.now ?? Date.now;
  }

  public async list(): Promise<GroupModelRoute[]> {
    return this.store.list();
  }

  public async get(conversationId: string): Promise<GroupModelRoute | null> {
    return this.store.get(conversationId.trim());
  }

  public async update(
    conversationId: string,
    input: GroupModelRouteInput,
    actor: string,
  ): Promise<GroupModelRoute> {
    const id = conversationId.trim();
    if (!id) throw new Error('conversationId 不能为空');
    const before = await this.store.get(id);
    const baseUrl =
      input.baseUrl === undefined
        ? (before?.baseUrl ?? '')
        : clip(input.baseUrl, URL_LIMIT);
    if (baseUrl && !/^https?:\/\//iu.test(baseUrl)) {
      throw new Error('baseUrl 必须是 http(s) 地址');
    }
    const apiKeyEnv =
      input.apiKeyEnv === undefined
        ? (before?.apiKeyEnv ?? '')
        : clip(input.apiKeyEnv, ENV_NAME_LIMIT);
    if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv)) {
      throw new Error('apiKeyEnv 必须是合法的环境变量名（例如 GROUP_A_MODEL_KEY）');
    }
    const model =
      input.model === undefined
        ? (before?.model ?? '')
        : clip(input.model, MODEL_LIMIT);
    if (!model) {
      throw new Error('model 不能为空；群路由必须显式指定模型');
    }
    return this.store
      .upsert({
        conversationId: id,
        enabled: input.enabled ?? before?.enabled ?? true,
        provider: normalizeProvider(
          input.provider ?? before?.provider ?? '',
        ),
        baseUrl,
        apiKeyEnv,
        model,
        temperature:
          input.temperature === undefined
            ? (before?.temperature ?? null)
            : normalizeTemperature(input.temperature),
        thinking: normalizeThinking(
          input.thinking ?? before?.thinking ?? '',
        ),
        maxTokens:
          input.maxTokens === undefined
            ? (before?.maxTokens ?? null)
            : normalizeMaxTokens(input.maxTokens),
        updatedBy: actor,
        updatedAt: this.now(),
      })
      .then((route) => {
        this.onChange?.(id);
        return route;
      });
  }

  public async remove(conversationId: string): Promise<boolean> {
    const id = conversationId.trim();
    if (!id) return false;
    const removed = await this.store.remove(id);
    if (removed) this.onChange?.(id);
    return removed;
  }
}
