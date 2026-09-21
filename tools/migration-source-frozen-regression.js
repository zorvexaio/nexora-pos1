// Published migrations are frozen. The runtime stores sha256(String(migrationFunction)) in
// schema_migrations and refuses to open a database whose migration source changed
// ("Migration vN was modified after publication; checksum mismatch").
// Any edit to the text of a migration function (even a mechanical search/replace such as
// `|| 2` -> `?? 2`) would make EVERY existing customer database fail to open after the update,
// while fresh-database tests still pass. This test pins the hash of each published migration.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'database', 'db.js'), 'utf8');
const FROZEN = {
  "2": {
    "name": "financial-minor-units-v2",
    "sha256": "1e02493bb038255549e0a3df92bcc5de21067b5d5f9257d407d884c6cb944507"
  },
  "3": {
    "name": "accounting-core-v3",
    "sha256": "a096f9c3522b0a130d95961426be76322364cb1db6193ff98264737d4d00f073"
  },
  "4": {
    "name": "permissions-matrix-v4",
    "sha256": "72fa73e0863eb942541c4aebae0210858bed54e60b8f4ac9a57c98390c05b722"
  },
  "5": {
    "name": "sync-engine-journal-v5",
    "sha256": "ddeba0038ea5870c87cd9540cdaea900b3efd916347218073fbaab7f91fb5d70"
  },
  "6": {
    "name": "backup-integrity-v6",
    "sha256": "3fa28db9668e03039c6cc80564e680716316d2dd682e039a406f61ca2ad00b16"
  },
  "7": {
    "name": "fiscalization-adapters-v7",
    "sha256": "495688fe1c31691f5aaef03d7b8071dd9f97edbcb086da8a360b9e452625e889"
  },
  "8": {
    "name": "commercial-hardening-v8",
    "sha256": "680546a232a74f44ecd5ae53c1599b0dd6729935da31681ef2639859729541c9"
  },
  "9": {
    "name": "migration-journal-integrity-v9",
    "sha256": "252b34af447319b524cf8abd63e1127132ee33e2322f3abf8b1d6d41cb8e900f"
  },
  "10": {
    "name": "payroll-lifecycle-v10",
    "sha256": "f9e1ee5fbfd3a8dc27f9459112a2f2bf6c8904ba907a5f6f443ceb97b7bb8b90"
  },
  "11": {
    "name": "inventory-transfer-workflow-v11",
    "sha256": "935f1a86f3f6bae4cb70511b4c0a4cbf48a7bd687e6d6364195f8bc403a00c6a"
  },
  "12": {
    "name": "payroll-advances-v12",
    "sha256": "69e78513a1cc56730e4670cd74bd380110cbdab624ddeba55a05e81c75533d95"
  },
  "13": {
    "name": "payroll-advance-repayments-v13",
    "sha256": "6a57d7d497e9abdb1d593e8f5ea95d40dc376f013c3876290dc09e4d8f66a0b1"
  },
  "14": {
    "name": "payroll-termination-final-settlement-v14",
    "sha256": "8c65c9f5e066fbd50a29393ad92dfcd61893d2b2945a39992e2629004e9846d0"
  },
  "15": {
    "name": "payroll-commercial-hardening-v15",
    "sha256": "043eddf7b0c66913dc7947f18690562e2d404a89bff5e363098a2b5c27027ee4"
  },
  "16": {
    "name": "shifts-minor-trigger-null-fix-v16",
    "sha256": "80dd2d0be3d06c3c4d1cd6786a2df68c91be474bd092b6d0e31567222f8c8615"
  },
  "17": {
    "name": "accounting-extensions-v17",
    "sha256": "b315e1b160abbd12ef64e2cadaff57f7819f217adc1b8929a9ff62fca4242269"
  },
  "18": {
    "name": "payroll-advance-disbursement-method-v18",
    "sha256": "78dca12b50953c5ba8dc59dec3ca9622bc7534fb6810da80aac79e5b6e0f8d8a"
  },
  "19": {
    "name": "payroll-accrual-v19",
    "sha256": "e44933731c4e447a7d69bf15c3de5c6309d49f3b38860a4f746285a2fb7e035f"
  },
  "20": {
    "name": "payroll-future-accrual-correction-v20",
    "sha256": "7c2443b8a74e57032e0518d9405d9761326534b7308b66d752ed1777331b012b"
  },
  "21": {
    "name": "accounting-balance-cache-v21",
    "sha256": "055906226545aadc7bceed17a9ddb92fd682b9ad79ca8e54bfd08d511ebcf51a"
  },
  "22": {
    "name": "payroll-advances-accounting-v22",
    "sha256": "83a1cf70f254b61c5b97a1213b59e56f71c16ad5d8a639c7e15e0bc06747888a"
  },
  "23": {
    "name": "inventory-account-correction-v23",
    "sha256": "280dd3940118a49897b40d000e9db9b5fd8b13fed54a13217cb0fb38632e57cc"
  }
};

function functionSource(text, name) {
  const m = new RegExp(`\\bfunction ${name}\\s*\\(`).exec(text);
  assert.ok(m, `migration function ${name} not found`);
  let k = text.indexOf('{', m.index + m[0].length), depth = 0, quote = null, esc = false;
  for (; k < text.length; k++) {
    const c = text[k];
    if (quote) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) quote = null;
      else if (quote === '`' && c === '$' && text[k + 1] === '{') {
        let d2 = 0; k++;
        for (;; k++) { if (text[k] === '{') d2++; else if (text[k] === '}' && --d2 === 0) break; }
      }
    } else if ('\'"`'.includes(c)) quote = c;
    else if (c === '/' && text[k + 1] === '/') { k = text.indexOf('\n', k) - 1; }
    else if (c === '/' && text[k + 1] === '*') { k = text.indexOf('*/', k) + 1; }
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) break;
  }
  return text.slice(m.index, k + 1);
}

const block = src.slice(src.indexOf('const versionedMigrations'), src.indexOf('assertMigrationJournalIntegrity(versionedMigrations)'));
const entries = [...block.matchAll(/\[(\d+),\s*'([^']+)',\s*(\w+)\]/g)].map((m) => ({ version: m[1], name: m[2], fn: m[3] }));
for (const e of entries) {
  const frozen = FROZEN[e.version];
  if (!frozen) continue; // a NEW migration (higher version) is allowed; it becomes frozen once released
  assert.equal(e.name, frozen.name, `v${e.version} name changed`);
  const hash = crypto.createHash('sha256').update(functionSource(src, e.fn)).digest('hex');
  assert.equal(hash, frozen.sha256, `Migration v${e.version} (${e.fn}) source changed after publication — this would break every existing database. Revert the edit (or add a NEW migration instead).`);
}
assert.equal(entries.filter((e) => FROZEN[e.version]).length, Object.keys(FROZEN).length, 'all published migrations are still present');
console.log(`MIGRATION SOURCE FROZEN REGRESSION: PASS (${Object.keys(FROZEN).length} published migrations byte-identical)`);
