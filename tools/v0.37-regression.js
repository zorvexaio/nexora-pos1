const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const style = fs.readFileSync(path.join(root, 'renderer', 'style.css'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
let checks = 0;
function pass(name, cond) {
  checks += 1;
  if (!cond) throw new Error(`FAIL ${name}`);
  console.log(`PASS ${name}`);
}
const [major, minor] = pkg.version.split('.').map(Number);
pass('version remains compatible with v0.37 baseline', major === 0 && minor >= 37);
pass('design tokens present', style.includes('--brand-gold') && style.includes('--brand-indigo'));
pass('brand treatment present', style.includes('.brand-mark') && style.includes('var(--brand-gold)'));
pass('application shell is styled', style.includes('.topbar {') && style.includes('box-shadow: 0 1px 0 var(--brand-gold)'));
pass('checkout rail treatment present', style.includes('.cart-panel {') && style.includes('.checkout-btn {'));
pass('modal treatment present', style.includes('.modal-overlay') && style.includes('.modal {'));
pass('dark theme refinement present', style.includes('body[data-theme="dark"]') && style.includes('--surface: #161a2e'));
pass('reduced motion preserved', style.includes('@media (prefers-reduced-motion: reduce)'));
pass('no unsafe script additions in css', !/javascript:|expression\s*\(/i.test(style));
console.log(`V0.37 PREMIUM UI: ${checks}/9 PASS`);
