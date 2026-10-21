import {z} from 'zod';

// Version metadata only: no saved fields, ciphertext, hashes or scope identities.
export const personaContextExplanationSchema=z.discriminatedUnion('state',[
 z.object({state:z.literal('UNBOUND')}).strict(),
 z.object({state:z.literal('BUILTIN_ONLY')}).strict(),
 z.object({state:z.literal('LEGACY_NONE')}).strict(),
 z.object({state:z.literal('UNAVAILABLE')}).strict(),
 z.object({state:z.literal('BOUND'),checkedAt:z.iso.datetime(),snapshotId:z.uuid(),policyVersion:z.number().int().nonnegative(),templateVersion:z.literal(1),sources:z.tuple([
  z.object({kind:z.literal('GLOBAL'),version:z.number().int().nonnegative()}).strict(),
  z.object({kind:z.enum(['USER','GROUP']),version:z.number().int().nonnegative()}).strict()
 ])}).strict()
]);
export type PersonaContextExplanation=z.infer<typeof personaContextExplanationSchema>;
