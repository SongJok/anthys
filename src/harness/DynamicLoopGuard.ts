import crypto from 'node:crypto';
import type { DynamicLoopPolicy } from '../types/core.js';

export interface DynamicLoopGuardDeps {
  now?: () => number;
}

export interface LoopStepResult {
  allowContinue: boolean;
  injectWarning?: string;
  haltReason?: string;
  /** 预算耗尽的具体原因，调用方据此给出拒接说明 */
  haltCode?: 'wall-time' | 'tokens';
}

export class DynamicLoopGuard {
  private readonly startTime: number;
  private readonly now: () => number;
  private consumedTokens = 0;
  private callSignatures: string[] = [];

  constructor(
    private readonly policy: DynamicLoopPolicy,
    deps: DynamicLoopGuardDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.startTime = this.now();
  }

  public recordStep(
    tokensUsed: number,
    toolName?: string,
    args?: unknown,
  ): LoopStepResult {
    this.consumedTokens += tokensUsed;
    const elapsed = this.now() - this.startTime;

    if (elapsed >= this.policy.maxWallTimeMs) {
      return {
        allowContinue: false,
        haltCode: 'wall-time',
        haltReason: '已达到单次任务最大思考时间预算，本次不再继续执行。',
      };
    }
    if (this.consumedTokens >= this.policy.maxTotalTokens) {
      return {
        allowContinue: false,
        haltCode: 'tokens',
        haltReason: '已达到单次任务 Token 预算上限，本次不再继续执行。',
      };
    }

    if (toolName) {
      const sig = `${toolName}:${crypto
        .createHash('md5')
        .update(JSON.stringify(args ?? {}))
        .digest('hex')}`;
      this.callSignatures.push(sig);
      const threshold = Math.max(1, this.policy.maxConsecutiveSameTool);
      const recentRepeats = this.callSignatures.slice(-threshold);
      if (
        recentRepeats.length === threshold &&
        recentRepeats.every((s) => s === sig)
      ) {
        return {
          allowContinue: true,
          injectWarning: `[Harness System Warning]: 检测到你已连续 ${threshold} 次以相同参数调用工具 "${toolName}"。请勿重复调用，尝试更换查询条件或直接基于现有观察给出回答。`,
        };
      }
    }

    return { allowContinue: true };
  }

  public getElapsedMs(): number {
    return this.now() - this.startTime;
  }

  public getConsumedTokens(): number {
    return this.consumedTokens;
  }

  public getPolicy(): DynamicLoopPolicy {
    return this.policy;
  }
}
