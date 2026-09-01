// v0.41.7 regression: shared product catalog + branch-scoped operational inventory.
'use strict';
const fs = require('fs');
const assert = require('assert');
const db = fs.readFileSync('database/db.js', 'utf8');
const schema = fs.readFileSync('database/schema.sql', 'utf8');
const main = fs.readFileSync('main.js', 'utf8');
function pass(label) { console.log(`PASS: ${label}`); }
function ok(condition, label) { assert(condition, `FAIL: ${label}`); pass(label); }
const productsTable = (schema.match(/CREATE TABLE IF NOT EXISTS products[\s\S]*?\);/i) || ['',''])[0];
const inventoryTable = (schema.match(/CREATE TABLE IF NOT EXISTS inventory[\s\S]*?\);/i) || ['',''])[0];
ok(/CREATE TABLE IF NOT EXISTS products/i.test(schema), 'products table exists');
ok(!/\bbranch_id\b/i.test(productsTable), 'products catalog is not branch-owned');
ok(/branch_id/i.test(inventoryTable), 'inventory is branch-owned');
ok(/ipcMain\.handle\('products:update',[\s\S]*?requireManagerOrAdmin\(\)/.test(main), 'products:update remains manager/admin protected');
ok(/ipcMain\.handle\('products:delete',[\s\S]*?requireManagerOrAdmin\(\)/.test(main), 'products:delete remains manager/admin protected');
ok(/function updateProduct\(p\)[\s\S]*?UPDATE products SET/.test(db), 'updateProduct mutates shared catalog');
ok(/function deleteProduct\(id\)[\s\S]*?UPDATE products SET is_active = 0/.test(db), 'deleteProduct soft-deletes shared catalog');
ok(!/function updateProduct\(p\)[\s\S]{0,900}throw new Error\('المنتج غير موجود في الفرع الحالي\.'\)/.test(db), 'updateProduct has no fictitious branch-ownership guard');
ok(!/function deleteProduct\(id\)[\s\S]{0,700}throw new Error\('المنتج غير موجود في الفرع الحالي\.'\)/.test(db), 'deleteProduct has no fictitious branch-ownership guard');
ok(/const findByBarcode = db\.prepare\([\s\S]*?FROM products[\s\S]*?WHERE barcode = \?/.test(db), 'CSV barcode matching uses shared catalog');
ok(/const findByName = db\.prepare\([\s\S]*?FROM products[\s\S]*?WHERE name = \? AND is_active = 1/.test(db), 'CSV name matching uses shared catalog');
ok(/createBranchInventory = db\.prepare/.test(db), 'CSV import creates branch inventory when missing');
console.log('V0.41.7 REGRESSION: PASS (12/12)');
