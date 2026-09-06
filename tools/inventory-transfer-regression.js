#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function expect(text, pattern, message) { assert(pattern.test(text), message); }

const db = read('database/db.js');
const server = read('server/sync-server.js');
const preload = read('preload.js');
const main = read('main.js');
const html = read('renderer/pages/inventory.html');
const renderer = read('renderer/pages/inventory.js');
const schema = read('database/schema.sql');

// كان يطابق قائمة ثابتة (11..15) فيفشل تلقائياً مع أي ترحيلة لاحقة (فشل فعلياً منذ v16).
{
  const m = db.match(/CURRENT_SCHEMA_VERSION = (\d+)/);
  assert(!!m, 'A numeric schema version constant is required.');
  assert(Number(m[1]) >= 11, 'Schema version must not regress below the inventory-transfer migration (v11).');
}
expect(db, /inventory-transfer-workflow-v11/, 'v11 migration is missing.');
for (const table of ['branch_directory','inventory_transfers','inventory_transfer_items','inventory_transfer_receipts','inventory_transfer_receipt_items']) {
  expect(db, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `DB migration table missing: ${table}`);
  expect(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `Schema table missing: ${table}`);
}
expect(db, /UPDATE inventory SET quantity=quantity-\?/s, 'Shipment does not decrement stock atomically.');
expect(db, /quantity>=\?/s, 'Shipment does not enforce a stock floor.');
expect(db, /reason.*transfer_out/s, 'Shipment movement is missing.');
expect(db, /reason.*transfer_in/s, 'Receipt movement is missing.');
expect(db, /synced\)!==0.*cannot|synced\)!==0/s, 'Post-sync cancellation guard missing.');
expect(server, /CROSS_BRANCH_ENTITIES/, 'Server cross-branch entity policy missing.');
expect(server, /ownerField !== branchUuid/, 'Server ownership validation missing.');
expect(server, /source_branch_uuid = \? OR destination_branch_uuid = \?/s, 'Cross-branch pull routing missing.');
for (const channel of ['inventory:transferBranches','inventory:addTransferBranch','inventory:createTransfer','inventory:transfers','inventory:getTransfer','inventory:receiveTransfer','inventory:cancelTransfer']) {
  assert(main.includes(channel), `Main IPC missing: ${channel}`);
  assert(preload.includes(channel), `Preload IPC missing: ${channel}`);
}
for (const id of ['tabTransfersBtn','transferModal','transferBranchModal','transfersTableBody']) assert(html.includes(id), `Transfer UI element missing: ${id}`);
for (const name of ['loadTransfers','openTransferModal','saveTransfer','receiveTransfer','cancelTransfer']) expect(renderer, new RegExp(`function ${name}`), `Renderer function missing: ${name}`);
console.log('Inventory transfer regression: PASS');
