import {z} from 'zod';
import {DwsError, stateSchema, subjectPart} from './contracts.js';
import {groupConversationId, groupInfoPayloadProfile} from './group-contract.js';
import {requestSchema, groupTargetSchema, rpcHash, validateSignedGroupObservation} from './signed-protocol.js';

export const CASE_ROSTER_NOTICE = 'H5_SESSION 群名单观察仅为数据绑定；不证明数据库会话、合同授权、当前内部成员或事项读取/变更权限。安装策略必须由服务端可信配置提供；外层须前后复核真实会话、合同与授权，并将远端名单和有效目录取交集。PRIVATE_USER 仅绑定观察凭据所有者，不授予 H5 私有数据访问权。';
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const instant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const capability = z.literal('dws.group.case-roster.v1');
const purpose = z.literal('H5_SESSION');
// A new action must be explicitly listed in a freshly reviewed installation.
// Existing three-action policy hashes and permissions remain unchanged.
const action = z.enum(['case.read', 'case.create', 'case.update', 'case.escalate']);
const audience = z.strictObject({kind: z.literal('PRIVATE_USER'), id: z.uuid()});
const subject = z.strictObject({corpId: subjectPart, userId: subjectPart});
const principal = z.strictObject({tenantId: z.uuid(), ownerId: z.uuid(), identityId: z.uuid(),
  authEpoch: positive, authorizationVersion: positive, audience, subject});

/** Approved installation data only. A review string or caller-created object is not approval. */
export const caseRosterPolicySchema = z.strictObject({schemaVersion: z.literal(1), purpose,
  capabilityBindingId: capability, principal,
  contractId: z.uuid(), delegationId: z.uuid(),
  allowedActions: z.array(action).min(1).max(4).refine(a => new Set(a).size === a.length),
  scopeId: z.uuid(), scopeVersion: positive, conversationId: groupConversationId,
  profile: groupInfoPayloadProfile, binaryHash: digest, membersSchemaHash: digest, infoSchemaHash: digest,
  validFrom: instant, expiresAt: instant,
}).superRefine((p, c) => {
  if (p.expiresAt <= p.validFrom || p.principal.audience.id !== p.principal.ownerId)
    c.addIssue({code: 'custom', message: 'CASE_ROSTER_POLICY_INVALID'});
});
export type CaseRosterPolicy = z.infer<typeof caseRosterPolicySchema>;

/** Session/contract values are authenticated-caller assertions, not SQL proof. No native IDs. */
export const caseRosterDelegationSchema = principal.extend({purpose, capabilityBindingId: capability,
  requester: z.strictObject({actorId: z.uuid(), sessionId: z.uuid(), authEpoch: positive}),
  contract: z.strictObject({contractId: z.uuid(), version: positive, revisionHash: digest, delegationId: z.uuid()}),
  action,
}).superRefine((d, c) => {
  if (d.audience.id !== d.ownerId) c.addIssue({code: 'custom', message: 'CASE_ROSTER_OWNER_MISMATCH'});
});
export type CaseRosterDelegation = z.infer<typeof caseRosterDelegationSchema>;
export const caseRosterTargetSchema = groupTargetSchema;
export type CaseRosterTarget = z.infer<typeof caseRosterTargetSchema>;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Validates and snapshots definitions; never loads configuration or grants authority. */
export function snapshotCaseRosterPolicies(raw: unknown): readonly CaseRosterPolicy[] {
  if (raw === undefined) return Object.freeze([]);
  const result = z.array(caseRosterPolicySchema).max(32).safeParse(raw);
  if (!result.success || new Set(result.data.map(p => p.scopeId)).size !== result.data.length)
    throw new DwsError('DWS_RPC_GROUP_SCOPE_INVALID');
  return freeze(result.data);
}

/** Hash includes every fixed field; it is distinct from a native group-scope digest. */
export function caseRosterTargetForPolicy(raw: unknown): CaseRosterTarget {
  const p = caseRosterPolicySchema.parse(raw);
  return {conversationId: p.conversationId, scopeId: p.scopeId, scopeVersion: p.scopeVersion,
    scopeHash: rpcHash(p), profileHash: rpcHash(p.profile), binaryHash: p.binaryHash,
    membersSchemaHash: p.membersSchemaHash, infoSchemaHash: p.infoSchemaHash};
}

/** Only fixed-policy comparison and clock checking; the outer RPC owns signatures/short TTL. */
export function validateCaseRosterDelegation(raw: unknown, policy: unknown, options: {now: number}): CaseRosterDelegation {
  const d = caseRosterDelegationSchema.safeParse(raw), p = caseRosterPolicySchema.safeParse(policy);
  if (!d.success || !p.success) throw new DwsError('DWS_RPC_SCOPE_MISMATCH');
  if (!instant.safeParse(options.now).success || options.now < p.data.validFrom || options.now >= p.data.expiresAt)
    throw new DwsError('DWS_RPC_EXPIRED');
  const {tenantId, ownerId, identityId, authEpoch, authorizationVersion, audience, subject} = d.data;
  if (rpcHash({tenantId, ownerId, identityId, authEpoch, authorizationVersion, audience, subject}) !== rpcHash(p.data.principal))
    throw new DwsError('DWS_RPC_SCOPE_MISMATCH');
  if (d.data.contract.contractId !== p.data.contractId || d.data.contract.delegationId !== p.data.delegationId
    || !p.data.allowedActions.includes(d.data.action)) throw new DwsError('DWS_RPC_SCOPE_MISMATCH');
  return d.data;
}

// Strict result leaf; this is not the signed transport envelope. The existing RPC
// must verify its signature, requestHash, instance, request ID, deadline and state.
export const caseRosterSignedResultSchema = z.strictObject({operation: z.literal('READ_GROUP_CASE_ROSTER'),
  grantsAuthority: z.literal(false), delegationHash: digest, group: caseRosterTargetSchema,
  observation: z.unknown(),
}).superRefine((r, c) => {
  try {validateSignedGroupObservation(r.observation, r.group);} catch {
    c.addIssue({code: 'custom', message: 'CASE_ROSTER_OBSERVATION_INVALID'});
  }
});
export type CaseRosterSignedResult = z.infer<typeof caseRosterSignedResultSchema>;

/** Validates an already signature-checked result against this exact request/policy. */
export function validateCaseRosterResult(raw: unknown, options: {delegation: unknown; policy: unknown; now: number}) {
  const d = validateCaseRosterDelegation(options.delegation, options.policy, {now: options.now});
  const p = caseRosterPolicySchema.parse(options.policy), target = caseRosterTargetForPolicy(p);
  const r = caseRosterSignedResultSchema.safeParse(raw);
  if (!r.success || r.data.delegationHash !== rpcHash(d) || rpcHash(r.data.group) !== rpcHash(target))
    throw new DwsError('DWS_RPC_GROUP_RESULT_INVALID');
  return {value: validateSignedGroupObservation(r.data.observation, target, p.profile),
    grantsAuthority: false as const, notice: CASE_ROSTER_NOTICE};
}

// Separate leaf union keeps every existing native request schema/wire unchanged.
export const caseRosterRequestSchema=z.strictObject({type:z.literal('READ_REQUEST'),protocol:z.literal('OA_DWS_READ_V1'),instanceId:z.uuid(),requestId:z.uuid(),bindingHash:digest,policyHash:digest,issuedAt:instant,expiresAt:instant,
 operation:z.literal('READ_GROUP_CASE_ROSTER'),delegation:caseRosterDelegationSchema,group:caseRosterTargetSchema,state:stateSchema});
export const readRequestSchema=z.union([requestSchema,caseRosterRequestSchema]);
