import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../..',import.meta.url));
export default defineConfig({testDir:'.',testMatch:['group-escalations-ui.spec.ts'],forbidOnly:true,workers:1,fullyParallel:false,retries:0,
 reporter:[['list'],['json',{outputFile:resolve(root,'reports/group-case-escalation-ui-20261020/delivery-compat/browser-results.json')}]],outputDir:resolve(root,'reports/group-case-escalation-ui-20261020/delivery-compat/browser-artifacts'),
 use:{baseURL:'http://localhost:52339',channel:process.env['CI']?'chromium':'chrome',headless:true,serviceWorkers:'block',trace:'retain-on-failure'},
 projects:[{name:'desktop',use:{viewport:{width:1280,height:800}}},{name:'mobile',use:{viewport:{width:390,height:844},isMobile:true,hasTouch:true}}]
});
