import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../..',import.meta.url));
export default defineConfig({testDir:'.',testMatch:['company-agent.spec.ts'],forbidOnly:true,workers:1,fullyParallel:false,retries:0,timeout:45000,
 reporter:[['list'],['json',{outputFile:resolve(root,'reports/company-agent-browser-20261019/playwright-results.json')}]],outputDir:resolve(root,'.data/company-agent-browser-results'),
 use:{baseURL:'http://localhost:52339',channel:process.env['CI']?'chromium':'chrome',headless:true,serviceWorkers:'block',trace:'retain-on-failure'},
 webServer:{command:'node --import tsx tests/browser/company-agent-server.ts',cwd:root,url:'http://localhost:52339/api/v1/health/ready',reuseExistingServer:false,timeout:60000,gracefulShutdown:{signal:'SIGTERM',timeout:15000}},
 projects:[{name:'desktop',use:{viewport:{width:1280,height:800}}},{name:'mobile',use:{viewport:{width:390,height:844},isMobile:true,hasTouch:true}}]
});
