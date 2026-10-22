import {Decimal} from 'decimal.js';
import {z} from 'zod';
export const ExactCount=Decimal.clone({precision:40,rounding:Decimal.ROUND_HALF_UP}),RateDecimal=Decimal.clone({precision:60,rounding:Decimal.ROUND_HALF_UP});
const MaxBigint='9223372036854775807';
export const exactCountSchema=z.string().regex(/^(0|[1-9]\d{0,17})$/).refine(v=>BigInt(v)<=BigInt(MaxBigint),'COUNT_OUT_OF_RANGE');
export const decimalRateSchema=z.string().regex(/^(0(\.\d{1,18})?|1(\.0{1,18})?)$/);
export type ExactCount=z.infer<typeof exactCountSchema>;
export function parseExactCount(value:unknown):string{
 if(typeof value!=='string')throw Error('EXACT_COUNT_REQUIRED');const parsed=exactCountSchema.safeParse(value);if(!parsed.success)throw Error('EXACT_COUNT_INVALID');return parsed.data;
}
export function exactCountSum(values:readonly string[]):string{return values.reduce((total,value)=>total+BigInt(parseExactCount(value)),0n).toString();}
export function exactRate(numerator:string,denominator:string):string|null{
 const n=parseExactCount(numerator),d=parseExactCount(denominator);if(BigInt(n)>BigInt(d))throw Error('NUMERATOR_EXCEEDS_DENOMINATOR');if(d==='0')return null;
 return new RateDecimal(n).div(d).toDecimalPlaces(12,Decimal.ROUND_HALF_UP).toFixed();
}
export function exactDecimalEqual(left:string,right:string):boolean{return new RateDecimal(left).eq(new RateDecimal(right));}
