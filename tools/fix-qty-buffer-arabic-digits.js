#!/usr/bin/env node
// شغّلها مرة وحدة من جذر مشروعك: node tools/fix-qty-buffer-arabic-digits.js
// بتصلّح مشكلة: خانة "الكمية" بالكاشير type="number" فبترفض الأرقام العربية/الفارسية
// بصمت. بترفض تلمس الملفات لو النص عندك مختلف عمّا هو متوقع (أمان).
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const htmlPath = path.join(root, 'renderer', 'index.html');
const jsPath = path.join(root, 'renderer', 'pos.js');

function patch(filePath, oldStr, newStr, label) {
  const src = fs.readFileSync(filePath, 'utf8');
  if (src.includes(newStr) && !src.includes(oldStr)) {
    console.log(`لا شيء لعمله بـ ${label} — الإصلاح مطبّق أصلاً.`);
    return;
  }
  if (!src.includes(oldStr)) {
    console.error(`لم أجد النص المتوقع بـ ${label} — لم أعدّل أي شيء. راجعه يدوياً.`);
    process.exitCode = 1;
    return;
  }
  const count = src.split(oldStr).length - 1;
  if (count !== 1) {
    console.error(`النص المستهدف بـ ${label} ظهر ${count} مرة بدل مرة واحدة — توقفت للأمان.`);
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(filePath, src.replace(oldStr, newStr), 'utf8');
  console.log(`تم تعديل ${label}.`);
}

patch(
  htmlPath,
  `<input id="qtyBufferInput" type="number" min="1" step="1" value="1" />`,
  `<input id="qtyBufferInput" type="text" inputmode="numeric" maxlength="4" value="1" />`,
  'renderer/index.html'
);

patch(
  jsPath,
  `const qty = Math.max(1, Math.floor(Number(qtyBufferInput?.value) || 1));`,
  `const qty = Math.max(1, Math.floor(parseLocaleNumber(qtyBufferInput?.value) || 1));`,
  'renderer/pos.js'
);
