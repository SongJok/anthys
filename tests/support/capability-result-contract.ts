import type {CapabilityReview} from '../../packages/contracts/src/capability.js';
import {z} from 'zod';
import {toolResultSchema} from '../../packages/contracts/src/index.js';
// Existing synthetic authorization/runtime fixtures intentionally exercise
// arbitrary test payloads. This is their declared transport-level contract,
// not a business adapter schema or enterprise integration certification.
const syntheticReview:CapabilityReview={authModes:['CORE'],requiredPermissions:[],supportsIdempotency:false,supportsDryRun:false,bindingRef:'synthetic:fixture-only'};
export const syntheticResultContract={...syntheticReview,resultSchema:toolResultSchema,outputSchema:z.toJSONSchema(toolResultSchema)};
