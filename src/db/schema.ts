import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/** 会话表：一个钉钉会话（单聊或群聊）对应一行 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationKey: text('conversation_key').notNull().unique(),
    conversationType: varchar('conversation_type', { length: 1 }).notNull(),
    title: text('title'),
    summary: text('summary'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('conversations_updated_at_idx').on(table.updatedAt),
  ],
);

/** 消息表：多轮对话记忆，只落最终 user / assistant 消息 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 16 }).notNull(),
    content: text('content').notNull().default(''),
    reasoning: text('reasoning'),
    tokenCount: integer('token_count').notNull().default(0),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('messages_conversation_created_idx').on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

/** 基础配置表：人设 / 模型参数等可热更新配置 */
export const agentConfigs = pgTable('agent_configs', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type AgentConfigRow = typeof agentConfigs.$inferSelect;
