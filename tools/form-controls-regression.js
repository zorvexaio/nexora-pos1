// اختبار: مربعات الاختيار/الراديو صغيرة في كامل التطبيق (القاعدة العامة .form-field input كانت تجعلها 100%×42px).
const assert = require('assert');
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', 'renderer');
const style = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', '19-form-controls.css'), 'utf8');
assert.match(style, /19-form-controls\.css/, 'style.css must import 19-form-controls.css');
assert.ok(style.indexOf('19-form-controls.css') > style.indexOf('15-compact-fit.css'), 'form-controls must load after the generic input rules');
assert.match(css, /input\[type="checkbox"\]:not\(\.method-option input\)/, 'checkbox rule must exclude the payment method overlay inputs');
assert.match(css, /width:\s*16px\s*!important/, 'checkboxes must be 16px wide');
assert.match(css, /height:\s*16px\s*!important/, 'checkboxes must be 16px tall');
console.log('FORM CONTROLS REGRESSION: PASS');
