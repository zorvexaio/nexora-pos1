'use strict';
const fs = require('fs');
const src = fs.readFileSync(require.resolve('../main.js'), 'utf8');
const required = [
  'sync:getConfig','lan:getStatus','products:variants','products:variantParents',
  'products:downloadCsvTemplate','bundles:listActive','kitchen:print','sales:get',
  'global:get','receipt:open','receipt:print'
];
let fail = 0;
for (const name of required) {
  const rx = new RegExp("ipcMain\\.handle\\('" + name.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&') + "',[\\s\\S]{0,220}?requireAccountReady\\(\\)");
  if (!rx.test(src)) { console.error('FAIL', name); fail++; }
  else console.log('PASS', name);
}
if (fail) process.exit(1);
console.log(`IPC auth regression: ${required.length - fail}/${required.length} passed`);
