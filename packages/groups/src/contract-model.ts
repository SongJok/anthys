/**
 * Pure GroupContract data rules (01 §8.1–8.4); no authority or side effects.
 * References below are unverified metadata, never proof of administrator/ACL rights.
 * The caller supplies a CURRENT server-side binding and an explicit clock each time.
 * ELIGIBLE must never be consumed as permission to execute, read, schedule or send.
 */
export const GROUP_CONTRACT_DEFAULTS = Object.freeze({
  sourceMode: 'MENTION_ONLY', remindersPerCasePerDay: 2,
  summariesPerGroupPerHour: 6, allowMentionAll: false,
} as const);

export type GroupSourceMode = 'MENTION_ONLY' | 'AUTHORIZED_HISTORY' | 'AUTHORIZED_EVENTS';
export interface GroupContract {
  schemaVersion: 1;
  id: string;
  tenantId: string;
  groupId: string;
  version: number;
  serviceIdentityId: string;
  administratorAuthorization: {actorId: string; evidenceRef: string};
  responsibilityScope: string[];
  sources: {
    mode?: GroupSourceMode;
    entries: {kind: 'MENTION' | 'CARD' | 'AUTHORIZED_IMPORT' | 'HISTORY' | 'EVENT';
      resourceRef: string; authorizationRef?: string}[];
    enhanced?: {
      authorization: {ref: string; actorId: string; tenantId: string; groupId: string;
        serviceIdentityId: string; grantedAt: string; expiresAt: string; revokedAt?: string};
      notice: {ref: string; displayedAt: string};
      window: {from: string; to: string};
      retentionDays: number;
    };
  };
  actions: {allowed: string[]; prohibited: string[]};
  workHours: {timezone: string; windows: {daysOfWeek: number[]; start: string; end: string}[]};
  limits?: {remindersPerCasePerDay?: number; summariesPerGroupPerHour?: number};
  mentionUserIds: string[];
  escalationUserIds: string[];
  allowMentionAll?: boolean;
  validFrom: string;
  expiresAt: string;
  state: 'ACTIVE' | 'PAUSED' | 'REVOKED' | 'EXPIRED';
  stateUpdatedAt: string;
  budget: {currency: string; maxAmountMinor: number};
  revocation: {method: string};
}

/** Trusted lookup metadata must be obtained independently of the proposed contract. */
export interface GroupContractContext {
  tenantId: string;
  groupId: string;
  contractId: string;
  serviceIdentityId: string;
  currentVersion: number;
  /** Epoch milliseconds; this module never calls Date.now(). */
  now: number;
}
export interface GroupContractGap {code: string; path: string}
export interface GroupContractDecision {
  status: 'ELIGIBLE' | 'DENIED';
  gaps: GroupContractGap[];
}

type Data = Record<string, unknown>;
const object = (v: unknown): v is Data => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const prototype = Object.getPrototypeOf(v);
  return (prototype === Object.prototype || prototype === null)
    && Object.values(Object.getOwnPropertyDescriptors(v)).every(d => 'value' in d);
};
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.trim() === v;
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

// Require UTC with seconds, optionally milliseconds. Reject Date.parse's rollover dates.
function instant(v: unknown): number | undefined {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v)) return;
  const n = Date.parse(v);
  if (!Number.isFinite(n)) return;
  if (new Date(n).toISOString() !== (v.includes('.') ? v : v.replace('Z', '.000Z'))) return;
  return n;
}

function timezone(v: unknown): boolean {
  if (!text(v) || !/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+)$/.test(v)) return false;
  try { new Intl.DateTimeFormat('en', {timeZone: v}); return true; } catch { return false; }
}

/**
 * Validates a snapshot, not transitions. No irreversible lifecycle rules are invented.
 * Work windows are metadata only (overnight windows allowed); no scheduler is provided.
 * Opaque action IDs require a separately reviewed capability/policy registry.
 */
