import {z} from 'zod';
import {evaluateGroupContract, GROUP_CONTRACT_DEFAULTS, type GroupContract, type GroupContractContext} from './contract-model.js';

const uuid = z.uuid().transform(s => s.toLowerCase());
const utc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
  .refine(s => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === (s.includes('.') ? s : s.replace('Z', '.000Z')))
  .transform(s => new Date(s).toISOString());
const offsetTime = z.iso.datetime({offset: true}).refine(s => {
  const date = s.slice(0, 10);
  const civil = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(Date.parse(s)) && Number.isFinite(civil) && new Date(civil).toISOString().slice(0, 10) === date;
}).transform(s => new Date(s).toISOString());
const caseSchema = z.strictObject({
  id: uuid, version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  resourceRef: z.string().min(1).max(512).refine(s => s.trim() === s), ownerId: uuid.nullable(),
  state: z.enum(['PROPOSED', 'OPEN', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'WAITING_CONFIRMATION', 'RESOLVED', 'CLOSED', 'CANCELLED']),
  dueAt: offsetTime.nullable(),
});
const notificationSchema = z.strictObject({
  notificationId: uuid, at: utc, caseIds: z.array(uuid).min(1).max(10000)
    .transform(ids => [...new Set(ids)].sort()),
  state: z.enum(['PENDING', 'APPLIED_UNVERIFIED', 'UNKNOWN', 'FAILED', 'SUPPRESSED']),
});
const inputSchema = z.strictObject({
  contract: z.unknown(), context: z.unknown(), cases: z.array(caseSchema).max(10000),
  usage: z.strictObject({tenantId: z.string().min(1), groupId: z.string().min(1),
    from: utc, until: utc, complete: z.literal(true), includesAllUnresolved: z.literal(true),
    notifications: z.array(notificationSchema).max(10000)}),
  maxItems: z.number().int().min(1).max(20).default(20),
});
export type ReminderCase = z.infer<typeof caseSchema>;
export type ReminderSkipReason = 'STATE_NOT_REMINDABLE' | 'NO_OWNER' | 'NO_DUE_DATE' | 'NOT_DUE'
  | 'UNRESOLVED_NOTIFICATION' | 'CASE_DAILY_QUOTA' | 'GROUP_HOURLY_QUOTA' | 'DIGEST_ITEM_LIMIT';
