import {parseFinalPlan} from '../../packages/runtime/src/final-plan.js';
import {needsNarrativeReview,admitsNarrative,reviewDecisionSchema,type ReviewDecision} from '../../packages/runtime/src/narrative-review.js';
const decision:ReviewDecision={schemaVersion:1,verdict:'GENERAL',relevant:true,fulfillsGoal:true,requiresTools:false,isQuestion:false,actionClaim:false,futurePromise:false,enterpriseFact:false,sensitiveDisclosure:false,issues:[]};
it('arbitrary ordinary questions require a separate review rather than an expanding greeting whitelist',()=>{
 expect(needsNarrativeReview('先列出备份恢复步骤，再在隔离环境演练。','如何制定恢复演练计划？')).toBe(true);expect(needsNarrativeReview('您好！','你好')).toBe(false);expect(needsNarrativeReview('{broken','你好')).toBe(false);expect(needsNarrativeReview(JSON.stringify({schemaVersion:1,mode:'REPORT',text:'',claims:[],outcome:'COMPLETE'}),'查统计')).toBe(false);
});
it('review acceptance must match answer intent, goal relevance and all disclosure/action gates',()=>{
 const plan=parseFinalPlan('这是一般性工作建议。');expect(admitsNarrative(plan,decision)).toBe(true);
 for(const change of [{verdict:'REJECT'},{verdict:'CLARIFICATION'},{relevant:false},{fulfillsGoal:false},{requiresTools:true},{isQuestion:true},{actionClaim:true},{futurePromise:true},{enterpriseFact:true},{sensitiveDisclosure:true},{issues:['UNSUPPORTED']}])expect(admitsNarrative(plan,{...decision,...change} as ReviewDecision)).toBe(false);
});
it('material questions can pause action requests but cannot assert completion or be admitted as an answer',()=>{
 const p=parseFinalPlan(JSON.stringify({schemaVersion:1,mode:'CLARIFICATION',text:'邀请用于什么场合？',claims:[],outcome:'CLARIFICATION'})),d:ReviewDecision={...decision,verdict:'CLARIFICATION',fulfillsGoal:false,isQuestion:true,requiresTools:true};expect(admitsNarrative(p,d)).toBe(true);expect(admitsNarrative(p,decision)).toBe(false);expect(admitsNarrative(p,{...d,fulfillsGoal:true})).toBe(false);expect(admitsNarrative(p,{...d,isQuestion:false})).toBe(false);
});
it('the review protocol rejects missing flags, extra authority and fabricated certification fields',()=>{
 expect(reviewDecisionSchema.safeParse(decision).success).toBe(true);for(const x of [{...decision,grant:'admin'},{...decision,verified:true},{...decision,relevant:undefined},{...decision,issues:['APPROVED']}])expect(reviewDecisionSchema.safeParse(x).success).toBe(false);
});