export function evaluateGroupContract(input: unknown, context: unknown): GroupContractDecision {
  const gaps: GroupContractGap[] = [];
  const gap = (code: string, path: string) => { gaps.push({code, path}); };
  const record = (v: unknown, path: string, keys: string[]): Data => {
    if (!object(v)) { gap('INVALID_OBJECT', path); return {}; }
    for (const k of Object.keys(v)) if (!keys.includes(k)) gap('UNKNOWN_FIELD', `${path}.${k}`);
    return v;
  };
  const requiredText = (v: unknown, path: string) => { if (!text(v)) gap('REQUIRED_TEXT', path); };
  const time = (v: unknown, path: string) => {
    const n = instant(v); if (n === undefined) gap('INVALID_UTC_TIME', path); return n;
  };
  const strings = (v: unknown, path: string, nonempty = false): string[] => {
    if (!Array.isArray(v) || (nonempty && v.length === 0) || Array.from(v).some(x => !text(x))) {
      gap('INVALID_STRING_LIST', path); return [];
    }
    const items = v as string[];
    if (new Set(items).size !== items.length) gap('DUPLICATE_VALUE', path);
    return items;
  };
  const match = (a: unknown, b: unknown, path: string) => {
    if (text(a) && text(b) && a !== b) gap('BINDING_MISMATCH', path);
  };
  const c = record(context, 'context', ['tenantId', 'groupId', 'contractId', 'serviceIdentityId', 'currentVersion', 'now']);
  for (const k of ['tenantId', 'groupId', 'contractId', 'serviceIdentityId']) requiredText(c[k], `context.${k}`);
  if (!integer(c.currentVersion) || c.currentVersion < 1) gap('INVALID_VERSION', 'context.currentVersion');
  const now = integer(c.now) && Number.isFinite(new Date(c.now).getTime()) ? c.now : undefined;
  if (now === undefined) gap('INVALID_CLOCK', 'context.now');
  const d = record(input, 'contract', ['schemaVersion', 'id', 'tenantId', 'groupId', 'version',
    'serviceIdentityId', 'administratorAuthorization', 'responsibilityScope', 'sources', 'actions',
    'workHours', 'limits', 'mentionUserIds', 'escalationUserIds', 'allowMentionAll', 'validFrom',
    'expiresAt', 'state', 'stateUpdatedAt', 'budget', 'revocation']);
  if (d.schemaVersion !== 1) gap('UNSUPPORTED_SCHEMA_VERSION', 'contract.schemaVersion');
  for (const k of ['id', 'tenantId', 'groupId', 'serviceIdentityId']) requiredText(d[k], `contract.${k}`);
  for (const k of ['tenantId', 'groupId', 'serviceIdentityId']) match(d[k], c[k], `contract.${k}`);
  match(d.id, c.contractId, 'contract.id');
  if (!integer(d.version) || d.version < 1) gap('INVALID_VERSION', 'contract.version');
  else if (d.version !== c.currentVersion) gap('VERSION_MISMATCH', 'contract.version');
  const admin = record(d.administratorAuthorization, 'contract.administratorAuthorization', ['actorId', 'evidenceRef']);
  requiredText(admin.actorId, 'contract.administratorAuthorization.actorId');
  requiredText(admin.evidenceRef, 'contract.administratorAuthorization.evidenceRef');
  strings(d.responsibilityScope, 'contract.responsibilityScope', true);
  const actions = record(d.actions, 'contract.actions', ['allowed', 'prohibited']);
  const allowed = strings(actions.allowed, 'contract.actions.allowed');
  const prohibited = strings(actions.prohibited, 'contract.actions.prohibited');
  if (allowed.some(a => prohibited.includes(a))) gap('ACTION_CONFLICT', 'contract.actions');
  strings(d.mentionUserIds, 'contract.mentionUserIds');
  strings(d.escalationUserIds, 'contract.escalationUserIds');
  // Explicit opt-in policy is not defined by this slice; true cannot grant @all rights.
  if (d.allowMentionAll !== undefined && d.allowMentionAll !== false) gap('MENTION_ALL_UNSUPPORTED', 'contract.allowMentionAll');
  const limits = d.limits === undefined ? {} : record(d.limits, 'contract.limits', ['remindersPerCasePerDay', 'summariesPerGroupPerHour']);
  for (const [key, max] of [['remindersPerCasePerDay', 2], ['summariesPerGroupPerHour', 6]] as const) {
    const value = limits[key] ?? GROUP_CONTRACT_DEFAULTS[key];
    if (!integer(value) || value < 0 || value > max || limits[key] === null) gap('INVALID_LIMIT', `contract.limits.${key}`);
  }
  const from = time(d.validFrom, 'contract.validFrom');
  const until = time(d.expiresAt, 'contract.expiresAt');
  if (from !== undefined && until !== undefined && from >= until) gap('INVALID_VALIDITY_WINDOW', 'contract.expiresAt');
  if (now !== undefined && from !== undefined && now < from) gap('NOT_YET_VALID', 'contract.validFrom');
  if (now !== undefined && until !== undefined && now >= until) gap('EXPIRED', 'contract.expiresAt');
  if (!['ACTIVE', 'PAUSED', 'REVOKED', 'EXPIRED'].includes(d.state as string)) gap('INVALID_STATE', 'contract.state');
  else if (d.state !== 'ACTIVE') gap('INACTIVE_CONTRACT', 'contract.state');
  const updated = time(d.stateUpdatedAt, 'contract.stateUpdatedAt');
  if (updated !== undefined && now !== undefined && updated > now) gap('FUTURE_STATE_METADATA', 'contract.stateUpdatedAt');
  const budget = record(d.budget, 'contract.budget', ['currency', 'maxAmountMinor']);
  if (typeof budget.currency !== 'string' || !/^[A-Z]{3}$/.test(budget.currency)) gap('INVALID_CURRENCY', 'contract.budget.currency');
  if (!integer(budget.maxAmountMinor) || budget.maxAmountMinor < 0) gap('INVALID_BUDGET', 'contract.budget.maxAmountMinor');
  const revocation = record(d.revocation, 'contract.revocation', ['method']);
  requiredText(revocation.method, 'contract.revocation.method');
  const hours = record(d.workHours, 'contract.workHours', ['timezone', 'windows']);
  if (!timezone(hours.timezone)) gap('INVALID_TIMEZONE', 'contract.workHours.timezone');
  if (!Array.isArray(hours.windows)) gap('INVALID_WORK_WINDOWS', 'contract.workHours.windows');
  else Array.from(hours.windows).forEach((v, i) => {
    const path = `contract.workHours.windows.${i}`;
    const w = record(v, path, ['daysOfWeek', 'start', 'end']);
    if (!Array.isArray(w.daysOfWeek) || !w.daysOfWeek.length || Array.from(w.daysOfWeek).some(x => !integer(x) || x < 1 || x > 7)
      || new Set(w.daysOfWeek).size !== w.daysOfWeek.length) gap('INVALID_WEEKDAYS', `${path}.daysOfWeek`);
    const clock = (x: unknown) => typeof x === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(x);
    if (!clock(w.start) || !clock(w.end) || w.start === w.end) gap('INVALID_LOCAL_WINDOW', path);
  });
  const sources = record(d.sources, 'contract.sources', ['mode', 'entries', 'enhanced']);
  const mode = sources.mode === undefined ? GROUP_CONTRACT_DEFAULTS.sourceMode : sources.mode;
  if (!['MENTION_ONLY', 'AUTHORIZED_HISTORY', 'AUTHORIZED_EVENTS'].includes(mode as string)) gap('INVALID_SOURCE_MODE', 'contract.sources.mode');
  if (!Array.isArray(sources.entries) || sources.entries.length === 0) gap('REQUIRED_SOURCES', 'contract.sources.entries');
  else Array.from(sources.entries).forEach((v, i) => {
    const path = `contract.sources.entries.${i}`;
    const s = record(v, path, ['kind', 'resourceRef', 'authorizationRef']);
    requiredText(s.resourceRef, `${path}.resourceRef`);
    if (!['MENTION', 'CARD', 'AUTHORIZED_IMPORT', 'HISTORY', 'EVENT'].includes(s.kind as string)) gap('UNSUPPORTED_SOURCE', `${path}.kind`);
    if ((s.kind === 'HISTORY' && mode !== 'AUTHORIZED_HISTORY') || (s.kind === 'EVENT' && mode !== 'AUTHORIZED_EVENTS')) gap('SOURCE_MODE_MISMATCH', `${path}.kind`);
    if (s.kind === 'AUTHORIZED_IMPORT') requiredText(s.authorizationRef, `${path}.authorizationRef`);
    else if (s.authorizationRef !== undefined) requiredText(s.authorizationRef, `${path}.authorizationRef`);
  });
  if (mode === 'MENTION_ONLY' && sources.enhanced !== undefined) gap('UNEXPECTED_ENHANCED_METADATA', 'contract.sources.enhanced');
  if (mode === 'AUTHORIZED_HISTORY' || mode === 'AUTHORIZED_EVENTS') {
    const e = record(sources.enhanced, 'contract.sources.enhanced', ['authorization', 'notice', 'window', 'retentionDays']);
    const authPath = 'contract.sources.enhanced.authorization';
    const a = record(e.authorization, authPath, ['ref', 'actorId', 'tenantId', 'groupId', 'serviceIdentityId', 'grantedAt', 'expiresAt', 'revokedAt']);
    for (const k of ['ref', 'actorId', 'tenantId', 'groupId', 'serviceIdentityId']) requiredText(a[k], `${authPath}.${k}`);
    for (const k of ['tenantId', 'groupId', 'serviceIdentityId']) match(a[k], d[k], `${authPath}.${k}`);
    const granted = time(a.grantedAt, `${authPath}.grantedAt`);
    const expires = time(a.expiresAt, `${authPath}.expiresAt`);
    if (granted !== undefined && expires !== undefined && granted >= expires) gap('INVALID_AUTHORIZATION_WINDOW', authPath);
    if (now !== undefined && granted !== undefined && granted > now) gap('AUTHORIZATION_NOT_YET_VALID', authPath);
    if (now !== undefined && expires !== undefined && now >= expires) gap('AUTHORIZATION_EXPIRED', authPath);
    if (a.revokedAt !== undefined) { time(a.revokedAt, `${authPath}.revokedAt`); gap('AUTHORIZATION_REVOKED', authPath); }
    const notice = record(e.notice, 'contract.sources.enhanced.notice', ['ref', 'displayedAt']);
    requiredText(notice.ref, 'contract.sources.enhanced.notice.ref');
    const displayed = time(notice.displayedAt, 'contract.sources.enhanced.notice.displayedAt');
    if (now !== undefined && displayed !== undefined && displayed > now) gap('NOTICE_NOT_YET_DISPLAYED', 'contract.sources.enhanced.notice.displayedAt');
    const window = record(e.window, 'contract.sources.enhanced.window', ['from', 'to']);
    const start = time(window.from, 'contract.sources.enhanced.window.from');
    const end = time(window.to, 'contract.sources.enhanced.window.to');
    if (start !== undefined && end !== undefined && start >= end) gap('INVALID_SOURCE_WINDOW', 'contract.sources.enhanced.window');
    if (!integer(e.retentionDays) || e.retentionDays < 1) gap('INVALID_RETENTION', 'contract.sources.enhanced.retentionDays');
  }
  return {status: gaps.length ? 'DENIED' : 'ELIGIBLE', gaps};
}
