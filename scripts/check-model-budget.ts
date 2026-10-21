import {loadEnvFile} from '../packages/config/src/index.js';
import {modelBudgetDiagnostic} from '../packages/runtime/src/budget-policy.js';
loadEnvFile();
const args=process.argv.slice(2);if(args.length&&!(args.length===2&&args[0]==='--file'&&args[1]))throw Error('USAGE: budget:check [--file <approved-json-path>]');
if(args.length)process.env['BUDGET_POLICY_FILE']=args[1];
const result=modelBudgetDiagnostic();console.log(JSON.stringify({checkedAt:new Date().toISOString(),...result},null,2));if(result.status!=='PASS')process.exitCode=1;
