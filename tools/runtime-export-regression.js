const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dbPath = path.join(root, 'database', 'db.js');
const src = fs.readFileSync(dbPath, 'utf8');

function pass(message) { console.log(`PASS: ${message}`); }
function fail(message) { console.error(`FAIL: ${message}`); process.exit(1); }

const exportsMatch = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\};\s*$/);
if (!exportsMatch) fail('database module.exports block not found');

const exportedNames = exportsMatch[1]
  .split(',')
  .map((x) => x.trim().replace(/\s*:\s*[\s\S]*$/, '').trim())
  .filter(Boolean)
  .filter((x) => /^[A-Za-z_$][\w$]*$/.test(x));

const declared = new Set();
for (const match of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) declared.add(match[1]);
for (const match of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)\s*(?:extends\s+[^\{]+)?\{/g)) declared.add(match[1]);
for (const match of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) declared.add(match[1]);
for (const match of src.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(/g)) {
  for (const item of match[1].split(',')) {
    const local = item.trim().split(/\s+as\s+/).pop().trim();
    if (/^[A-Za-z_$][\w$]*$/.test(local)) declared.add(local);
  }
}

const missing = exportedNames.filter((name) => !declared.has(name));
if (missing.length) fail(`database exports undefined identifiers: ${missing.join(', ')}`);
if (src.includes('\n  setUserHourlyRate,\n')) fail('legacy setUserHourlyRate must not be exported');

pass(`database exports resolve to declared identifiers (${exportedNames.length} checked)`);
pass('legacy hourly-rate setter is not exported by database module');
console.log('RUNTIME EXPORT REGRESSION: PASS');
