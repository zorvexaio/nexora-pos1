#!/usr/bin/env node
/**
 * Nexora POS — skip-link continuous quality check
 * Verifies every interactive HTML page has a .skip-link and a matching target id.
 * Print-only pages (receipt, kitchen-ticket) are optional.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'renderer');
const OPTIONAL = new Set(['receipt.html', 'kitchen-ticket.html']);

function walk(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (name.endsWith('.html')) acc.push(full);
  }
  return acc;
}

const files = walk(ROOT);
let failed = 0;
const report = [];

for (const file of files) {
  const base = path.basename(file);
  const html = fs.readFileSync(file, 'utf8');
  const hasSkip = /class=["'][^"']*skip-link[^"']*["']/.test(html) || /class=["']skip-link["']/.test(html);
  const hrefMatch = html.match(/class=["'][^"']*skip-link[^"']*["'][^>]*href=["']#([^"']+)["']/)
    || html.match(/href=["']#([^"']+)["'][^>]*class=["'][^"']*skip-link/);
  const targetId = hrefMatch ? hrefMatch[1] : null;
  const hasTarget = targetId ? new RegExp(`id=["']${targetId}["']`).test(html) : false;

  if (OPTIONAL.has(base)) {
    report.push({ file: path.relative(ROOT, file), status: hasSkip ? 'ok' : 'optional-skip', hasSkip, targetId, hasTarget });
    continue;
  }

  if (!hasSkip || (targetId && !hasTarget)) {
    failed += 1;
    report.push({ file: path.relative(ROOT, file), status: 'FAIL', hasSkip, targetId, hasTarget });
  } else {
    report.push({ file: path.relative(ROOT, file), status: 'ok', hasSkip, targetId, hasTarget });
  }
}

console.log('Nexora POS skip-link check');
console.log('==========================');
for (const r of report) {
  const mark = r.status === 'ok' ? '✓' : r.status === 'optional-skip' ? '·' : '✗';
  console.log(`${mark} ${r.file}  skip=${r.hasSkip} target=#${r.targetId || '?'} exists=${r.hasTarget}`);
}
console.log('--------------------------');
if (failed) {
  console.error(`FAILED: ${failed} page(s) missing skip-link or target.`);
  process.exit(1);
}
console.log(`OK: ${report.filter((r) => r.status === 'ok').length} pages with skip-link.`);
process.exit(0);
