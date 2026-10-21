import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../..',import.meta.url));
// A separate serial HTTP fixture owns loopback:64702 after the group server
// has exited. No app server, DB, real provider or route interception is used.
export default defineConfig({testDir:'.',testMatch:['escalation-fetch-witness.spec.ts'],forbidOnly:true,workers:1,fullyParallel:false,retries:0,
 reporter:[['list'],['json',{outputFile:resolve(root,'reports/escalation-fetch-body-ci-20261021/component-browser.json')}]],outputDir:resolve(root,'.data/escalation-witness-results'),
 use:{channel:process.env['CI']?'chromium':'chrome',headless:true,serviceWorkers:'block',trace:'retain-on-failure'},
 // The contract file explicitly exercises both viewports for its normal chain;
 // transport fault cases need one Chromium run, not a duplicate layout matrix.
 projects:[{name:'chromium'}]
});
