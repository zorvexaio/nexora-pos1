#!/usr/bin/env node
// شغّلها مرة وحدة من جذر مشروعك: node tools/fix-tax-duplicate-key.js
// بتدمج مفتاحي "tax" المكررين بـpreload.js بمكان واحد. بترفض تلمس الملف لو النص
// عندك مختلف عمّا هو متوقع (أمان).
'use strict';
const fs = require('fs');
const path = require('path');

const preloadPath = path.join(__dirname, '..', 'preload.js');
const src = fs.readFileSync(preloadPath, 'utf8');

const FIRST_BLOCK = `  tax: {
    defaultRate: (payload) => ipcRenderer.invoke('tax:defaultRate', payload),
  },
  suppliers: {`;
const FIRST_REPLACEMENT = `  suppliers: {`;

const SECOND_BLOCK = `  tax: {
    list: () => ipcRenderer.invoke('tax:list'),
    save: (profile) => ipcRenderer.invoke('tax:save', profile),
  },`;
const SECOND_REPLACEMENT = `  tax: {
    list: () => ipcRenderer.invoke('tax:list'),
    save: (profile) => ipcRenderer.invoke('tax:save', profile),
    defaultRate: (payload) => ipcRenderer.invoke('tax:defaultRate', payload),
  },`;

if (src.includes(SECOND_REPLACEMENT) && !src.includes(FIRST_BLOCK)) {
  console.log('لا شيء لعمله — tax مدموجة أصلاً بمكان واحد.');
  process.exit(0);
}
if (!src.includes(FIRST_BLOCK) || !src.includes(SECOND_BLOCK)) {
  console.error('لم أجد النصين المتوقعين بالضبط داخل preload.js — لم أعدّل أي شيء.');
  console.error('افتح preload.js وابحث يدوياً عن "tax:" (مرتين) وادمجهما.');
  process.exit(1);
}
if (src.split(FIRST_BLOCK).length - 1 !== 1 || src.split(SECOND_BLOCK).length - 1 !== 1) {
  console.error('أحد النصين ظهر أكثر من مرة — توقفت للأمان.');
  process.exit(1);
}
const fixed = src.replace(FIRST_BLOCK, FIRST_REPLACEMENT).replace(SECOND_BLOCK, SECOND_REPLACEMENT);
fs.writeFileSync(preloadPath, fixed, 'utf8');
console.log('تم: دُمج مفتاح tax المكرر بمكان واحد (list + save + defaultRate).');
