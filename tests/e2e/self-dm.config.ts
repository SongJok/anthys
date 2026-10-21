import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../..',import.meta.url));
export default defineConfig({
 testDir:'.',testMatch:'self-dm.spec.ts',fullyParallel:false,workers:1,
 reporter:[['list'],['json',{outputFile:resolve(root,'reports/self-dm-e2e-latest.json')}]],
 outputDir:resolve(root,'.data/self-dm-closure-20261018/playwright-output'),
 use:{baseURL:'http://localhost:52339',channel:process.env['CI']?'chromium':'chrome',headless:true,trace:'retain-on-failure'},
 webServer:{command:'node --import tsx tests/e2e/self-dm-server.ts',cwd:root,url:'http://localhost:52339/api/v1/health/ready',reuseExistingServer:false,timeout:30000},
 projects:[{name:'desktop',use:{viewport:{width:1280,height:800}}},{name:'mobile',use:{viewport:{width:390,height:844},isMobile:true,hasTouch:true}}]
});
