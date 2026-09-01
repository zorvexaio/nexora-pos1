const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const common = fs.readFileSync(path.join(root, 'renderer', 'common.js'), 'utf8');
const pos = fs.readFileSync(path.join(root, 'renderer', 'pos.js'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'database', 'schema.sql'), 'utf8');
const checks = [
  ['release version follows semver', /^0\.\d+\.\d+$/.test(pkg.version)],
  ['renderer heartbeat API exists', /system:\s*\{\s*rendererHeartbeat:/.test(preload)],
  ['renderer heartbeat IPC exists', /system:rendererHeartbeat/.test(main)],
  ['renderer watchdog records stalls without forcing a reload', /renderer_watchdog_stall/.test(main) && /no_automatic_reload/.test(main) && !/renderer_watchdog_recovery/.test(main)],
  ['watchdog protects active payment', /rendererHeartbeat\.paymentOpen \|\| rendererHeartbeat\.busy/.test(main)],
  ['watchdog requires a long stall', /age < 12000/.test(main)],
  ['POS uses document fragment for products', /createDocumentFragment\(\)/.test(pos)],
  ['POS uses product event delegation', /productsGrid\.addEventListener\('click'/.test(pos)],
  ['POS uses cart event delegation', /cartItemsEl\.addEventListener\('click'/.test(pos)],
  ['search debounce is above 250ms', /debounce\(\(\) => loadProducts\(searchInput\.value\), 325\)/.test(pos)],
  ['draft save remains deferred', /setTimeout\(persistDraftCartNow, 300\)/.test(pos)],
  ['product indexes exist', /idx_products_name/.test(schema) && /idx_products_barcode/.test(schema) && /idx_products_sku/.test(schema)],
  ['no fixed legacy admin password in runtime files', !/(?:admin\/admin123|password:\s*["']admin123["'])/.test(main + preload + common + pos)],
];
let failed=0;
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'}: ${name}`);if(!ok)failed++;}
if(failed) process.exit(1);
console.log(`V0.15 REGRESSION: PASS (${checks.length} checks)`);
