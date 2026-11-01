/** 运行看门狗：检测空转、重复、连续失败与预算风险，并分级干预 */
export type WatchdogAction = 'inject' | 'degrade' | 'pause' | 'cancel';

export type WatchdogCode =
  | 'budget'
  | 'wall-time'
  | 'no-progress'
  | 'repeat'
  | 'tool-errors';

export interface WatchdogDecision {
  action: WatchdogAction;
  code: WatchdogCode;
  /** 内部与审计原因 */
  reason: string;
  /** 注入给模型的约束文本 */
  guidance: string;
  /** 展示给用户的说明 */
  notice: string;
  /** true 表示已升级到暂停/取消，需要人工介入 */
  escalate: boolean;
}

export interface WatchdogOutcome {
  action: WatchdogAction;
  code: WatchdogCode;
  reason: string;
  notice: string;
  escalate: boolean;
}

export interface RunWatchdogPolicy {
  enabled: boolean;
  /** 连续多少步没有新信息后开始干预 */
  noProgressSteps: number;
  /** 降级前最多注入几轮约束 */
  maxInjections: number;
  /** 预算使用比例达到该值时注入收敛约束 */
  warnRatio: number;
  /** 预算使用比例达到该值时暂停/取消 */
  hardRatio: number;
  /** 连续多少步工具全部失败后干预 */
  toolErrorSteps: number;
}

export interface WatchdogToolObservation {
  name: string;
  /** 工具名 + 参数的稳定签名，用于识别重复调用 */
  signature: string;
  /** 工具输出的稳定哈希，用于识别“没有新信息” */
  contentHash: string;
  isError: boolean;
  citationKeys: string[];
}

export interface WatchdogStepObservation {
  elapsedMs: number;
  tokens: number;
  tools: WatchdogToolObservation[];
}
