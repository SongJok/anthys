import crypto from 'node:crypto';
import type {
  RunWatchdogPolicy,
  WatchdogCode,
  WatchdogDecision,
  WatchdogOutcome,
  WatchdogStepObservation,
} from '../types/watchdog.js';

export const DEFAULT_WATCHDOG_POLICY: RunWatchdogPolicy = {
  enabled: true,
  noProgressSteps: 3,
  maxInjections: 2,
  warnRatio: 0.8,
  hardRatio: 0.95,
  toolErrorSteps: 3,
};

const CODE_LABELS: Record<WatchdogCode, string> = {
  budget: 'Token 预算接近上限',
  'wall-time': '执行时间接近上限',
  'no-progress': '连续多步没有获得新信息',
  repeat: '连续重复相同的工具调用',
  'tool-errors': '连续多次工具调用失败',
};

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function envNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || !value.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampRatio(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0.1, value));
}

export function createWatchdogPolicy(
  env: NodeJS.ProcessEnv = process.env,
): RunWatchdogPolicy {
  const warnRatio = clampRatio(
    envNumber(env.WATCHDOG_WARN_RATIO, DEFAULT_WATCHDOG_POLICY.warnRatio),
    DEFAULT_WATCHDOG_POLICY.warnRatio,
  );
  const hardRatio = clampRatio(
    envNumber(env.WATCHDOG_HARD_RATIO, DEFAULT_WATCHDOG_POLICY.hardRatio),
    DEFAULT_WATCHDOG_POLICY.hardRatio,
  );
  return {
    enabled: envFlag(env.WATCHDOG_ENABLED, DEFAULT_WATCHDOG_POLICY.enabled),
    noProgressSteps: Math.max(
      1,
      Math.floor(
        envNumber(
          env.WATCHDOG_NO_PROGRESS_STEPS,
          DEFAULT_WATCHDOG_POLICY.noProgressSteps,
        ),
      ),
    ),
    maxInjections: Math.max(
      0,
      Math.floor(
        envNumber(
          env.WATCHDOG_MAX_INJECTIONS,
          DEFAULT_WATCHDOG_POLICY.maxInjections,
        ),
      ),
    ),
    warnRatio: Math.min(warnRatio, hardRatio),
    hardRatio: Math.max(warnRatio, hardRatio),
    toolErrorSteps: Math.max(
      1,
      Math.floor(
        envNumber(
          env.WATCHDOG_TOOL_ERROR_STEPS,
          DEFAULT_WATCHDOG_POLICY.toolErrorSteps,
        ),
      ),
    ),
  };
}

export function toolSignature(name: string, argsJson: string): string {
  return `${name}:${crypto
    .createHash('md5')
    .update(argsJson || '{}')
    .digest('hex')}`;
}

