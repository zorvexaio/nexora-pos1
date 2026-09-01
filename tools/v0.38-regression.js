const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const css = fs.readFileSync(path.join(root,'renderer','style.css'),'utf8');
const fail = (m)=>{ throw new Error(`FAIL ${m}`); };
const pass = (m)=>console.log(`PASS ${m}`);
function ok(c,m){ c?pass(m):fail(m); }
const [vMaj, vMin] = pkg.version.split('.').map(Number);
ok(vMaj > 0 || vMin >= 38,'version is compatible with premium UI baseline');
ok(css.includes('Nexora POS — Design System (v1.0)'),'shared design-system layer present');
ok(css.includes('focus-visible'),'keyboard focus treatment present');
ok(css.includes('prefers-reduced-motion'),'reduced motion support retained');
ok(css.includes('backdrop-filter: blur(10px)'),'modal backdrop present');
ok(css.includes('.products-table tbody tr:hover'),'table interaction treatment present');
ok(css.includes('.checkout-btn:hover:not(:disabled)'),'checkout action treatment present');
ok(css.includes('.empty-state {'),'empty state present');
ok(css.includes('@media (max-width: 560px)'),'mobile polish present');
console.log('V0.38 REGRESSION 9/9 PASS');
