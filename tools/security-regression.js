// Lightweight source-level regression checks that do not require Electron/native dependencies.
const fs = require('fs');
const assert = require('assert');
const path = require('path');
const ROOT = process.cwd();
function check(condition, label) { assert(condition, `Missing regression guard: ${label}`); }

const main = fs.readFileSync('main.js', 'utf8');
const db = fs.readFileSync('database/db.js', 'utf8');
const pos = fs.readFileSync('renderer/pos.js', 'utf8');

function mustContain(source, text, label) {
  assert(source.includes(text), `Missing regression guard: ${label}`);
}

mustContain(main, 'approvalGrants.set(grantId', 'approval grants are server-side');
mustContain(main, 'consumeApprovalGrant(sale.discountApprovalGrantId)', 'discount approvals are consumed server-side');
mustContain(main, 'consumeApprovalGrant(sale.creditApprovalGrantId)', 'credit approvals are consumed server-side');
mustContain(main, "db.getSale(id, db.getCurrentBranch().id)", 'sales:get is branch scoped');

mustContain(db, 'function validatePaymentAmounts(', 'payment validation helper exists');
mustContain(db, 'validatePaymentAmounts(grandTotal', 'normal sales validate payment totals');
mustContain(db, 'calculateBundleDiscountFromDatabase', 'bundle discount is recomputed server-side');
mustContain(db, "WHERE s.id = ? AND (? IS NULL OR s.branch_id = ?)", 'getSale supports branch scoping');
mustContain(db, "FROM sales WHERE id = ? AND branch_id = ?", 'returns are branch scoped');

mustContain(pos, 'bundleIds: bundleResult.appliedBundleIds', 'UI sends bundle selections for server verification');
mustContain(pos, 'discountApprovalGrantId', 'UI sends server-side discount approval grant');
mustContain(pos, 'creditApprovalGrantId', 'UI sends server-side credit approval grant');


const schema = fs.readFileSync(path.join(ROOT, 'database', 'schema.sql'), 'utf8');
check(!/CREATE TABLE IF NOT EXISTS suppliers\s*\(\s*id INTEGER PRIMARY KEY AUTOINCREMENT,\s*id INTEGER PRIMARY KEY AUTOINCREMENT/i.test(schema), 'suppliers schema has no duplicate primary-key column');
check(/function nextInvoiceNumber\(\)/.test(db), 'invoice numbering function exists');
check(/invoice_sequence_\$\{branch\.uuid \|\| branch\.id\}_\$\{terminalToken\}_\$\{year\}/.test(db), 'invoice sequence is branch-and-terminal-scoped');
check(/FROM users WHERE branch_id = \?[^;]*ORDER BY id/.test(db), 'user listing is branch-scoped');
check(/SELECT \* FROM users WHERE id = \? AND branch_id = \?/.test(db), 'user lookup is branch-scoped');
check(/function validateBackupFile\(filePath\)/.test(db), 'backup file validation exists');

console.log('Security regression source checks: PASS');
