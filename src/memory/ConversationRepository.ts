import { desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { conversations, messages } from '../db/schema.js';
import type {
  ConversationRecord,
  StoredMessage,
} from '../types/core.js';

export interface EnsureConversationInput {
  conversationKey: string;
  conversationType: '1' | '2';
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface AppendMessageInput {
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string | null;
  tokenCount?: number;
  metadata?: Record<string, unknown>;
}

export interface ConversationRepository {
  ensureConversation(input: EnsureConversationInput): Promise<ConversationRecord>;
  appendMessage(input: AppendMessageInput): Promise<string>;
  recentMessages(
    conversationId: string,
    limit: number,
  ): Promise<StoredMessage[]>;
  /** 清空某个会话的短期上下文，返回删除条数 */
  clearMessages(conversationId: string): Promise<number>;
}

export class DrizzleConversationRepository implements ConversationRepository {
  constructor(private readonly db: Database) {}

  public async ensureConversation(
    input: EnsureConversationInput,
  ): Promise<ConversationRecord> {
    const now = new Date();
    const rows = await this.db
      .insert(conversations)
      .values({
        conversationKey: input.conversationKey,
        conversationType: input.conversationType,
        title: input.title ?? null,
        metadata: input.metadata ?? {},
      })
      .onConflictDoUpdate({
        target: conversations.conversationKey,
        set: {
          conversationType: input.conversationType,
          // 群名会随群设置变化，有值时才覆盖，避免旁听消息（无群名）把标题清空
          ...(input.title ? { title: input.title } : {}),
          updatedAt: now,
        },
      })
      .returning();

    const row = rows[0];
    if (!row) {
      throw new Error(
        `failed to ensure conversation ${input.conversationKey}`,
      );
    }
    return {
      id: row.id,
      conversationKey: row.conversationKey,
      conversationType: row.conversationType as '1' | '2',
      createdAt: row.createdAt.getTime(),
    };
  }

  public async appendMessage(input: AppendMessageInput): Promise<string> {
    const rows = await this.db
      .insert(messages)
      .values({
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        reasoning: input.reasoning ?? null,
        tokenCount: input.tokenCount ?? 0,
        metadata: input.metadata ?? {},
      })
      .returning({ id: messages.id });

    await this.db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, input.conversationId));

    const row = rows[0];
    if (!row) {
      throw new Error('failed to append message');
    }
    return row.id;
  }

  public async recentMessages(
    conversationId: string,
    limit: number,
  ): Promise<StoredMessage[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(Math.max(1, limit));

    return rows.reverse().map((row) => {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        role: row.role as 'user' | 'assistant',
        content: row.content,
        reasoning: row.reasoning,
        createdAt: row.createdAt.getTime(),
        senderNick:
          typeof metadata.senderNick === 'string' ? metadata.senderNick : null,
        metadata,
      };
    });
  }

  public async clearMessages(conversationId: string): Promise<number> {
    const rows = await this.db
      .delete(messages)
      .where(eq(messages.conversationId, conversationId))
      .returning({ id: messages.id });
    return rows.length;
  }
}
