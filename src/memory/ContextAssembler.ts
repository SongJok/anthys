import type { ChatMessage, StoredMessage } from '../types/core.js';
import type { AssembledMemoryContext } from '../types/bystander-and-memory.js';

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
  memoryContext?: AssembledMemoryContext;
  /** 群聊历史需要保留发言人，避免多个成员的话被当成同一个人 */
  groupChat?: boolean;
  /** 当前发言人的昵称，仅群聊使用 */
  userSpeaker?: string;
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
    const basePrompt =
      input.memoryContext?.personaSystemPrompt?.trim() ||
      buildSystemPrompt(input.persona, input.now ?? this.options.now);
    const memorySections = this.renderMemorySections(input.memoryContext);
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: memorySections
          ? `${basePrompt}\n\n${memorySections}`
          : basePrompt,
      },
    ];

    const window = Math.max(1, this.options.windowMessages);
    const history = input.history.slice(-window);
    for (const item of history) {
      if (item.role === 'user') {
        const speaker =
          input.groupChat && item.senderNick ? `${item.senderNick}：` : '';
        messages.push({ role: 'user', content: `${speaker}${item.content}` });
        continue;
      }
      messages.push({
        role: 'assistant',
        content: item.content,
      });
    }

    const speaker =
      input.groupChat && input.userSpeaker ? `${input.userSpeaker}：` : '';
    messages.push({ role: 'user', content: `${speaker}${input.userText}` });
    return messages;
  }

  private renderMemorySections(
    memory: AssembledMemoryContext | undefined,
  ): string {
    if (!memory) return '';
    const sections: string[] = [];
    if (memory.userSemanticProfile.trim()) {
      sections.push(
        '【发言人与团队画像】',
        memory.userSemanticProfile.trim(),
      );
    }
    if (memory.groupRecentTranscript.trim()) {
      sections.push(
        '【群聊旁听记录（最近，含发言人/时间）】',
        memory.groupRecentTranscript.trim(),
        '回答 @ 追问时可结合以上群聊背景，无需让用户重复描述。',
      );
    }
    if (memory.episodicSummary.trim()) {
      sections.push('【历史会话摘要】', memory.episodicSummary.trim());
    }
    return sections.length > 0
      ? ['## 三层记忆上下文', ...sections].join('\n')
      : '';
  }
}
