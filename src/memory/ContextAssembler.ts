import type { ChatMessage, StoredMessage } from '../types/core.js';

export interface PersonaInput {
  name: string;
  rolePrompt: string;
  speakingStyle: string;
}

export interface BuildContextInput {
  persona: PersonaInput;
  history: StoredMessage[];
  userText: string;
  now?: () => number;
}

const TOOL_GUIDANCE = [
  '工作方式：',
  '- 需要实时时间、精确计算或系统运行状态时，优先调用可用工具，不要凭空猜测。',
  '- 工具返回结果后直接基于结果作答；信息已足够时不要再调用工具。',
  '- 最终回答使用 Markdown，适合在钉钉卡片中阅读；不要输出与问题无关的客套话。',
].join('\n');

export function buildSystemPrompt(
  persona: PersonaInput,
  now: () => number = Date.now,
): string {
  const timestamp = new Date(now()).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
  return [
    `你是「${persona.name}」，企业内部钉钉智能助手。`,
    persona.rolePrompt,
    `说话风格：${persona.speakingStyle}`,
    '',
    TOOL_GUIDANCE,
    '',
    `当前时间：${timestamp}（Asia/Shanghai）`,
  ].join('\n');
}

export class ContextAssembler {
  constructor(
    private readonly options: {
      windowMessages: number;
      now?: () => number;
    },
  ) {}

  public build(input: BuildContextInput): ChatMessage[] {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt(input.persona, input.now ?? this.options.now),
      },
    ];

    const window = Math.max(1, this.options.windowMessages);
    const history = input.history.slice(-window);
    for (const item of history) {
      if (item.role === 'user') {
        messages.push({ role: 'user', content: item.content });
        continue;
      }
      messages.push({
        role: 'assistant',
        content: item.content,
      });
    }

    messages.push({ role: 'user', content: input.userText });
    return messages;
  }
}
