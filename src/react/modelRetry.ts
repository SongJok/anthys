export interface ModelRetryPolicy {
  /** 总尝试次数（含首次）；1 表示不重试 */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_MODEL_RETRY_POLICY: ModelRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 600,
  maxDelayMs: 5_000,
};

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const TRANSIENT_MESSAGE =
  /fetch failed|socket hang up|other side closed|terminated|connection error|network|overloaded|rate limit|too many requests|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|timed ?out/iu;

/**
 * 只判定模型传输层瞬态故障。鉴权/参数类错误（401/403/400/422）重试无意义，
 * 主动取消也不重试。工具执行不走这里，写操作永不自动重试。
 */
export function isTransientModelError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as {
    name?: unknown;
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (candidate.name === 'AbortError') return false;

  const status =
    typeof candidate.status === 'number'
      ? candidate.status
      : typeof candidate.statusCode === 'number'
        ? candidate.statusCode
        : undefined;
  if (status !== undefined) return TRANSIENT_STATUS.has(status);

  const message =
    typeof candidate.message === 'string' ? candidate.message : '';
  // Anthropic 适配器抛纯 Error，状态码只出现在消息前缀里
  const anthropic = /^Anthropic API (\d{3})/u.exec(message);
  if (anthropic) return TRANSIENT_STATUS.has(Number(anthropic[1]));

  if (typeof candidate.code === 'string' && TRANSIENT_CODES.has(candidate.code)) {
    return true;
  }
  return TRANSIENT_MESSAGE.test(message);
}

/** 指数退避 + 抖动，避免多个会话同时重试打爆同一供应商端点 */
export function modelRetryDelayMs(
  attempt: number,
  policy: ModelRetryPolicy,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

/** 可被取消打断的退避等待；取消时正常 resolve，由调用方检查 signal */
export async function sleepWithSignal(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0 || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal?.addEventListener('abort', finish, { once: true });
  });
}

function envNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !raw.trim()) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function createModelRetryPolicy(
  env: NodeJS.ProcessEnv = process.env,
): ModelRetryPolicy {
  const baseDelayMs = Math.max(
    0,
    Math.floor(
      envNumber(env.LLM_RETRY_BASE_DELAY_MS, DEFAULT_MODEL_RETRY_POLICY.baseDelayMs),
    ),
  );
  return {
    maxAttempts: Math.max(
      1,
      Math.floor(
        envNumber(
          env.LLM_RETRY_MAX_ATTEMPTS,
          DEFAULT_MODEL_RETRY_POLICY.maxAttempts,
        ),
      ),
    ),
    baseDelayMs,
    maxDelayMs: Math.max(
      baseDelayMs,
      Math.floor(
        envNumber(
          env.LLM_RETRY_MAX_DELAY_MS,
          DEFAULT_MODEL_RETRY_POLICY.maxDelayMs,
        ),
      ),
    ),
  };
}