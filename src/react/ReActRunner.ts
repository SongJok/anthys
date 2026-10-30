import { DynamicLoopGuard, type LoopStepResult } from '../harness/DynamicLoopGuard.js';
import type {
  AgentEngine,
  AgentStreamEvent,
  ChatMessage,
  ChatModel,
  ChatToolCall,
  DynamicLoopPolicy,
  ExecutionContext,
  IToolProvider,
  RunResult,
  ToolDefinition,
  ToolSchema,
} from '../types/core.js';

const FINAL_TURN_GRACE_MS = 30_000;
const TOOL_OUTPUT_LIMIT = 4_000;
const TOOL_SUMMARY_LIMIT = 400;

const CONVERGENCE_NUDGE =
  '[Harness 信息收敛自检] 请先判断当前已获得的信息是否足以回答用户问题：若足够，请直接给出最终答案且不要调用工具；若不足，再进行一次必要的工具调用。';

export interface ReActRunnerOptions {
  model: ChatModel;
  toolProviders: IToolProvider[];
  policy: DynamicLoopPolicy;
  temperature?: number;
  enableNativeReasoning?: boolean;
  now?: () => number;
  estimateTokens?: (input: ChatMessage[], output: string) => number;
}

interface TurnResult {
  content: string;
  reasoning: string;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  tokens: number;
  aborted: boolean;
}

interface ToolExecutionResult {
  id: string;
  name: string;
  content: string;
  isError: boolean;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('工具参数必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

export class ReActRunner implements AgentEngine {
  private readonly now: () => number;

  constructor(private readonly options: ReActRunnerOptions) {
    this.now = options.now ?? Date.now;
  }

  public async run(input: {
    messages: ChatMessage[];
    context: ExecutionContext;
    emit: (event: AgentStreamEvent) => void;
    signal?: AbortSignal;
  }): Promise<RunResult> {
    const { emit, signal } = input;
    const startedAt = this.now();
    const policy = this.options.policy;
    const deadlineAt = Number.isFinite(input.context.deadlineAt)
      ? Math.min(input.context.deadlineAt, startedAt + policy.maxWallTimeMs)
      : startedAt + policy.maxWallTimeMs;
    const guard = new DynamicLoopGuard(policy, { now: this.now });

    let answer = '';
    let reasoning = '';
    let totalTokens = 0;
    let steps = 0;
    let halted: string | undefined;
    let skipFinalTurn = false;

    try {
      const tools = await this.loadTools(input.context);
      const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
      const toolSchemas = tools.map(toToolSchema);
      const messages: ChatMessage[] = input.messages.map((message) => ({
        ...message,
      }));

      while (true) {
        if (signal?.aborted) {
          halted = '请求已取消。';
          skipFinalTurn = true;
          break;
        }
        if (this.now() >= deadlineAt) {
          halted =
            '已达到单次任务最大思考时间预算，正在基于已有信息汇总答案。';
          break;
        }

        steps += 1;
        const turn = await this.streamTurn({
          messages,
          tools: toolSchemas,
          toolChoice: 'auto',
          signal,
          deadlineAt,
          emit,
        });
        answer += turn.content;
        reasoning += turn.reasoning;
        totalTokens += turn.tokens;

        if (turn.toolCalls.length === 0) {
          break;
        }

        const executions = await this.executeTools(
          turn.toolCalls,
          toolMap,
          input.context,
          emit,
        );
        messages.push({
          role: 'assistant',
          content: turn.content,
          toolCalls: turn.toolCalls,
        });
        for (const execution of executions) {
          messages.push({
            role: 'tool',
            toolCallId: execution.id,
            toolName: execution.name,
            content: truncate(execution.content, TOOL_OUTPUT_LIMIT),
          });
        }

        const warnings: string[] = [];
        let decision: LoopStepResult = { allowContinue: true };
        turn.toolCalls.forEach((call, index) => {
          let args: unknown = {};
          try {
            args = parseArguments(call.function.arguments);
          } catch {
            args = { __invalidArguments: call.function.arguments };
          }
          const result = guard.recordStep(
            index === 0 ? turn.tokens : 0,
            call.function.name,
            args,
          );
          if (!result.allowContinue) {
            decision = result;
          }
          if (result.injectWarning) {
            warnings.push(result.injectWarning);
          }
        });

        if (!decision.allowContinue) {
          halted = decision.haltReason;
          break;
        }
        for (const warning of warnings) {
          pushSystemOnce(messages, warning);
        }
        if (policy.convergenceCheck) {
          pushSystemOnce(messages, CONVERGENCE_NUDGE);
        }
        if (turn.aborted) {
          halted =
            '已达到单次任务最大思考时间预算，正在基于已有信息汇总答案。';
          break;
        }
      }

      if (halted && !skipFinalTurn) {
        pushSystemOnce(
          messages,
          `${halted} 请立即基于已有观察和上下文给出最终回答，禁止再调用任何工具。`,
        );
        steps += 1;
        const finalTurn = await this.streamTurn({
          messages,
          tools: toolSchemas,
          toolChoice: 'none',
          signal,
          deadlineAt: this.now() + FINAL_TURN_GRACE_MS,
          emit,
        });
        answer += finalTurn.content;
        reasoning += finalTurn.reasoning;
        totalTokens += finalTurn.tokens;
      }

      if (!answer.trim()) {
        answer =
          '抱歉，本次没有生成有效回答，请稍后重试或换一种问法。';
        emit({ type: 'answer_delta', content: answer });
      }

      const usage = {
        totalTokens,
        steps,
        durationMs: this.now() - startedAt,
      };
      emit({ type: 'completed', usage });
      return { answer, reasoning, usage };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: 'error', message });
      throw error;
    }
  }

