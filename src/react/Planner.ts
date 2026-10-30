import type {
  ChatMessage,
  ChatModel,
  PlanItem,
  ToolDefinition,
} from '../types/core.js';

export interface PlannerInput {
  messages: ChatMessage[];
  tools: ToolDefinition[];
}

export type Planner = (input: PlannerInput) => Promise<PlanItem[] | null>;

export interface PlannerLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface PlannerOptions {
  model: ChatModel | (() => ChatModel);
  /** 关闭时不创建 Planner */
  enabled?: boolean;
  /** 问题短于该长度时不做规划，默认 80 字符 */
  minQuestionChars?: number;
  /** 问题短但可用工具数达到该值时也规划，默认 8 */
  minTools?: number;
  /** 计划步数上限，默认 7 */
  maxSteps?: number;
  logger?: PlannerLogger;
}

const PLANNER_SYSTEM_PROMPT = [
  '你是任务规划器。请把用户的问题拆解成 3 到 7 个可执行的研究步骤，供后续代理逐步完成。',
  '只输出 JSON，不要输出解释、Markdown 代码块或前后缀。格式：',
  '{"steps":["步骤一","步骤二","步骤三"]}',
  '每个步骤应当是一个可以直接通过工具查证的动作，避免“分析问题”这类空泛表述。',
].join('\n');

const JSON_BLOCK = /\{[\s\S]*\}/u;

function lastUserContent(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return '';
}

export function parsePlanSteps(raw: string, maxSteps = 7): string[] {
  if (!raw.trim()) return [];
  const match = raw.match(JSON_BLOCK);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  const steps =
    parsed && typeof parsed === 'object' && Array.isArray(
      (parsed as { steps?: unknown }).steps,
    )
      ? (parsed as { steps: unknown[] }).steps
      : Array.isArray(parsed)
        ? parsed
        : [];
  return steps
    .map((step) => (typeof step === 'string' ? step.trim() : ''))
    .filter((step) => step.length > 0)
    .slice(0, Math.max(1, maxSteps));
}

/** 读取规划模型的一次完整输出（规划只需少量 token，不需要流式推给卡片） */
async function collectCompletion(
  model: ChatModel,
  messages: ChatMessage[],
): Promise<string> {
  let text = '';
  for await (const chunk of model.streamChat({
    messages,
    tools: [],
    temperature: 0,
    toolChoice: 'none',
    enableNativeReasoning: false,
  })) {
    if (chunk.contentDelta) text += chunk.contentDelta;
  }
  return text;
}

/**
 * A5 规划器：对复杂问题先产出 3-7 步计划，由 ReActRunner 发出 plan 事件并注入执行提示。
 * 默认关闭；开启后仅在问题较长或工具面较大时触发，避免简单问题多付一次模型成本。
 */
export function createPlanner(options: PlannerOptions): Planner | undefined {
  if (!options.enabled) return undefined;
  const maxSteps = Math.max(3, options.maxSteps ?? 7);
  const minQuestionChars = Math.max(0, options.minQuestionChars ?? 80);
  const minTools = Math.max(1, options.minTools ?? 8);
  const resolveModel = (): ChatModel =>
    typeof options.model === 'function' ? options.model() : options.model;

  return async (input) => {
    const question = lastUserContent(input.messages);
    if (question.length < minQuestionChars && input.tools.length < minTools) {
      return null;
    }
    try {
      const raw = await collectCompletion(resolveModel(), [
        { role: 'system', content: PLANNER_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            `可用工具：${input.tools.map((tool) => tool.name).join(', ') || '无'}`,
            `用户问题：${question}`,
          ].join('\n'),
        },
      ]);
      const steps = parsePlanSteps(raw, maxSteps);
      if (steps.length < 2) return null;
      return steps.map((text, index): PlanItem => ({
        id: `step_${index + 1}`,
        text,
        status: 'pending',
      }));
    } catch (error) {
      options.logger?.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'planner failed, continuing without plan',
      );
      return null;
    }
  };
}

/** 按执行轮次推进计划状态：已完成的标 done，下一步标 running */
export function advancePlan(items: PlanItem[], completed: number): PlanItem[] {
  return items.map((item, index) => {
    if (index < completed) return { ...item, status: 'done' };
    if (index === completed) return { ...item, status: 'running' };
    return item.status === 'failed' ? item : { ...item, status: 'pending' };
  });
}

/** 收尾时把未完成步骤统一标记为 done，避免卡片一直显示进行中 */
export function finalizePlan(items: PlanItem[]): PlanItem[] {
  return items.map((item) => ({ ...item, status: 'done' }));
}

export function renderPlanPrompt(items: PlanItem[]): string {
  return [
    '[执行计划] 请按以下步骤查证，必要时可以调整顺序：',
    ...items.map((item, index) => `${index + 1}. ${item.text}`),
    '完成每一步后继续下一步，信息足够时直接给出最终答案。',
  ].join('\n');
}
