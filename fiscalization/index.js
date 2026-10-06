'use strict';

/**
 * Fiscalization registry — country adapters plug in here.
 *
 * Contract for every adapter:
 *   async issueInvoice(invoice) -> {
 *     accepted: boolean,
 *     mode: string,
 *     reason?: string,
 *     externalId?: string,
 *     externalNumber?: string,
 *     invoiceId?: string|number,
 *     timestamp: ISO string,
 *     payload?: object
 *   }
 *   async cancelInvoice(invoice) -> same shape
 *   async status() -> { ready: boolean, mode: string, message: string, capabilities?: string[] }
 *
 * Never ship live government credentials inside the client package.
 * Adapters that need secrets must read them from OS secure storage / env at runtime.
 */

function isoNow() {
  return new Date().toISOString();
}

function baseResult(invoice, extra = {}) {
  return {
    accepted: false,
    mode: 'generic',
    invoiceId: invoice?.invoiceNumber || invoice?.id || null,
    timestamp: isoNow(),
    ...extra,
  };
}

/** Safe no-op — never pretends compliance. */
class GenericFiscalAdapter {
  constructor(config = {}) {
    this.config = { ...config };
    this.name = 'generic';
  }

  async issueInvoice(invoice) {
    return baseResult(invoice, {
      mode: this.name,
      reason: 'No country-specific fiscal adapter configured.',
    });
  }

  async cancelInvoice(invoice) {
    return baseResult(invoice, {
      mode: this.name,
      reason: 'No country-specific fiscal adapter configured.',
    });
  }

  async status() {
    return {
      ready: false,
      mode: this.name,
      message: 'Fiscalization disabled (generic adapter).',
      capabilities: [],
    };
  }
}

/**
 * Offline recording — stores intent locally as pending for later government submission.
 * Useful when the market adapter is not yet certified but the merchant needs an audit trail.
 */
class OfflineRecordingAdapter {
  constructor(config = {}) {
    this.config = { ...config };
    this.name = 'offline';
  }

  async issueInvoice(invoice) {
    return baseResult(invoice, {
      accepted: false,
      mode: this.name,
      reason: 'Recorded offline for later fiscal submission.',
      externalId: `offline-${invoice?.id || invoice?.invoiceNumber || Date.now()}`,
      payload: {
        recordedAt: isoNow(),
        totals: {
          total: invoice?.total ?? null,
          tax: invoice?.tax_total ?? invoice?.taxTotal ?? null,
        },
      },
    });
  }

  async cancelInvoice(invoice) {
    return baseResult(invoice, {
      accepted: false,
      mode: this.name,
      reason: 'Offline cancel recorded; submit to authority when adapter is certified.',
      externalId: `offline-cancel-${invoice?.id || invoice?.invoiceNumber || Date.now()}`,
    });
  }

  async status() {
    return {
      ready: true,
      mode: this.name,
      message: 'Offline recording enabled — documents stay pending until a live adapter is active.',
      capabilities: ['issue-pending', 'cancel-pending', 'local-audit'],
    };
  }
}

/**
 * Shell adapters for known markets. They validate configuration and refuse to claim
 * live acceptance until a certified integration module is registered at runtime.
 */
function createMarketShell(name, label, requiredConfigKeys = []) {
  return class MarketShellAdapter {
    constructor(config = {}) {
      this.config = { ...config };
      this.name = name;
      this.label = label;
      this.requiredConfigKeys = requiredConfigKeys;
    }

    _missingKeys() {
      return this.requiredConfigKeys.filter((k) => !this.config[k]);
    }

    async issueInvoice(invoice) {
      const missing = this._missingKeys();
      if (missing.length) {
        return baseResult(invoice, {
          mode: this.name,
          reason: `${this.label}: missing configuration keys: ${missing.join(', ')}. Register a certified adapter or complete config.`,
        });
      }
      return baseResult(invoice, {
        mode: this.name,
        reason: `${this.label}: shell adapter only — live government API is not bundled. Install certified connector.`,
      });
    }

    async cancelInvoice(invoice) {
      return this.issueInvoice(invoice);
    }

    async status() {
      const missing = this._missingKeys();
      return {
        ready: false,
        mode: this.name,
        message: missing.length
          ? `${this.label}: incomplete config (${missing.join(', ')}).`
          : `${this.label}: shell ready — awaiting certified connector registration.`,
        capabilities: ['status', 'config-check'],
        label: this.label,
      };
    }
  };
}

const TrGibShell = createMarketShell('tr.gib', 'Turkey GİB e-Fatura/e-Arşiv', [
  'vkn',
  'apiBaseUrl',
]);
const SaZatcaShell = createMarketShell('sa.zatca', 'Saudi ZATCA e-Invoicing', [
  'vatNumber',
  'csid',
]);
const EgEtaShell = createMarketShell('eg.eta', 'Egypt ETA e-Invoice', [
  'tin',
  'clientId',
]);

class FiscalizationRegistry {
  constructor() {
    this.adapters = new Map();
    this.activeName = 'generic';
    // Built-in safe adapters
    this.register('generic', new GenericFiscalAdapter());
    this.register('offline', new OfflineRecordingAdapter());
    this.register('tr.gib', new TrGibShell());
    this.register('sa.zatca', new SaZatcaShell());
    this.register('eg.eta', new EgEtaShell());
  }

  register(name, adapter) {
    if (!name || !adapter || typeof adapter.issueInvoice !== 'function') {
      throw new Error('Invalid fiscalization adapter.');
    }
    this.adapters.set(String(name).toLowerCase(), adapter);
  }

  setActive(name) {
    const key = String(name || 'generic').toLowerCase();
    if (!this.adapters.has(key)) throw new Error(`Unknown fiscal adapter: ${key}`);
    this.activeName = key;
    return this.get(key);
  }

  get(name) {
    const key = String(name || this.activeName || 'generic').toLowerCase();
    return this.adapters.get(key) || this.adapters.get('generic');
  }

  list() {
    return Array.from(this.adapters.keys());
  }

  async status(name) {
    const adapter = this.get(name);
    if (typeof adapter.status === 'function') return adapter.status();
    return { ready: false, mode: adapter.name || 'unknown', message: 'No status() on adapter.' };
  }
}

module.exports = {
  GenericFiscalAdapter,
  OfflineRecordingAdapter,
  FiscalizationRegistry,
  TrGibShell,
  SaZatcaShell,
  EgEtaShell,
};
