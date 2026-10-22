import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../..',import.meta.url));
export default defineConfig({
 testDir:'.',testMatch:'persona-explanation.spec.ts',fullyParallel:false,workers:1,
 reporter:[['list'],['json',{outputFile:resolve(root,'reports/persona-explanation-e2e-latest.json')}]],
 outputDir:resolve(root,'.data/persona-explanation-e2e/playwright-output'),
 use:{baseURL:'http://localhost:64702',channel:process.env['CI']?'chromium':'chrome',headless:true,trace:'retain-on-failure'},
 webServer:{command:`${JSON.stringify(process.execPath)} --import tsx tests/support/persona-explanation-browser.ts`,cwd:root,url:'http://localhost:64702/api/v1/health/ready',reuseExistingServer:false,timeout:30000},
 projects:[{name:'desktop',use:{viewport:{width:1280,height:800}}},{name:'mobile',use:{viewport:{width:390,height:844},isMobile:true,hasTouch:true}}]
});