export interface GroupReminderPlan {
  status: 'CANDIDATE' | 'NO_CANDIDATE' | 'BLOCKED';
  reason: string | null;
  digest: null | {groupId: string; contractId: string; contractVersion: number; items: ReminderCase[];
    groups: {ownerId: string; state: ReminderCase['state']; caseIds: string[]}[];
    mentions: string[]; mentionAll: false};
  skipped: {id: string; reason: ReminderSkipReason}[];
  truncated: boolean;
  duplicates: {cases: number; notifications: number};
  notice: string;
}
const NOTICE = '仅为催办候选规划，不证明授权、完整账本、当前群成员或已发送，也不预留额度。contract/context 与 usage.complete/includesAllUnresolved 仅是调用方断言；服务端必须从当前可信 authority 和真实持久账本重新取得并核验，原子预留额度及发送前复核。无 @全员、私信或升级权限；UNKNOWN 不重试。';
const HOUR = 3600000;
// JSON-like values only; never execute caller getters while inspecting unknown input.
function plainData(value: unknown, ancestors = new Set<object>(), depth = 0): boolean {
  if (value === null || ['string', 'boolean', 'undefined'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 20 || ancestors.has(value)) return false;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  ancestors.add(value);
  const valid = Reflect.ownKeys(value).every(key => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return 'value' in descriptor && plainData(descriptor.value, ancestors, depth + 1);
  });
  ancestors.delete(value);
  return valid;
}
function local(ms: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms);
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === name)!.value;
  const date = `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
  return {date, minute: Number(part('hour')) * 60 + Number(part('minute')),
    weekday: new Date(`${date}T00:00:00Z`).getUTCDay() || 7};
}
function working(now: ReturnType<typeof local>, contract: GroupContract) {
  const minute = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  return contract.workHours.windows.some(w => {
    const start = minute(w.start), end = minute(w.end);
    return start < end ? w.daysOfWeek.includes(now.weekday) && now.minute >= start && now.minute < end
      : (now.minute >= start && w.daysOfWeek.includes(now.weekday))
        || (now.minute < end && w.daysOfWeek.includes((now.weekday + 5) % 7 + 1));
  });
}
/** Shared work-window predicate only; never an authority or notification plan. */
export function groupContractWorkingAt(contract:GroupContract,now:number){return Number.isFinite(now)&&working(local(now,contract.workHours.timezone),contract);}

/** Pure, bounded planning only. No authorization, reservation, dispatch, retry or clock IO. */
export function planGroupReminder(raw: unknown): GroupReminderPlan {
  const result: GroupReminderPlan = {status: 'BLOCKED', reason: null, digest: null,
    skipped: [], truncated: false, duplicates: {cases: 0, notifications: 0}, notice: NOTICE};
  const block = (reason: string) => {result.reason = reason; return result;};
  if (!plainData(raw)) return block('INVALID_INPUT');
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return block('INVALID_INPUT');
  const input = parsed.data;
  if (evaluateGroupContract(input.contract, input.context).status !== 'ELIGIBLE') return block('CONTRACT_DENIED');
  const contract = input.contract as GroupContract, context = input.context as GroupContractContext;
  if ((contract.sources.mode ?? GROUP_CONTRACT_DEFAULTS.sourceMode) !== 'MENTION_ONLY') return block('SOURCE_MODE_UNSUPPORTED');
  if (!contract.actions.allowed.includes('case.remind') || contract.actions.prohibited.includes('case.remind')) return block('ACTION_DENIED');
  const usage = input.usage, now = context.now;
  if (now < Date.parse('0001-01-01T00:00:00Z')) return block('CLOCK_RANGE_UNSUPPORTED');
  if (usage.tenantId !== context.tenantId || usage.groupId !== context.groupId
    || Date.parse(usage.until) !== now || Date.parse(usage.from) > now - 48 * HOUR) return block('USAGE_COVERAGE_INVALID');
  const cases = new Map<string, ReminderCase>();
  for (const item of input.cases) {
    const old = cases.get(item.id);
    if (old && JSON.stringify(old) !== JSON.stringify(item)) return block('CONFLICTING_CASE');
    if (old) result.duplicates.cases++; else cases.set(item.id, item);
  }
  const notifications = new Map<string, z.infer<typeof notificationSchema>>();
  for (const item of usage.notifications) {
    const unresolved = item.state === 'PENDING' || item.state === 'UNKNOWN';
    if (Date.parse(item.at) > now || (!unresolved && Date.parse(item.at) < Date.parse(usage.from))) return block('USAGE_COVERAGE_INVALID');
    const old = notifications.get(item.notificationId);
    if (old && JSON.stringify(old) !== JSON.stringify(item)) return block('CONFLICTING_NOTIFICATION');
    if (old) result.duplicates.notifications++; else notifications.set(item.notificationId, item);
  }
  const here = local(now, contract.workHours.timezone);
  if (!working(here, contract)) return block('OUTSIDE_WORK_HOURS');
  let groupUsed = 0;
  const daily = new Map<string, number>(), unresolvedCases = new Set<string>();
  for (const item of notifications.values()) {
    const unresolved = item.state === 'PENDING' || item.state === 'UNKNOWN';
    if (unresolved || Date.parse(item.at) > now - HOUR) groupUsed++;
    if (unresolved || local(Date.parse(item.at), contract.workHours.timezone).date === here.date) {
      for (const id of item.caseIds) daily.set(id, (daily.get(id) ?? 0) + 1);
    }
    if (unresolved) for (const id of item.caseIds) unresolvedCases.add(id);
  }
  const perCase = contract.limits?.remindersPerCasePerDay ?? GROUP_CONTRACT_DEFAULTS.remindersPerCasePerDay;
  const perGroup = contract.limits?.summariesPerGroupPerHour ?? GROUP_CONTRACT_DEFAULTS.summariesPerGroupPerHour;
  const items: ReminderCase[] = [];
  const ordered = [...cases.values()].sort((a, b) => (a.dueAt === null ? Infinity : Date.parse(a.dueAt))
    - (b.dueAt === null ? Infinity : Date.parse(b.dueAt)) || a.id.localeCompare(b.id, 'en'));
  for (const item of ordered) {
    let reason: ReminderSkipReason | undefined;
    if (!['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED'].includes(item.state)) reason = 'STATE_NOT_REMINDABLE';
    else if (!item.ownerId) reason = 'NO_OWNER';
    else if (!item.dueAt) reason = 'NO_DUE_DATE';
    else if (Date.parse(item.dueAt) > now) reason = 'NOT_DUE';
    else if (unresolvedCases.has(item.id)) reason = 'UNRESOLVED_NOTIFICATION';
    else if ((daily.get(item.id) ?? 0) >= perCase) reason = 'CASE_DAILY_QUOTA';
    else if (groupUsed >= perGroup) reason = 'GROUP_HOURLY_QUOTA';
    else if (items.length >= input.maxItems) {reason = 'DIGEST_ITEM_LIMIT'; result.truncated = true;}
    if (reason) result.skipped.push({id: item.id, reason}); else items.push(item);
  }
  result.status = items.length ? 'CANDIDATE' : 'NO_CANDIDATE';
  if (!items.length) return result;
  const groups = new Map<string, {ownerId: string; state: ReminderCase['state']; caseIds: string[]}>();
  for (const item of items) {
    const key = `${item.ownerId}:${item.state}`;
    const group = groups.get(key) ?? {ownerId: item.ownerId!, state: item.state, caseIds: []};
    group.caseIds.push(item.id); groups.set(key, group);
  }
  result.digest = {groupId: context.groupId, contractId: contract.id, contractVersion: contract.version,
    items, groups: [...groups.values()], mentions: [...new Set(items.map(i => i.ownerId!)
      .filter(id => contract.mentionUserIds.includes(id)))].sort(), mentionAll: false};
  return result;
}
