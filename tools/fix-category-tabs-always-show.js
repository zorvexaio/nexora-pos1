#!/usr/bin/env node
// شغّلها مرة وحدة من جذر مشروعك: node tools/fix-category-tabs-always-show.js
'use strict';
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'renderer', 'pos.js');
const src = fs.readFileSync(file, 'utf8');

const OLD = `async function initCategoryTabs() {
  try {
    const categories = await window.api.categories.list();
    const withImages = categories.filter((c) => c.image_path);
    if (!withImages.length) { categoryTabs.classList.add('hidden'); return; }
    categoryTabs.classList.remove('hidden');
    const allTab = \`<button type="button" class="category-tab active" data-cat="">
      <span class="category-tab-icon">🍽️</span><span>\${t('pos.allCategories', 'الكل')}</span>
    </button>\`;
    const tabs = withImages.map((c) => \`
      <button type="button" class="category-tab" data-cat="\${c.id}">
        <img src="\${escapeHtml(c.image_path)}" alt="" />
        <span>\${escapeHtml(c.name)}</span>
      </button>
    \`).join('');
    categoryTabs.innerHTML = allTab + tabs;`;

const NEW = `async function initCategoryTabs() {
  try {
    const categories = await window.api.categories.list();
    // كل فئة مضافة من الإعدادات بتظهر كتبويب دايماً — صورة لو مرفوعة، وإلا أول حرف من
    // اسم الفئة كأيقونة نصية، بدل ما تختفي التبويبات بالكامل لمجرد عدم وجود صور.
    if (!categories.length) { categoryTabs.classList.add('hidden'); return; }
    categoryTabs.classList.remove('hidden');
    const allTab = \`<button type="button" class="category-tab active" data-cat="">
      <span class="category-tab-icon">🍽️</span><span>\${t('pos.allCategories', 'الكل')}</span>
    </button>\`;
    const tabs = categories.map((c) => \`
      <button type="button" class="category-tab" data-cat="\${c.id}">
        \${c.image_path
          ? \`<img src="\${escapeHtml(c.image_path)}" alt="" />\`
          : \`<span class="category-tab-icon">\${escapeHtml((c.name || '').trim().charAt(0) || '🏷️')}</span>\`}
        <span>\${escapeHtml(c.name)}</span>
      </button>
    \`).join('');
    categoryTabs.innerHTML = allTab + tabs;`;

if (src.includes(NEW) && !src.includes(OLD)) {
  console.log('لا شيء لعمله — الإصلاح مطبّق أصلاً.');
  process.exit(0);
}
if (!src.includes(OLD)) {
  console.error('لم أجد النص المتوقع بـ initCategoryTabs — راجعه يدوياً بـ renderer/pos.js.');
  process.exit(1);
}
fs.writeFileSync(file, src.replace(OLD, NEW), 'utf8');
console.log('تم: تبويبات الفئات بالكاشير بتظهر الآن لكل فئة (بصورة أو باسمها نصاً)، مش بس اللي عندها صورة.');
