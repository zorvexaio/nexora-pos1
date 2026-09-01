#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const css = fs.readFileSync(path.join(root, 'renderer/style.css'), 'utf8');
const index = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');

function pass(name, condition) {
  if (!condition) throw new Error(`FAIL ${name}`);
  console.log(`PASS: ${name}`);
}

pass('premium release version is at least 0.36.0', (() => {
  const [a,b] = pkg.version.split('.').map(Number);
  return a > 0 || (a === 0 && (b > 36 || (b === 36)));
})());
pass('premium design token system is present', /--shadow-lg:\s*0\s+20px\s+50px/.test(css) && /--radius-xl:\s*22px/.test(css));
pass('premium brand mark is present', /\.brand-mark\s*\{[\s\S]*background:\s*linear-gradient/.test(css));
pass('premium product cards are styled', /\.product-card\s*\{[\s\S]*border-radius:\s*var\(--radius\)/.test(css) && /\.product-card:hover/.test(css));
pass('premium checkout action is styled', /\.checkout-btn\s*\{[\s\S]*linear-gradient\(135deg, var\(--brand-indigo\)/.test(css) && /\.checkout-btn:hover:not\(:disabled\)/.test(css));
pass('premium responsive layout exists', /@media \(max-width: 980px\)/.test(css) && /@media \(max-width: 560px\)/.test(css));
pass('reduced-motion safety exists', /@media \(prefers-reduced-motion: reduce\)/.test(css));
pass('premium dark mode exists', /body\[data-theme="dark"\][\s\S]*--surface:\s*#161a2e/.test(css));
pass('POS still uses shared stylesheet', /href="style\.css"/.test(index));
pass('POS search and checkout anchors remain', /id="searchInput"/.test(index) && /id="checkoutBtn"/.test(index));
console.log('V0.36 REGRESSION 10/10 PASS');
