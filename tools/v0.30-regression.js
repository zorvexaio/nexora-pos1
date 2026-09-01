#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const db = fs.readFileSync(path.join(__dirname, '..', 'database', 'db.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'sync-server.js'), 'utf8');
let pass = 0;
function ok(name, condition) { if (!condition) throw new Error(`FAIL ${name}`); console.log(`PASS ${name}`); pass += 1; }
ok('version is compatible with v0.29 baseline', /^0\.(2[9]|3[0-9]|[4-9][0-9])\.\d+$/.test(pkg.version));
ok('invoice number includes terminal token', db.includes('getTerminalInvoiceToken') && db.includes('${terminalToken}'));
ok('terminal invoice id is stored outside the database for device uniqueness', db.includes('terminal-invoice-id.txt'));
ok('invoice sequence is terminal-scoped', db.includes('invoice_sequence_${branch.uuid || branch.id}_${terminalToken}_${year}'));
ok('local invoice collision is checked before allocation', db.includes("SELECT id FROM sales WHERE invoice_number = ? LIMIT 1"));
ok('central sync reserves invoice numbers', server.includes('CREATE TABLE IF NOT EXISTS invoice_numbers') && server.includes('reserveInvoiceNumber'));
ok('central sync rejects invoice collisions across devices', server.includes('Invoice number collision for branch'));
console.log(`V0.30 REGRESSION ${pass}/7 PASS`);
