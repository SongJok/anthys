import {groupMentionRosterRequestSchema} from './group-mention-roster-protocol.js';
import {nativeCaseRosterRequestSchema} from './native-case-roster-protocol.js';
import {z} from 'zod';
import {readRequestSchema as priorReadRequestSchema} from './case-roster-protocol.js';
import {scheduledGroupRequestSchema} from './scheduled-group-protocol.js';
// The old native and H5 wire leaves remain strict and unchanged.
export const readRequestSchema=z.union([priorReadRequestSchema,scheduledGroupRequestSchema,nativeCaseRosterRequestSchema,groupMentionRosterRequestSchema]);
