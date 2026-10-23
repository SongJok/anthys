import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../..',import.meta.url));
export default defineConfig({testDir:'.',testMatch:['artifacts.spec.ts','workbench-approval.spec.ts'],forbidOnly:true,workers:1,fullyParallel:false,retries:0,
 reporter:[['list'],['json',{outputFile:resolve(root,'reports/artifacts-browser-latest.json')}]],outputDir:resolve(root,'.data/artifacts-browser-results'),
 use:{baseURL:'http://localhost:64702',channel:process.env['CI']?'chromium':'chrome',headless:true,serviceWorkers:'block',trace:'retain-on-failure'},
 webServer:{command:`${JSON.stringify(process.execPath)} --import tsx tests/browser/artifacts-server.ts`,cwd:root,url:'http://localhost:64702/api/v1/health/ready',reuseExistingServer:false,timeout:30000,gracefulShutdown:{signal:'SIGTERM',timeout:10000}},
 projects:[{name:'desktop',use:{viewport:{width:1280,height:800}}},{name:'mobile',use:{viewport:{width:390,height:844},isMobile:true,hasTouch:true}}]
});
