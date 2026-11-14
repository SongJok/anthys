export interface AsyncTurnHandoffOptions<TResult, TJob> {
  /** 超过该毫秒数且无写操作时自动转入后台执行；<= 0 时关闭自动切换 */
  handoffAfterMs: number;
  /** 外部请求中止信号（例如 /stop 或停机信号） */
  signal?: AbortSignal;
  /** 检查当前轮是否已触发副作用/写操作；一旦有写操作则不中止重排，避免重复副作用 */
  hasSideEffects?: () => boolean;
  /** 运行前台同步 ReAct 回合 */
  runForeground: (runSignal: AbortSignal) => Promise<TResult>;
  /** 将未完成任务安全落入持久化的 agent_jobs 队列 */
  enqueueBackground: () => Promise<TJob>;
  /** 入队后外部信号中止（如 /stop）时撤销后台任务 */
  cancelBackground?: (job: TJob) => Promise<void> | void;
  /** 转入后台时的即时卡片/文本提示回调 */
  onHandoff?: (job: TJob) => Promise<void> | void;
}

export type AsyncTurnHandoffOutcome<TResult, TJob> =
  | { mode: 'foreground'; result: TResult }
  | { mode: 'background'; job: TJob };

/**
 * 同步 -> 异步可切换 ReAct 执行器：
 * 简单快问快答走前台流式秒回；超过耗时阈值且尚未发生不可逆写操作时，
 * 安全中止前台等待并将任务切换至持久化后台队列，释放当前会话队列阻塞。
 */
export async function runTurnWithAsyncHandoff<TResult, TJob>(
  options: AsyncTurnHandoffOptions<TResult, TJob>,
): Promise<AsyncTurnHandoffOutcome<TResult, TJob>> {
  const {
    handoffAfterMs,
    signal,
    hasSideEffects,
    runForeground,
    enqueueBackground,
    cancelBackground,
    onHandoff,
  } = options;

  const runController = new AbortController();
  const forwardExternalAbort = () => {
    runController.abort(signal?.reason);
  };
  if (signal?.aborted) {
    runController.abort(signal.reason);
  } else {
    signal?.addEventListener('abort', forwardExternalAbort, { once: true });
  }

  if (!Number.isFinite(handoffAfterMs) || handoffAfterMs <= 0) {
    try {
      const result = await runForeground(runController.signal);
      return { mode: 'foreground', result };
    } finally {
      signal?.removeEventListener('abort', forwardExternalAbort);
    }
  }

  return new Promise<AsyncTurnHandoffOutcome<TResult, TJob>>(
    (resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let handedOff = false;

      const cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        signal?.removeEventListener('abort', forwardExternalAbort);
      };

      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };

      const foregroundPromise = runForeground(runController.signal);
      foregroundPromise.then(
        (result) => {
          if (handedOff) return;
          settle(() => resolve({ mode: 'foreground', result }));
        },
        (error) => {
          if (handedOff) return;
          settle(() => reject(error));
        },
      );

      timer = setTimeout(async () => {
        if (settled || signal?.aborted) return;
        if (hasSideEffects?.()) {
          // 已有写操作发生，不再中止重排，继续在前台安全收敛
          return;
        }
        handedOff = true;
        runController.abort('ASYNC_HANDOFF');
        try {
          const job = await enqueueBackground();
          // 前台中止是协作式的：等它真正收敛后再释放会话锁，避免同会话并发写历史
          await foregroundPromise.catch(() => {});
          if (signal?.aborted) {
            await cancelBackground?.(job);
            settle(() =>
              reject(signal.reason ?? new Error('Turn aborted during handoff')),
            );
            return;
          }
          await onHandoff?.(job);
          settle(() => resolve({ mode: 'background', job }));
        } catch (error) {
          settle(() => reject(error));
        }
      }, handoffAfterMs);
    },
  );
}
