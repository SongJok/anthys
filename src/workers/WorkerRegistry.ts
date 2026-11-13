import type { DynamicLoopPolicy } from '../types/core.js';
import {
  WORKER_NAMES,
  isWorkerName,
  type WorkerName,
  type WorkerToolScope,
} from '../types/workers.js';

export interface WorkerProfile {
  name: WorkerName;
  title: string;
  description: string;
  scope: WorkerToolScope;
  /** 独立预算：墙钟、Token 与最大轮数均在主策略基础上按 Worker 收敛 */
  policy: DynamicLoopPolicy;
  /** 追加到任务提示词的执行约束 */
  instruction: string;
}

export interface WorkerRegistryOptions {
  basePolicy: DynamicLoopPolicy;
  env?: Record<string, string | undefined>;
}

interface WorkerDefaults {
  title: string;
  description: string;
  wallSeconds: number;
  maxTokens: number;
  maxIterations: number;
  readOnly: boolean;
  instruction: string;
}

const DEFAULTS: Record<WorkerName, WorkerDefaults> = {
  research: {
    title: '研究 Worker',
    description: '只读查证：跨工具收集事实并给出带来源的结论',
    wallSeconds: 600,
    maxTokens: 100_000,
    maxIterations: 20,
    readOnly: true,
    instruction: [
      '你是研究 Worker（research）：只做只读查证，可以多次检索，但避免重复调用同一工具。',
      '不要声称执行了任何写操作；证据不足时明确说明缺口，不要编造数据或来源。',
      '结论优先给可核实的事实与关键链接，过程细节放在 findings 中。',
    ].join('\n'),
  },
  ops: {
    title: '执行 Worker',
    description: '任务落地：调用业务工具完成操作，写操作仍需用户确认',
    wallSeconds: 900,
    maxTokens: 160_000,
    maxIterations: 30,
    readOnly: false,
    instruction: [
      '你是执行 Worker（ops）：负责把需求落地为具体操作。',
      '写工具会进入确认流程；若工具返回需要用户确认，不要谎称已执行，把 status 置为 blocked，并在 summary 中提醒用户发送 /confirm。',
      '禁止调用管理后台、权限管理与子代理委派类工具；无法执行时说明阻塞原因。',
    ].join('\n'),
  },
  report: {
    title: '报表 Worker',
    description: '报表汇总：只读数据源并生成结论清晰的结构化报告',
    wallSeconds: 900,
    maxTokens: 120_000,
    maxIterations: 25,
    readOnly: true,
    instruction: [
      '你是报表 Worker（report）：只读取数据源并生成结论清晰的报告。',
      'summary 按“结论 → 数据与证据 → 风险与建议”组织；数字必须来自工具结果，不得估算或编造。',
      '缺少数据时在 openQuestions 中列出需要补充的口径或时间范围。',
    ].join('\n'),
  },
};

function envInt(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function envBool(
  env: Record<string, string | undefined>,
  key: string,
  fallback: boolean,
): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function envList(
  env: Record<string, string | undefined>,
  key: string,
): string[] | undefined {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function buildProfile(
  name: WorkerName,
  basePolicy: DynamicLoopPolicy,
  env: Record<string, string | undefined>,
): WorkerProfile {
  const defaults = DEFAULTS[name];
  const prefix = `WORKER_${name.toUpperCase()}`;
  const readOnly =
    name === 'research'
      ? true
      : envBool(env, `${prefix}_READ_ONLY`, defaults.readOnly);
  const allow = envList(env, `${prefix}_TOOL_ALLOWLIST`);
  const deny = envList(env, `${prefix}_TOOL_DENYLIST`);
  const scope: WorkerToolScope = {
    readOnly,
    ...(allow ? { allow } : {}),
    ...(deny ? { deny } : {}),
  };
  const policy: DynamicLoopPolicy = {
    ...basePolicy,
    maxWallTimeMs:
      envInt(env, `${prefix}_MAX_WALL_SECONDS`, defaults.wallSeconds, 30, 3_600) *
      1_000,
    maxTotalTokens: envInt(
      env,
      `${prefix}_MAX_TOKENS`,
      defaults.maxTokens,
      1_000,
      1_000_000,
    ),
    maxIterations: envInt(
      env,
      `${prefix}_MAX_ITERATIONS`,
      defaults.maxIterations,
      1,
      100,
    ),
  };
  return {
    name,
    title: defaults.title,
    description: defaults.description,
    scope,
    policy,
    instruction: defaults.instruction,
  };
}

/** 内置三类 Worker 画像；预算与工具名单可由 WORKER_<NAME>_* 环境变量覆盖 */
export class WorkerRegistry {
  private readonly profiles = new Map<WorkerName, WorkerProfile>();
  private readonly env: Record<string, string | undefined>;

  constructor(options: WorkerRegistryOptions) {
    this.env = { ...(options.env ?? {}) };
    for (const name of WORKER_NAMES) {
      this.profiles.set(name, buildProfile(name, options.basePolicy, this.env));
    }
  }

  /** 基于新主循环策略重新派生全量 Worker 画像 */
  public withBasePolicy(basePolicy: DynamicLoopPolicy): WorkerRegistry {
    return new WorkerRegistry({ basePolicy, env: this.env });
  }

  /** 原地更新主循环策略并重建全量 Worker 画像 */
  public updateBasePolicy(basePolicy: DynamicLoopPolicy): void {
    for (const name of WORKER_NAMES) {
      this.profiles.set(name, buildProfile(name, basePolicy, this.env));
    }
  }

  public get(name: WorkerName): WorkerProfile {
    const profile = this.profiles.get(name);
    if (!profile) throw new Error(`未知 Worker：${name}`);
    return profile;
  }

  public resolve(value: unknown): WorkerProfile | undefined {
    return isWorkerName(value) ? this.profiles.get(value) : undefined;
  }

  public list(): WorkerProfile[] {
    return WORKER_NAMES.map((name) => this.get(name));
  }
}

export function createWorkerRegistry(
  options: WorkerRegistryOptions,
): WorkerRegistry {
  return new WorkerRegistry(options);
}
