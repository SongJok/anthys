/**
 * LLM 请求并发闸门：同一供应商端点下所有模型实例（主循环、管理员、子代理、
 * 后台任务）共享一个在途请求上限。流式请求会长时间占用连接，只靠 SDK 的
 * 429 重试无法阻止突发流量把配额与连接数打满，因此在发起前排队。
 *
 * 槽位按 FIFO 直接转交给下一个等待者，等待期间可被 AbortSignal 取消。
 */

export interface LlmRequestGateOptions {
  /** 同时在途的请求上限；<= 0 表示不限流 */
  limit: number;
}

export interface LlmRequestGateStats {
  limit: number;
  active: number;
  waiting: number;
  acquiredTotal: number;
  queuedTotal: number;
}

function abortReason(signal?: AbortSignal): unknown {
  return (
    signal?.reason ?? new Error('LLM request aborted while waiting for a slot')
  );
}

const noopRelease = (): void => {};

export class LlmRequestGate {
  private readonly limit: number;
  private readonly waiters: Array<() => void> = [];
  private active = 0;
  private acquiredTotal = 0;
  private queuedTotal = 0;

  constructor(options: LlmRequestGateOptions) {
    this.limit = options.limit;
  }

  public stats(): LlmRequestGateStats {
    return {
      limit: this.limit,
      active: this.active,
      waiting: this.waiters.length,
      acquiredTotal: this.acquiredTotal,
      queuedTotal: this.queuedTotal,
    };
  }

  /** 取得一个在途槽位；返回的释放函数幂等，必须在流结束后调用 */
  public acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.limit <= 0) return Promise.resolve(noopRelease);
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.active < this.limit && this.waiters.length === 0) {
      this.active += 1;
      this.acquiredTotal += 1;
      return Promise.resolve(this.makeRelease());
    }

    this.queuedTotal += 1;
    return new Promise<() => void>((resolve, reject) => {
      let settled = false;
      const remove = (): void => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        remove();
        reject(abortReason(signal));
      };
      const grant = (): void => {
        if (settled) return;
        settled = true;
        remove();
        this.acquiredTotal += 1;
        resolve(this.makeRelease());
      };
      this.waiters.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      // 直接把槽位交给下一个等待者，active 保持不变，避免超发
      if (next) next();
      else this.active -= 1;
    };
  }
}

const sharedGates = new Map<string, LlmRequestGate>();

/** 按供应商端点共享闸门；limit 取首次创建时的配置 */
export function sharedLlmRequestGate(
  baseUrl: string,
  limit: number,
): LlmRequestGate {
  const key = baseUrl.trim().toLowerCase();
  const existing = sharedGates.get(key);
  if (existing) return existing;
  const gate = new LlmRequestGate({ limit });
  sharedGates.set(key, gate);
  return gate;
}

export function sharedLlmGateStats(): LlmRequestGateStats[] {
  return [...sharedGates.values()].map((gate) => gate.stats());
}

export function resetSharedLlmRequestGates(): void {
  sharedGates.clear();
}