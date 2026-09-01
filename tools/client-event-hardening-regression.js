const fs = require('fs');
const assert = require('assert');
const main = fs.readFileSync('main.js','utf8');
function ok(x,m){assert(x,m)}
ok(main.includes('CLIENT_EVENT_MAX_PER_MINUTE = 20'), 'client event per-minute cap exists');
ok(main.includes('bucket.count > CLIENT_EVENT_MAX_PER_MINUTE'), 'client event rate limit enforced');
ok(main.includes('Object.entries(rawDetails).slice(0, 20)'), 'client event detail key count bounded');
ok(main.includes("typeof v === 'string' ? v.slice(0, 500)"), 'client event string values bounded');
ok(main.includes('clientEventLastLoggedAt.clear()'), 'client event dedupe state cleared on logout');
console.log('Client event hardening regression: PASS');
