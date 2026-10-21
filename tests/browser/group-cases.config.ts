import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../..',import.meta.url));
export default defineConfig({testDir:'.',testMatch:['group-cases.spec.ts','group-cases-window.spec.ts','group-escalations-real-api.spec.ts','group-contract-restore-real-api.spec.ts'],forbidOnly:true,workers:1,fullyParallel:false,retries:0,
 reporter:[['list'],['json',{outputFile:resolve(root,'reports/group-cases-browser-latest.json')}]],outputDir:resolve(root,'.data/group-cases-browser-results'),
 use:{baseURL:'http://localhost:52339',channel:process.env['CI']?'chromium':'chrome',headless:true,serviceWorkers:'block',trace:'retain-on-failure'},
 webServer:{command:'node --import tsx tests/browser/group-cases-server.ts',cwd:root,url:'http://localhost:52339/api/v1/health/ready',reuseExistingServer:false,timeout:30000},
 projects:[{name:'desktop',use:{viewport:{width:1280,height:800}}},{name:'mobile',use:{viewport:{width:390,height:844},isMobile:true,hasTouch:true}}]
});
