#!/usr/bin/env node
'use strict';
const path = require('path');
const { FiscalizationRegistry } = require(path.join(__dirname, '..', 'fiscalization'));

async function main() {
  const reg = new FiscalizationRegistry();
  const expected = ['generic', 'offline', 'tr.gib', 'sa.zatca', 'eg.eta'];
  const list = reg.list();
  for (const name of expected) {
    if (!list.includes(name)) throw new Error(`missing adapter: ${name}`);
  }
  const sample = { id: 1, invoiceNumber: 'INV-1', total: 100, tax_total: 15 };

  const generic = await reg.get('generic').issueInvoice(sample);
  if (generic.accepted) throw new Error('generic must not accept');

  const offline = await reg.get('offline').issueInvoice(sample);
  if (offline.accepted) throw new Error('offline must not claim live acceptance');
  if (!offline.externalId) throw new Error('offline should set externalId');

  const tr = await reg.status('tr.gib');
  if (tr.ready) throw new Error('tr.gib shell must not be ready without certified connector');

  const offlineStatus = await reg.status('offline');
  if (!offlineStatus.ready) throw new Error('offline status should be ready for local recording');

  console.log('fiscalization-smoke: OK');
  console.log('  providers:', list.join(', '));
  console.log('  offline.externalId sample:', offline.externalId);
  console.log('  tr.gib message:', tr.message);
}

main().catch((err) => {
  console.error('fiscalization-smoke FAILED:', err.message);
  process.exit(1);
});
