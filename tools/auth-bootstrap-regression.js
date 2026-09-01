'use strict';
const fs = require('fs');
const db = fs.readFileSync('database/db.js','utf8');
const main = fs.readFileSync('main.js','utf8');
const preload = fs.readFileSync('preload.js','utf8');
const loginHtml = fs.readFileSync('renderer/login.html','utf8');
const loginJs = fs.readFileSync('renderer/login.js','utf8');
const checks = [
  ['no hard-coded default admin password', !/admin123/.test(db) && /legacy_admin_passwords_reviewed/.test(db)],
  ['bootstrap password is random', /crypto\.randomBytes\(18\)\.toString\('base64url'\)/.test(db)],
  ['bootstrap password is stored as pending setup secret', /bootstrap_admin_temp_password/.test(db) && /bootstrap_admin_pending/.test(db)],
  ['successful login clears bootstrap secret', /clearBootstrapAdminInfo\(\)/.test(main)],
  ['password login has rate limiting', /passwordAttempts/.test(main) && /notePasswordFailure/.test(main) && /isPasswordRateLimited/.test(main)],
  ['bootstrap IPC is exposed through preload', /auth:bootstrapInfo/.test(main) && /bootstrapInfo: \(\) => ipcRenderer.invoke\('auth:bootstrapInfo'\)/.test(preload)],
  ['first-run login explains temporary credential', /bootstrapInfo/.test(loginHtml) && /temporaryPassword/.test(loginJs)],
  ['first-run hint no longer reveals default password', !/admin123/.test(loginHtml)],
];
let failed = 0;
for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`); if (!ok) failed++; }
if (failed) process.exit(1);
console.log(`AUTH BOOTSTRAP REGRESSION: PASS (${checks.length} checks)`);