export function contentHash(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

export function toWatchdogOutcome(decision: WatchdogDecision): WatchdogOutcome {
  return {
    action: decision.action,
    code: decision.code,
    reason: decision.reason,
    notice: decision.notice,
    escalate: decision.escalate,
  };
}

export interface RunWatchdogOptions {
  /** 后台任务命中硬预算时暂停，交互运行直接取消 */
  mode: 'interactive' | 'job';
  budget: {
    maxWallTimeMs: number;
    maxTotalTokens: number;
  };
  policy?: Partial<RunWatchdogPolicy>;
}

/**
 * 运行看门狗：只观察 ReAct 循环，不直接执行工具。
 * 分级干预顺序为 注入约束 → 停用工具（降级）→ 暂停/取消（升级）。
 */
export class RunWatchdog {
  private readonly mode: RunWatchdogOptions['mode'];
  private readonly budget: RunWatchdogOptions['budget'];
  private readonly policy: RunWatchdogPolicy;

  private readonly seenOutputs = new Set<string>();
  private readonly seenCitations = new Set<string>();
  private noProgressStreak = 0;
  private errorStreak = 0;
  private repeatStreak = 0;
  private lastSignatureKey: string | null = null;
  private injections = 0;
  private budgetWarned = false;
  private degraded = false;
  private terminal: WatchdogDecision | null = null;
  private lastDecision: WatchdogDecision | null = null;

  constructor(options: RunWatchdogOptions) {
    this.mode = options.mode;
    this.budget = options.budget;
    this.policy = { ...DEFAULT_WATCHDOG_POLICY, ...options.policy };
  }

  /** 每轮模型调用结束后检查预算比例 */
  public observeBudget(
    elapsedMs: number,
    tokens: number,
  ): WatchdogDecision | null {
    if (!this.policy.enabled || this.terminal) return null;
    const wallRatio =
      this.budget.maxWallTimeMs > 0
        ? elapsedMs / this.budget.maxWallTimeMs
        : 0;
    const tokenRatio =
      this.budget.maxTotalTokens > 0 ? tokens / this.budget.maxTotalTokens : 0;
    const ratio = Math.max(wallRatio, tokenRatio);
    if (ratio >= this.policy.hardRatio) {
      const code: WatchdogCode = wallRatio >= tokenRatio ? 'wall-time' : 'budget';
      return this.terminalDecision(code, ratio);
    }
    if (ratio >= this.policy.warnRatio && !this.budgetWarned) {
      this.budgetWarned = true;
      const code: WatchdogCode = wallRatio >= tokenRatio ? 'wall-time' : 'budget';
      return this.injectDecision(
        code,
        `预算使用率 ${Math.round(ratio * 100)}%，触发收敛提醒`,
        `已使用约 ${Math.round(ratio * 100)}% 的任务预算（${CODE_LABELS[code]}）。请立即收敛：停止非必要探索，优先给出最重要的结论；若信息不足，明确说明还缺什么。`,
        `执行保护：${CODE_LABELS[code]}，已注入收敛约束。`,
      );
    }
    return null;
  }

  /** 每轮工具执行结束后检查空转、重复与连续失败 */
  public observeToolStep(
    step: WatchdogStepObservation,
  ): WatchdogDecision | null {
    if (!this.policy.enabled || this.terminal) return null;
    const budgetDecision = this.observeBudget(step.elapsedMs, step.tokens);
    if (budgetDecision) return budgetDecision;
    if (this.degraded || step.tools.length === 0) return null;

    let novel = false;
    for (const tool of step.tools) {
      if (!tool.isError && !this.seenOutputs.has(tool.contentHash)) {
        this.seenOutputs.add(tool.contentHash);
        novel = true;
      }
      for (const key of tool.citationKeys) {
        if (this.seenCitations.has(key)) continue;
        this.seenCitations.add(key);
        novel = true;
      }
    }

    const allFailed = step.tools.every((tool) => tool.isError);
    this.errorStreak = allFailed ? this.errorStreak + 1 : 0;
    this.noProgressStreak = novel ? 0 : this.noProgressStreak + 1;
    const signatureKey = step.tools
      .map((tool) => tool.signature)
      .sort()
      .join('|');
    this.repeatStreak =
      signatureKey === this.lastSignatureKey ? this.repeatStreak + 1 : 0;
    this.lastSignatureKey = signatureKey;

    if (this.errorStreak >= this.policy.toolErrorSteps) {
      return this.escalate(
        'tool-errors',
        `连续 ${this.errorStreak} 步工具调用全部失败`,
        `已连续 ${this.errorStreak} 次工具调用失败。请先检查参数、权限或目标是否存在，不要原样重试；可改用其他工具，或直接说明无法完成的部分与下一步建议。`,
        `执行保护：${CODE_LABELS['tool-errors']}。`,
      );
    }
    if (this.repeatStreak >= 2 && !novel) {
      return this.escalate(
        'repeat',
        `连续 ${this.repeatStreak + 1} 步使用相同工具与参数`,
        `检测到连续 ${this.repeatStreak + 1} 步使用完全相同的工具和参数。继续重复不会产生新信息，请立刻更换查询条件，或直接基于现有观察作答。`,
        `执行保护：${CODE_LABELS.repeat}。`,
      );
    }
    if (this.noProgressStreak >= this.policy.noProgressSteps) {
      return this.escalate(
        'no-progress',
        `连续 ${this.noProgressStreak} 步工具调用没有带来新信息`,
        `已连续 ${this.noProgressStreak} 步没有从工具中获得新信息。请停止重复探索：基于已知信息直接给出结论；若确实信息不足，明确列出缺少什么以及建议用户补充什么。`,
        `执行保护：${CODE_LABELS['no-progress']}。`,
      );
    }
    return null;
  }

  public getOutcome(): WatchdogOutcome | null {
    return this.lastDecision ? toWatchdogOutcome(this.lastDecision) : null;
  }

  public isTerminal(): boolean {
    return this.terminal !== null;
  }

  public isDegraded(): boolean {
    return this.degraded;
  }

  private escalate(
    code: WatchdogCode,
    reason: string,
    guidance: string,
    notice: string,
  ): WatchdogDecision {
    if (this.injections >= this.policy.maxInjections) {
      this.degraded = true;
      const decision: WatchdogDecision = {
        action: 'degrade',
        code,
        reason: `${reason}，已注入 ${this.injections} 次约束仍无改善，停用工具`,
        guidance:
          '工具已停用。请立即基于已获得的观察和上下文给出最终结论，不要再请求调用任何工具；若信息不足，明确说明缺什么，并给出用户可以执行的下一步。',
        notice: '执行保护：多次提醒后仍无有效进展，已停用工具并要求基于现有信息作答。',
        escalate: false,
      };
      this.lastDecision = decision;
      return decision;
    }
    return this.injectDecision(code, reason, guidance, notice);
  }

  private injectDecision(
    code: WatchdogCode,
    reason: string,
    guidance: string,
    notice: string,
  ): WatchdogDecision {
    this.injections += 1;
    const decision: WatchdogDecision = {
      action: 'inject',
      code,
      reason,
      guidance,
      notice,
      escalate: false,
    };
    this.lastDecision = decision;
    return decision;
  }

  private terminalDecision(
    code: WatchdogCode,
    ratio: number,
  ): WatchdogDecision {
    const percent = Math.round(ratio * 100);
    const action = this.mode === 'job' ? 'pause' : 'cancel';
    const decision: WatchdogDecision = {
      action,
      code,
      reason: `${CODE_LABELS[code]}（已使用 ${percent}%），主动${action === 'pause' ? '暂停' : '停止'}执行`,
      guidance: '',
      notice:
        action === 'pause'
          ? `已使用约 ${percent}% 的任务预算，任务已暂停等待人工确认。`
          : `本次执行已使用约 ${percent}% 的预算，已主动停止以避免继续消耗。请缩小问题范围后重试。`,
      escalate: true,
    };
    this.terminal = decision;
    this.lastDecision = decision;
    return decision;
  }
}
