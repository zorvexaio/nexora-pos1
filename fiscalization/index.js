'use strict';

class GenericFiscalAdapter {
  constructor(config = {}) { this.config = { ...config }; }
  async issueInvoice(invoice) {
    return { accepted: false, mode: 'generic', reason: 'No country-specific fiscal adapter configured.', invoiceId: invoice?.invoiceNumber || null };
  }
  async cancelInvoice(invoice) {
    return { accepted: false, mode: 'generic', reason: 'No country-specific fiscal adapter configured.', invoiceId: invoice?.invoiceNumber || null };
  }
}

class FiscalizationRegistry {
  constructor() { this.adapters = new Map([['generic', new GenericFiscalAdapter()]]); }
  register(name, adapter) {
    if (!name || !adapter || typeof adapter.issueInvoice !== 'function') throw new Error('Invalid fiscalization adapter.');
    this.adapters.set(String(name).toLowerCase(), adapter);
  }
  get(name) { return this.adapters.get(String(name || 'generic').toLowerCase()) || this.adapters.get('generic'); }
}

module.exports = { GenericFiscalAdapter, FiscalizationRegistry };