  private async loadTools(
    context: ExecutionContext,
  ): Promise<ToolDefinition[]> {
    const loaded = await Promise.all(
      this.options.toolProviders.map((provider) => provider.getTools(context)),
    );
    const tools: ToolDefinition[] = [];
    const seen = new Set<string>();
    for (const tool of loaded.flat()) {
      if (seen.has(tool.name)) {
        throw new Error(`工具名称重复: ${tool.name}`);
      }
      seen.add(tool.name);
      tools.push(tool);
    }
    return tools;
  }

  private async executeTools(
    calls: ChatToolCall[],
    toolMap: Map<string, ToolDefinition>,
    context: ExecutionContext,
    emit: (event: AgentStreamEvent) => void,
  ): Promise<ToolExecutionResult[]> {
    const prepared = calls.map((call) => {
      let args: Record<string, unknown> = {};
      let parseError: string | undefined;
      try {
        args = parseArguments(call.function.arguments);
      } catch (error) {
        parseError =
          error instanceof Error ? error.message : String(error);
      }
      return { call, args, parseError };
    });

    for (const item of prepared) {
      emit({
        type: 'tool_start',
        toolName: item.call.function.name,
        args: item.args,
      });
    }

    const results = await Promise.all(
      prepared.map(async (item): Promise<ToolExecutionResult> => {
        const { call } = item;
        if (item.parseError) {
          return {
            id: call.id,
            name: call.function.name,
            content: `Error: 工具参数解析失败：${item.parseError}`,
            isError: true,
          };
        }
        const tool = toolMap.get(call.function.name);
        if (!tool) {
          return {
            id: call.id,
            name: call.function.name,
            content: `Error: 工具 "${call.function.name}" 不存在`,
            isError: true,
          };
        }
        try {
          const output = await tool.execute(item.args, context);
          return {
            id: call.id,
            name: call.function.name,
            content: typeof output === 'string' ? output : String(output),
            isError: false,
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            id: call.id,
            name: call.function.name,
            content: `Error: ${message}`,
            isError: true,
          };
        }
      }),
    );

    for (const result of results) {
      emit({
        type: 'tool_end',
        toolName: result.name,
        summary: truncate(result.content, TOOL_SUMMARY_LIMIT),
        isError: result.isError,
      });
    }
    return results;
  }

  private async streamTurn(params: {
    messages: ChatMessage[];
    tools: ToolSchema[];
    toolChoice: 'auto' | 'none';
    signal?: AbortSignal;
    deadlineAt: number;
    emit: (event: AgentStreamEvent) => void;
  }): Promise<TurnResult> {
    const pending = new Map<
      number,
      { id?: string; name?: string; arguments: string }
    >();
    let content = '';
    let reasoning = '';
    let tokens = 0;
    let finishReason: string | null = null;
    let aborted = false;

    const iterate = this.options.model.streamChat(
      {
        messages: params.messages,
        tools: params.tools,
        toolChoice: params.toolChoice,
        temperature: this.options.temperature ?? 0.3,
        enableNativeReasoning: this.options.enableNativeReasoning ?? true,
      },
      params.signal,
    );

    for await (const chunk of iterate) {
      if (this.now() >= params.deadlineAt) {
        aborted = true;
        break;
      }
      if (chunk.reasoningDelta) {
        reasoning += chunk.reasoningDelta;
        params.emit({
          type: 'reasoning_delta',
          content: chunk.reasoningDelta,
        });
      }
      if (chunk.contentDelta) {
        content += chunk.contentDelta;
        params.emit({ type: 'answer_delta', content: chunk.contentDelta });
      }
      if (chunk.toolCallDelta) {
        const index = chunk.toolCallDelta.index ?? 0;
        const existing = pending.get(index) ?? { arguments: '' };
        if (chunk.toolCallDelta.id) existing.id = chunk.toolCallDelta.id;
        if (chunk.toolCallDelta.name) existing.name = chunk.toolCallDelta.name;
        if (chunk.toolCallDelta.argumentsDelta) {
          existing.arguments += chunk.toolCallDelta.argumentsDelta;
        }
        pending.set(index, existing);
      }
      if (chunk.finishReason) {
        finishReason = chunk.finishReason;
      }
      if (chunk.usage?.totalTokens) {
        tokens = chunk.usage.totalTokens;
      }
    }

    if (
      params.toolChoice === 'none' &&
      [...pending.values()].some((call) => call.name)
    ) {
      pending.clear();
    }

    const toolCalls: ChatToolCall[] = [...pending.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, call]) => Boolean(call.name))
      .map(([index, call]) => ({
        id: call.id ?? `call_${index}`,
        type: 'function',
        function: {
          name: call.name ?? '',
          arguments: call.arguments || '{}',
        },
      }));

    if (!tokens) {
      tokens = this.estimateTokens(params.messages, content);
    }

    return { content, reasoning, toolCalls, finishReason, tokens, aborted };
  }

  private estimateTokens(input: ChatMessage[], output: string): number {
    if (this.options.estimateTokens) {
      return this.options.estimateTokens(input, output);
    }
    const inputChars = input.reduce(
      (sum, message) =>
        sum +
        message.content.length +
        (message.toolCalls ? JSON.stringify(message.toolCalls).length : 0),
      0,
    );
    return Math.ceil((inputChars + output.length) / 2);
  }
}

function toToolSchema(tool: ToolDefinition): ToolSchema {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parametersJsonSchema,
    },
  };
}

function pushSystemOnce(messages: ChatMessage[], text: string): void {
  const last = messages[messages.length - 1];
  if (last && last.role === 'system' && last.content === text) return;
  messages.push({ role: 'system', content: text });
}
