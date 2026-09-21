const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'style.css'), 'utf8');
const kitchen = fs.readFileSync(path.join(root, 'renderer', 'kitchen-ticket.js'), 'utf8');
const receipt = fs.readFileSync(path.join(root, 'renderer', 'receipt.js'), 'utf8');
const networkPrint = fs.readFileSync(path.join(root, 'lib', 'network-print.js'), 'utf8');

const checks = [
  ['paper width reaches receipt and kitchen renderers', /paperWidth/.test(main) && /body\.dataset\.paperWidth/.test(kitchen) && /body\.dataset\.paperWidth/.test(receipt)],
  ['delta items reach kitchen printer', /deltaItems/.test(main) && /deltaItems/.test(kitchen) && /autoSendKitchenDelta/.test(main)],
  ['minimal kitchen feed configured', main.includes('autoSendKitchen(saleId)') && main.includes('autoSendKitchenDelta(saleId, deltaItems)') && main.includes('}, 1);')],
  ['network print propagates feed lines', /captureWindowAndPrintNetwork\(win, \{ ip, port, dotsWidth, feedLinesAfter(, trimBottom: [^}]+)? \}/.test(main) && /buildFullPrintJob\(image, \{ dotsWidth, feedLinesAfter(, trimBottom)? \}/.test(networkPrint)],
  ['58 and 80mm screen widths exist', /data-paper-width='58'/.test(css) && /data-paper-width='80'/.test(css)],
  ['58 and 80mm print widths exist', /@media print[\s\S]*58mm[\s\S]*80mm/.test(css)],
  ['kitchen trailing padding is removed', css.includes('.kitchen-ticket { padding-bottom: 0 !important;') && css.includes('.kitchen-ticket .receipt-divider:last-child{display:none')],
  ['receipt base font remains explicitly larger', /\.receipt \{[^}]*font-size: 15px/.test(css) && /\.receipt-brand \{ font-size: 19px/.test(css) && /\.receipt-total \{ font-size: 18px/.test(css)],
];

let bad = 0;
for (const [name, ok] of checks) {
  if (ok) console.log('PASS:', name);
  else { console.error('FAIL:', name); bad += 1; }
}
if (bad) process.exit(1);
console.log(`PRINTING REGRESSION: PASS ${checks.length}/${checks.length}`);
