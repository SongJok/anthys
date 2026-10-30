import type { CooldownLimiter } from '../bystander/CooldownLimiter.js';
import type {
  GroupTranscriptBuffer,
  GroupTranscriptSnapshot,
} from '../bystander/GroupTranscriptBuffer.js';
import type { SharedStateStore } from './SharedStateStore.js';

export interface ClusterStateSyncLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface ClusterStateSyncOptions {
  store: SharedStateStore;
  buffer: GroupTranscriptBuffer;
  cooldown: CooldownLimiter;
  logger?: ClusterStateSyncLogger;
  /** 写入节流，默认 1s */
  debounceMs?: number;
  /** 共享状态保留期，默认 7 天 */
  ttlSeconds?: number;
}

interface PersistedConversationState extends GroupTranscriptSnapshot {
  lastRepliedAt?: number;
}

const GROUPS_KEY = 'bystander:groups';
const STATE_PREFIX = 'bystander:state:';

function stateKey(conversationId: string): string {
  return `${STATE_PREFIX}${conversationId}`;
}

/**
 * O3：把群聊旁听缓冲与主动回复冷却同步到共享状态。
 * 备实例接管时先 hydrate，再连接 Stream，避免故障窗口内重复回复或丢失上下文。
 */
export class ClusterStateSync {
  private readonly debounceMs: number;
  private readonly ttlSeconds: number;
  private readonly groups = new Set<string>();
  private readonly dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private groupsDirty = false;

  constructor(private readonly options: ClusterStateSyncOptions) {
    this.debounceMs = Math.max(0, options.debounceMs ?? 1_000);
    this.ttlSeconds = Math.max(60, options.ttlSeconds ?? 7 * 24 * 60 * 60);
  }

  public async hydrate(): Promise<void> {
    let ids: string[] = [];
    try {
      const stored = await this.options.store.getJson<unknown>(GROUPS_KEY);
      if (Array.isArray(stored)) {
        ids = stored.filter((item): item is string => typeof item === 'string');
      }
    } catch (error) {
      this.warn('failed to load shared group index', error);
      return;
    }
    for (const conversationId of ids) {
      try {
        const state =
          await this.options.store.getJson<PersistedConversationState>(
            stateKey(conversationId),
          );
        if (!state || !Array.isArray(state.entries)) continue;
        this.options.buffer.restore(conversationId, {
          entries: state.entries,
          windowSize:
            typeof state.windowSize === 'number' ? state.windowSize : 20,
        });
        if (typeof state.lastRepliedAt === 'number') {
          this.options.cooldown.restore(conversationId, state.lastRepliedAt);
        }
        this.groups.add(conversationId);
      } catch (error) {
        this.warn('failed to restore shared conversation state', error, {
          conversationId,
        });
      }
    }
  }

  /** 由 buffer / cooldown 的 onChange 调用，按会话节流持久化 */
  public schedulePersist(conversationId: string): void {
    if (!conversationId) return;
    if (!this.groups.has(conversationId)) {
      this.groups.add(conversationId);
      this.groupsDirty = true;
    }
    this.dirty.add(conversationId);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch((error) =>
        this.warn('failed to persist shared conversation state', error),
      );
    }, this.debounceMs);
    this.timer.unref?.();
  }

  public async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const conversationId of ids) {
      await this.persist(conversationId);
    }
    if (this.groupsDirty) {
      this.groupsDirty = false;
      await this.options.store.setJson(
        GROUPS_KEY,
        [...this.groups],
        this.ttlSeconds,
      );
    }
  }

  private async persist(conversationId: string): Promise<void> {
    const snapshot = this.options.buffer.snapshot(conversationId);
    const lastRepliedAt = this.options.cooldown.lastReplied(conversationId);
    await this.options.store.setJson(
      stateKey(conversationId),
      {
        entries: snapshot.entries,
        windowSize: snapshot.windowSize,
        ...(lastRepliedAt !== undefined ? { lastRepliedAt } : {}),
      } satisfies PersistedConversationState,
      this.ttlSeconds,
    );
  }

  private warn(
    message: string,
    error: unknown,
    extra: Record<string, unknown> = {},
  ): void {
    this.options.logger?.warn(
      {
        ...extra,
        error: error instanceof Error ? error.message : String(error),
      },
      message,
    );
  }
}
