const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const css=fs.readFileSync(path.join(root,'renderer','style.css'),'utf8');
function pass(n,c){if(!c) throw new Error(`FAIL ${n}`); console.log(`PASS ${n}`)}
pass('signature design tokens', css.includes('--brand-gold') && css.includes('--brand-indigo'));
pass('application topbar', css.includes('.topbar {') && css.includes('var(--brand-gold)'));
pass('premium product cards', css.includes('.product-card:hover') && css.includes('border-radius: var(--radius)'));
pass('checkout rail', css.includes('.cart-panel {') && css.includes('.checkout-btn {'));
pass('report cards', css.includes('.summary-card {') && css.includes('.kpi-card'));
pass('modal depth', css.includes('.modal-overlay') && css.includes('backdrop-filter'));
pass('login card', css.includes('.login-card {') && css.includes('border-radius'));
pass('dark surfaces', css.includes('body[data-theme="dark"]') && css.includes('--surface: #161a2e'));
pass('reduced motion preserved', css.includes('prefers-reduced-motion: reduce'));
console.log('V0.39 PREMIUM REGRESSION 9/9 PASS');
