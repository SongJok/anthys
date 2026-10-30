import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/** 多实例共享状态：消息去重、旁听缓冲与冷却的快照，过期自动失效 */
export const clusterSharedState = pgTable(
  'cluster_shared_state',
  {
    key: text('key').primaryKey(),
    value: jsonb('value')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('cluster_shared_state_expires_idx').on(table.expiresAt)],
);

export type ClusterSharedStateRow = typeof clusterSharedState.$inferSelect;
