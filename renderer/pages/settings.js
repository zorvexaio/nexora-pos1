const branchNameEl = document.getElementById('branchName');
const settingsForm = document.getElementById('settingsForm');
const fieldBranchName = document.getElementById('fieldBranchName');
const fieldBusinessType = document.getElementById('fieldBusinessType');
const currencyForm = document.getElementById('currencyForm');
const fieldCurrencyBase = document.getElementById('fieldCurrencyBase');
const fieldCurrencySecondary = document.getElementById('fieldCurrencySecondary');
const fieldShowSecondaryOnReceipt = document.getElementById('fieldShowSecondaryOnReceipt');
const fieldExchangeRate = document.getElementById('fieldExchangeRate');
const fieldTaxNumber = document.getElementById('fieldTaxNumber');
const globalForm = document.getElementById('globalForm');
const fieldCountryCode = document.getElementById('fieldCountryCode');
const fieldLocale = document.getElementById('fieldLocale');
const fieldTimezone = document.getElementById('fieldTimezone');
const fieldGlobalCurrency = document.getElementById('fieldGlobalCurrency');
const fieldMinorUnit = document.getElementById('fieldMinorUnit');
const fieldTaxMode = document.getElementById('fieldTaxMode');
const fieldGlobalTaxNumber = document.getElementById('fieldGlobalTaxNumber');
const fieldFiscalizationMode = document.getElementById('fieldFiscalizationMode');
const fieldFiscalProvider = document.getElementById('fieldFiscalProvider');

const discountForm = document.getElementById('discountForm');
const fieldMaxDiscountPercent = document.getElementById('fieldMaxDiscountPercent');
const taxDefaultForm = document.getElementById('taxDefaultForm');
const fieldReceiptBarcodeEnabled = document.getElementById('fieldReceiptBarcodeEnabled');
const fieldQuickCashierEnabled = document.getElementById('fieldQuickCashierEnabled');
const fieldOffersCategoryEnabled = document.getElementById('fieldOffersCategoryEnabled');
const fieldTaxDefaultRate = document.getElementById('fieldTaxDefaultRate');
const loyaltyForm = document.getElementById('loyaltyForm');
const fieldLoyaltyEarnRate = document.getElementById('fieldLoyaltyEarnRate');
const fieldLoyaltyRedeemRate = document.getElementById('fieldLoyaltyRedeemRate');
const deliveryPricingForm = document.getElementById('deliveryPricingForm');
const fieldDeliveryDefaultFee = document.getElementById('fieldDeliveryDefaultFee');
const fieldDeliveryPricePerKm = document.getElementById('fieldDeliveryPricePerKm');
const weighingForm = document.getElementById('weighingForm');
const fieldWeightedPrefix = document.getElementById('fieldWeightedPrefix');

const createBackupBtn = document.getElementById('createBackupBtn');
const restoreBackupBtn = document.getElementById('restoreBackupBtn');
const backupStatus = document.getElementById('backupStatus');
const autoBackupStatus = document.getElementById('autoBackupStatus');

const createPortableBackupBtn = document.getElementById('createPortableBackupBtn');
const restorePortableBackupBtn = document.getElementById('restorePortableBackupBtn');
const portableBackupStatus = document.getElementById('portableBackupStatus');
const portableBackupModal = document.getElementById('portableBackupModal');
const portableBackupTitle = document.getElementById('portableBackupTitle');
const portableBackupHint = document.getElementById('portableBackupHint');
const portableBackupForm = document.getElementById('portableBackupForm');
const portableBackupPassphrase = document.getElementById('portableBackupPassphrase');
const portableBackupConfirmField = document.getElementById('portableBackupConfirmField');
const portableBackupConfirm = document.getElementById('portableBackupConfirm');
const portableBackupError = document.getElementById('portableBackupError');
const portableBackupSubmit = document.getElementById('portableBackupSubmit');
const portableBackupCancel = document.getElementById('portableBackupCancel');

const brandingForm = document.getElementById('brandingForm');
const fieldStoreName = document.getElementById('fieldStoreName');
const fieldReceiptFooter = document.getElementById('fieldReceiptFooter');
const selectLogoBtn = document.getElementById('selectLogoBtn');
const logoPreview = document.getElementById('logoPreview');
const fieldBranchUuid = document.getElementById('fieldBranchUuid');
const syncForm = document.getElementById('syncForm');
const fieldSyncServerUrl = document.getElementById('fieldSyncServerUrl');
const fieldSyncToken = document.getElementById('fieldSyncToken');
const fieldSyncEnabled = document.getElementById('fieldSyncEnabled');
const syncNowBtn = document.getElementById('syncNowBtn');
const syncStatus = document.getElementById('syncStatus');
const printingForm = document.getElementById('printingForm');
const fieldKitchenAutoPrint = document.getElementById('fieldKitchenAutoPrint');
const fieldKitchenPrinterName = document.getElementById('fieldKitchenPrinterName');
const fieldReceiptAutoPrint = document.getElementById('fieldReceiptAutoPrint');
const fieldReceiptPrinterName = document.getElementById('fieldReceiptPrinterName');
const fieldKitchenPrinterMode = document.getElementById('fieldKitchenPrinterMode');
const fieldKitchenPrinterPaperWidth = document.getElementById('fieldKitchenPrinterPaperWidth');
const fieldKitchenPrinterIp = document.getElementById('fieldKitchenPrinterIp');
const fieldKitchenPrinterPort = document.getElementById('fieldKitchenPrinterPort');
const testKitchenNetworkPrinterBtn = document.getElementById('testKitchenNetworkPrinterBtn');
const fieldReceiptPrinterMode = document.getElementById('fieldReceiptPrinterMode');
const fieldReceiptPrinterPaperWidth = document.getElementById('fieldReceiptPrinterPaperWidth');
const fieldReceiptPrinterIp = document.getElementById('fieldReceiptPrinterIp');
const fieldReceiptPrinterPort = document.getElementById('fieldReceiptPrinterPort');
const testReceiptNetworkPrinterBtn = document.getElementById('testReceiptNetworkPrinterBtn');
const loadAuditBtn = document.getElementById('loadAuditBtn');
const auditLogList = document.getElementById('auditLogList');
const appCurrentVersion = document.getElementById('appCurrentVersion');
const fieldAutoCheckUpdates = document.getElementById('fieldAutoCheckUpdates');
const checkUpdateBtn = document.getElementById('checkUpdateBtn');
const downloadUpdateBtn = document.getElementById('downloadUpdateBtn');
const installUpdateBtn = document.getElementById('installUpdateBtn');
const updateStatus = document.getElementById('updateStatus');

const lanRoleTabs = document.getElementById('lanRoleTabs');
const lanMainPanel = document.getElementById('lanMainPanel');
const lanTerminalPanel = document.getElementById('lanTerminalPanel');
const fieldLanDeviceName = document.getElementById('fieldLanDeviceName');
const generatePairingCodeBtn = document.getElementById('generatePairingCodeBtn');
const pairingCodeBox = document.getElementById('pairingCodeBox');
const pairingCodeDisplay = document.getElementById('pairingCodeDisplay');
const pairingCodeExpiry = document.getElementById('pairingCodeExpiry');
const lanConnectedBox = document.getElementById('lanConnectedBox');
const lanConnectedInfo = document.getElementById('lanConnectedInfo');
const lanDisconnectBtn = document.getElementById('lanDisconnectBtn');
const lanDiscoveryBox = document.getElementById('lanDiscoveryBox');
const lanDevicesList = document.getElementById('lanDevicesList');
let lanStatusPollTimer = null;

let currentBranch = null;

async function init() {
  const user = await guardPage(['admin'], '../login.html');
  if (!user) return;

  loadAutoBackupStatus();
  renderCategoryImagesPanel();
  renderOffersImageCard();
  fieldReceiptBarcodeEnabled.checked = (await window.api.receipt.barcodeEnabled()).enabled !== false;
  fieldReceiptBarcodeEnabled.addEventListener('change', saveReceiptBarcodeEnabled);
  fieldQuickCashierEnabled.checked = (await window.api.posMode.quickCashierEnabled()).enabled === true;
  fieldQuickCashierEnabled.addEventListener('change', saveQuickCashierEnabled);
  fieldOffersCategoryEnabled.checked = (await window.api.pos.offersCategoryEnabled()).enabled !== false;
  fieldOffersCategoryEnabled.addEventListener('change', saveOffersCategoryEnabled);
  currentBranch = await window.api.branches.current();
  branchNameEl.textContent = currentBranch ? currentBranch.name : '';
  fieldBranchUuid.value = currentBranch ? currentBranch.uuid : '';
  fieldBranchName.value = currentBranch.name;
  fieldBusinessType.value = currentBranch.business_type || 'general';
  const globalProfile = await window.api.global.get();
  fieldCountryCode.value = globalProfile.country_code || 'TR';
  fieldLocale.value = globalProfile.locale || 'ar';
  fieldTimezone.value = globalProfile.timezone || 'Europe/Istanbul';
  fieldGlobalCurrency.value = globalProfile.currency_code || 'TRY';
  fieldMinorUnit.value = globalProfile.currency_minor_unit ?? 2;
  fieldTaxMode.value = globalProfile.tax_mode || 'exclusive';
  fieldGlobalTaxNumber.value = globalProfile.tax_registration_number || '';
  fieldFiscalizationMode.value = globalProfile.fiscalization_mode || 'none';
  fieldFiscalProvider.value = globalProfile.fiscal_provider || '';
  const currency = await window.api.currency.get();
  fieldCurrencyBase.value = currency.base;
  fieldCurrencySecondary.value = currency.secondary;
  fieldShowSecondaryOnReceipt.checked = currency.showSecondaryOnReceipt;
  fieldExchangeRate.value = currency.rate;
  fieldTaxNumber.value = currency.taxNumber || '';

  fieldMaxDiscountPercent.value = await window.api.discount.maxCashierPercent();
  fieldTaxDefaultRate.value = (await window.api.tax.defaultRate()).defaultTaxRate;
  const loyaltySettings = await window.api.loyalty.settings();
  fieldLoyaltyEarnRate.value = loyaltySettings.earnPerCurrencyUnit;
  fieldLoyaltyRedeemRate.value = loyaltySettings.redeemPointsPerCurrencyUnit;
  fieldWeightedPrefix.value = await window.api.weighing.getPrefix();
  const deliveryPricing = await window.api.delivery.getPricing();
  fieldDeliveryDefaultFee.value = deliveryPricing.defaultFee;
  fieldDeliveryPricePerKm.value = deliveryPricing.pricePerKm;

  const branding = await window.api.branding.get();
  fieldStoreName.value = branding.storeName || '';
  fieldReceiptFooter.value = branding.receiptFooterMessage || '';
  if (branding.logoPath) {
    logoPreview.src = window.api.pathToFileURL(branding.logoPath);
    logoPreview.style.display = 'inline-block';
  }

  settingsForm.addEventListener('submit', save);
  currencyForm.addEventListener('submit', saveCurrency);
  globalForm.addEventListener('submit', saveGlobalProfile);
  discountForm.addEventListener('submit', saveDiscountLimit);
  taxDefaultForm.addEventListener('submit', saveTaxDefaultRate);
  loyaltyForm.addEventListener('submit', saveLoyaltySettings);
  deliveryPricingForm.addEventListener('submit', saveDeliveryPricing);
  weighingForm.addEventListener('submit', saveWeighingPrefix);
  createBackupBtn.addEventListener('click', createBackup);
  restoreBackupBtn.addEventListener('click', restoreBackup);
  createPortableBackupBtn.addEventListener('click', () => openPortableBackupModal('create'));
  restorePortableBackupBtn.addEventListener('click', () => openPortableBackupModal('restore'));
  portableBackupCancel.addEventListener('click', closePortableBackupModal);
  portableBackupForm.addEventListener('submit', submitPortableBackup);
  brandingForm.addEventListener('submit', saveBranding);
  selectLogoBtn.addEventListener('click', selectLogo);
  const syncConfig = await window.api.sync.getConfig();
  fieldSyncServerUrl.value = syncConfig.serverUrl || '';
  fieldSyncToken.value = syncConfig.token || '';
  fieldSyncEnabled.checked = !!syncConfig.enabled;
  syncForm.addEventListener('submit', saveSyncConfig);
  syncNowBtn.addEventListener('click', runSync);
  const printing = await window.api.printing.getConfig();
  await populatePrinterOptions();
  fieldKitchenAutoPrint.checked = printing.kitchenAutoPrint;
  fieldKitchenPrinterName.value = printing.kitchenPrinterName || '';
  fieldReceiptAutoPrint.checked = printing.receiptAutoPrint;
  fieldReceiptPrinterName.value = printing.receiptPrinterName || '';
  fieldKitchenPrinterMode.value = printing.kitchenPrinterMode || 'system';
  fieldKitchenPrinterIp.value = printing.kitchenPrinterIp || '';
  fieldKitchenPrinterPort.value = printing.kitchenPrinterPort || '9100';
  fieldKitchenPrinterPaperWidth.value = printing.kitchenPrinterPaperWidth || '80';
  fieldReceiptPrinterMode.value = printing.receiptPrinterMode || 'system';
  fieldReceiptPrinterIp.value = printing.receiptPrinterIp || '';
  fieldReceiptPrinterPort.value = printing.receiptPrinterPort || '9100';
  fieldReceiptPrinterPaperWidth.value = printing.receiptPrinterPaperWidth || '80';
  togglePrinterModeFields();
  printingForm.addEventListener('submit', savePrintingConfig);
  fieldKitchenPrinterMode.addEventListener('change', togglePrinterModeFields);
  fieldReceiptPrinterMode.addEventListener('change', togglePrinterModeFields);
  testKitchenNetworkPrinterBtn.addEventListener('click', () => testNetworkPrinter('kitchen'));
  testReceiptNetworkPrinterBtn.addEventListener('click', () => testNetworkPrinter('receipt'));
  loadAuditBtn.addEventListener('click', loadAuditLog);

  appCurrentVersion.textContent = await window.api.updates.currentVersion();
  fieldAutoCheckUpdates.checked = await window.api.updates.getAutoCheckEnabled();
  fieldAutoCheckUpdates.addEventListener('change', saveAutoCheckUpdates);
  checkUpdateBtn.addEventListener('click', checkForUpdate);
  downloadUpdateBtn.addEventListener('click', downloadUpdate);
  installUpdateBtn.addEventListener('click', () => window.api.updates.installNow());
  window.api.updates.onStatus(handleUpdateStatus);

  lanRoleTabs.querySelectorAll('.login-mode-tab').forEach((btn) => {
    btn.addEventListener('click', () => setLanRole(btn.dataset.role));
  });
  generatePairingCodeBtn.addEventListener('click', generatePairingCode);
  lanDisconnectBtn.addEventListener('click', disconnectLan);
  await loadLanStatus();
  lanStatusPollTimer = setInterval(loadLanStatus, 2000);
}

async function saveAutoCheckUpdates() {
  const enabled = fieldAutoCheckUpdates.checked;
  fieldAutoCheckUpdates.disabled = true;
  try {
    const result = await window.api.updates.setAutoCheckEnabled(enabled);
    if (!result?.success) throw new Error(result?.message || 'تعذر حفظ الإعداد.');
  } catch (err) {
    fieldAutoCheckUpdates.checked = !enabled;
    showToast(t('settings.toast.saveSettingFailed') + err.message, 'error');
  } finally {
    fieldAutoCheckUpdates.disabled = false;
  }
}

async function checkForUpdate() {
  checkUpdateBtn.disabled = true;
  updateStatus.textContent = 'جارٍ التحقق من وجود تحديث...';
  const result = await window.api.updates.check();
  if (!result.ok) {
    updateStatus.textContent = result.message;
    checkUpdateBtn.disabled = false;
  }
}

async function downloadUpdate() {
  downloadUpdateBtn.disabled = true;
  updateStatus.textContent = 'جارٍ تنزيل التحديث...';
  const result = await window.api.updates.download();
  if (!result.ok) {
    updateStatus.textContent = 'تعذر تنزيل التحديث: ' + result.message;
    downloadUpdateBtn.disabled = false;
  }
}

function handleUpdateStatus(data) {
  switch (data.status) {
    case 'checking':
      updateStatus.textContent = 'جارٍ التحقق من وجود تحديث...';
      break;
    case 'available':
      checkUpdateBtn.disabled = false;
      checkUpdateBtn.classList.add('hidden');
      downloadUpdateBtn.classList.remove('hidden');
      updateStatus.textContent = `${t('updates.newVersion','يتوفر إصدار جديد')} (${data.version}).`;
      break;
    case 'not-available':
      checkUpdateBtn.disabled = false;
      updateStatus.textContent = 'التطبيق محدّث لآخر إصدار.';
      break;
    case 'downloading':
      updateStatus.textContent = `${t('updates.downloading','جارٍ التنزيل...')} ${data.percent}%`;
      break;
    case 'downloaded':
      downloadUpdateBtn.classList.add('hidden');
      installUpdateBtn.classList.remove('hidden');
      updateStatus.textContent = `${t('updates.downloaded','تم تنزيل الإصدار') } ${data.version}. ${t('updates.installPrompt','اضغط للتثبيت وإعادة التشغيل.')}`;
      break;
    case 'error':
      checkUpdateBtn.disabled = false;
      downloadUpdateBtn.disabled = false;
      updateStatus.textContent = 'خطأ: ' + data.message;
      break;
  }
}

// يملأ قائمتي اختيار طابعة المطبخ والفواتير بالطابعات الفعلية المتصلة بالجهاز فقط
// (طابعات PDF الوهمية مستبعدة من القائمة أصلاً من جهة main.js). إذا كانت القيمة
// المحفوظة سابقاً لم تعد ضمن القائمة (طابعة أُزيلت مثلاً)، تُضاف كخيار إضافي موسوم
// بوضوح حتى لا تختفي القيمة المحفوظة صامتة دون أن ينتبه المستخدم.
async function populatePrinterOptions(savedKitchenName, savedReceiptName) {
  let printers = [];
  try { printers = await window.api.printing.listPrinters(); } catch (_) { printers = []; }
  const fillSelect = (select, savedName) => {
    while (select.options.length > 1) select.remove(1);
    for (const p of printers) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.isDefault ? `${p.displayName} (الافتراضية)` : p.displayName;
      select.appendChild(opt);
    }
    if (savedName && !printers.some((p) => p.name === savedName)) {
      const opt = document.createElement('option');
      opt.value = savedName;
      opt.textContent = `${savedName} (غير متوفرة حالياً)`;
      select.appendChild(opt);
    }
  };
  fillSelect(fieldKitchenPrinterName, savedKitchenName);
  fillSelect(fieldReceiptPrinterName, savedReceiptName);
}

// يُظهر/يُخفي حقول IP-المنفذ حسب الوضع المختار (نظام ويندوز أو شبكة مباشرة) لكل طابعة
function togglePrinterModeFields() {
  const kitchenNetwork = fieldKitchenPrinterMode.value === 'network';
  document.querySelectorAll('.kitchen-network-only').forEach((el) => el.classList.toggle('hidden', !kitchenNetwork));
  document.querySelectorAll('.kitchen-system-only').forEach((el) => el.classList.toggle('hidden', kitchenNetwork));
  const receiptNetwork = fieldReceiptPrinterMode.value === 'network';
  document.querySelectorAll('.receipt-network-only').forEach((el) => el.classList.toggle('hidden', !receiptNetwork));
  document.querySelectorAll('.receipt-system-only').forEach((el) => el.classList.toggle('hidden', receiptNetwork));
}

async function testNetworkPrinter(which) {
  const ip = (which === 'kitchen' ? fieldKitchenPrinterIp : fieldReceiptPrinterIp).value.trim();
  const port = (which === 'kitchen' ? fieldKitchenPrinterPort : fieldReceiptPrinterPort).value.trim() || '9100';
  const btn = which === 'kitchen' ? testKitchenNetworkPrinterBtn : testReceiptNetworkPrinterBtn;
  if (!ip) { showToast(t('settings.toast.enterPrinterIpFirst'), 'error'); return; }
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'جارٍ الاختبار...';
  try {
    await window.api.printing.testNetworkPrinter({ ip, port, dotsWidth: 576 });
    showToast(t('settings.toast.testReceiptSent'));
  } catch (err) {
    showToast(t('settings.toast.testFailed') + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function savePrintingConfig(event) {
  event.preventDefault();
  const btn = document.getElementById('savePrintingBtn'); btn.disabled = true;
  try {
    await window.api.printing.saveConfig({
      kitchenAutoPrint: fieldKitchenAutoPrint.checked, kitchenPrinterName: fieldKitchenPrinterName.value,
      receiptAutoPrint: fieldReceiptAutoPrint.checked, receiptPrinterName: fieldReceiptPrinterName.value,
      kitchenPrinterMode: fieldKitchenPrinterMode.value, kitchenPrinterIp: fieldKitchenPrinterIp.value, kitchenPrinterPort: fieldKitchenPrinterPort.value,
      receiptPrinterMode: fieldReceiptPrinterMode.value, receiptPrinterIp: fieldReceiptPrinterIp.value, receiptPrinterPort: fieldReceiptPrinterPort.value, receiptPrinterPaperWidth: fieldReceiptPrinterPaperWidth.value,
      kitchenPrinterPaperWidth: fieldKitchenPrinterPaperWidth.value,
    });
    showToast(t('settings.toast.autoPrintSaved'));
  } catch (err) { showToast(t('settings.toast.savePrintFailed') + err.message, 'error'); }
  finally { btn.disabled = false; }
}

async function loadAuditLog() {
  loadAuditBtn.disabled = true;
  try {
    const logs = await window.api.audit.list();
    // created_at مخزّن UTC؛ نحوّله لتوقيت الجهاز المحلي بدل عرضه خاماً كما هو مخزّن
    // (نفس الملاحظة المطبّقة على صفحة سجل التدقيق الكاملة).
    const fmt = (raw) => {
      const d = new Date(String(raw || '').replace(' ', 'T') + 'Z');
      return Number.isNaN(d.getTime()) ? raw : d.toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'medium' });
    };
    auditLogList.textContent = logs.length ? logs.map(l => `${fmt(l.created_at)} | ${l.level.toUpperCase()} | ${l.user_name || 'النظام'} | ${l.action}${l.details ? ' | ' + l.details : ''}`).join('\n') : 'لا توجد عمليات مسجلة بعد.';
  } catch (err) { auditLogList.textContent = 'تعذر تحميل السجل: ' + err.message; }
  finally { loadAuditBtn.disabled = false; }
}

async function saveGlobalProfile(event) {
  event.preventDefault();
  const btn = document.getElementById('saveGlobalBtn'); btn.disabled = true;
  try {
    await window.api.global.set({
      countryCode: fieldCountryCode.value, locale: fieldLocale.value, timezone: fieldTimezone.value,
      currencyCode: fieldGlobalCurrency.value, currencyMinorUnit: parseLocaleNumber(fieldMinorUnit.value),
      taxMode: fieldTaxMode.value, taxRegistrationNumber: fieldGlobalTaxNumber.value,
      fiscalizationMode: fieldFiscalizationMode.value, fiscalProvider: fieldFiscalProvider.value,
    });
    showToast(t('settings.toast.localeSaved'));
  } catch (e) { showToast(t('settings.toast.saveFailedShort') + ts(e.message), 'error'); }
  finally { btn.disabled = false; }
}

async function saveCurrency(event) {
  event.preventDefault();
  const button = document.getElementById('saveCurrencyBtn');
  button.disabled = true;
  try {
    await window.api.currency.set({ base: fieldCurrencyBase.value, secondary: fieldCurrencySecondary.value, showSecondaryOnReceipt: fieldShowSecondaryOnReceipt.checked, rate: parseLocaleNumber(fieldExchangeRate.value), taxNumber: fieldTaxNumber.value });
    showToast(t('settings.toast.currencyInvoiceSaved'));
  } catch (error) { showToast(t('settings.toast.saveFailedShort') + error.message, 'error'); }
  finally { button.disabled = false; }
}

async function saveSyncConfig(event) {
  event.preventDefault();
  try {
    await window.api.sync.saveConfig({ serverUrl: fieldSyncServerUrl.value, token: fieldSyncToken.value, enabled: fieldSyncEnabled.checked });
    syncStatus.textContent = 'تم حفظ إعدادات المزامنة.';
  } catch (error) { syncStatus.textContent = 'تعذر الحفظ: ' + error.message; }
}
async function runSync() {
  syncNowBtn.disabled = true; syncStatus.textContent = 'جارٍ الاتصال بالسيرفر...';
  try {
    const result = await window.api.sync.run();
    syncStatus.textContent = result.success ? `${t('sync.completed','اكتملت المزامنة')}: ${t('sync.pushed','أُرسل')} ${result.pushed} ${t('sync.pulled','وسُحب')} ${result.pulled} ${t('sync.records','سجل')}.` : result.message;
  } catch (error) { syncStatus.textContent = 'تعذرت المزامنة: ' + error.message; }
  finally { syncNowBtn.disabled = false; }
}

async function saveBranding(e) {
  e.preventDefault();
  const btn = document.getElementById('saveBrandingBtn');
  btn.disabled = true;
  btn.textContent = 'جارٍ الحفظ...';
  try {
    await window.api.branding.setStoreName(fieldStoreName.value.trim());
    await window.api.branding.setReceiptFooterMessage(fieldReceiptFooter.value.trim());
    showToast(t('settings.toast.storeNameSaved'));
  } catch (err) {
    showToast(t('settings.toast.saveErrorGeneric') + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'حفظ اسم المتجر';
  }
}

async function selectLogo() {
  selectLogoBtn.disabled = true;
  try {
    const result = await window.api.branding.setLogo();
    if (result && result.success) {
      logoPreview.src = result.url;
      logoPreview.style.display = 'inline-block';
    }
  } catch (err) {
    showToast(t('settings.toast.logoSelectError') + err.message, 'error');
  } finally {
    selectLogoBtn.disabled = false;
  }
}

async function saveDiscountLimit(e) {
  e.preventDefault();
  const btn = document.getElementById('saveDiscountBtn');
  btn.disabled = true;
  btn.textContent = 'جارٍ الحفظ...';
  try {
    await window.api.discount.setMaxCashierPercent(parseLocaleNumber(fieldMaxDiscountPercent.value) || 0);
    showToast(t('settings.toast.discountLimitSaved'));
  } catch (err) {
    showToast(t('settings.toast.saveErrorGeneric') + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'حفظ حد الخصم';
  }
}

const PLACEHOLDER_IMG =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#f0f0f0"/><text x="32" y="38" font-size="24" text-anchor="middle" fill="#c1c5cb">🛒</text></svg>`
  );

async function renderOffersImageCard() {
  const holder = document.getElementById('offersImageCard');
  if (!holder) return;
  let imagePath = null;
  try { imagePath = (await window.api.pos.offersCategoryImage()).imagePath || null; } catch { imagePath = null; }
  holder.innerHTML = `
    <div class="category-image-card" data-offers="1">
      <img src="${escAttr(imagePath || PLACEHOLDER_IMG)}" alt="" class="thumb" />
      <div class="category-image-name">${t('settings.categoryImages.offersTabName')}</div>
      <button type="button" class="btn btn-secondary btn-sm" id="pickOffersImageBtn">${imagePath ? t('settings.categoryImages.changeImage') : t('settings.categoryImages.chooseImage')}</button>
      ${imagePath ? `<button type="button" class="btn btn-danger btn-sm" id="removeOffersImageBtn">${t('settings.categoryImages.removeImage')}</button>` : ''}
    </div>
  `;
  document.getElementById('pickOffersImageBtn')?.addEventListener('click', async () => {
    const result = await window.api.dialog.selectImage();
    if (!result) return;
    try {
      await window.api.pos.offersCategoryImage({ save: result.url });
      renderOffersImageCard();
    } catch (err) { showToast(t('settings.categoryImages.saveOffersImageFailed') + err.message, 'error'); }
  });
  document.getElementById('removeOffersImageBtn')?.addEventListener('click', async () => {
    if (!(await confirmDialog(t('settings.categoryImages.confirmRemoveOffersImage'), { tone: 'danger', confirmLabel: t('common.delete', 'حذف') }))) return;
    try {
      await window.api.pos.offersCategoryImage({ save: null });
      showToast(t('settings.categoryImages.offersImageRemoved'));
      renderOffersImageCard();
    } catch (err) { showToast(t('settings.categoryImages.removeImageFailed') + err.message, 'error'); }
  });
}

async function renderCategoryImagesPanel() {
  const list = document.getElementById('categoryImagesList');
  const categories = await window.api.categories.list();
  list.innerHTML = categories.map((c, idx) => `
    <div class="category-image-card ${c.pos_hidden ? 'is-hidden-cat' : ''}" data-id="${c.id}">
      <img src="${escAttr(c.image_path || PLACEHOLDER_IMG)}" alt="" class="thumb" />
      <div class="category-image-name">${escapeHtml(c.name)}${c.pos_hidden ? ` <span class="hidden-cat-badge">${t('settings.categoryImages.hiddenBadge')}</span>` : ''}</div>
      <div class="category-order-row">
        <button type="button" class="btn btn-secondary btn-sm" data-move="up" data-id="${c.id}" ${idx === 0 ? 'disabled' : ''}>▲</button>
        <button type="button" class="btn btn-secondary btn-sm" data-move="down" data-id="${c.id}" ${idx === categories.length - 1 ? 'disabled' : ''}>▼</button>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" data-pick-cat="${c.id}">${c.image_path ? t('settings.categoryImages.changeImage') : t('settings.categoryImages.chooseImage')}</button>
      ${c.image_path ? `<button type="button" class="btn btn-danger btn-sm" data-remove-cat="${c.id}">${t('settings.categoryImages.removeImage')}</button>` : ''}
      <button type="button" class="btn ${c.pos_hidden ? 'btn-primary' : 'btn-secondary'} btn-sm" data-toggle-hidden="${c.id}" data-hidden="${c.pos_hidden ? '1' : '0'}">${c.pos_hidden ? t('settings.categoryImages.showInPos') : t('settings.categoryImages.hideFromPos')}</button>
    </div>
  `).join('') || `<div class="field-hint">${t('settings.categoryImages.noCategoriesYet')}</div>`;

  list.querySelectorAll('[data-toggle-hidden]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const categoryId = parseInt(btn.dataset.toggleHidden, 10);
      const nextHidden = btn.dataset.hidden !== '1';
      try {
        await window.api.categories.setPosHidden(categoryId, nextHidden);
        showToast(nextHidden ? t('settings.categoryImages.categoryHidden') : t('settings.categoryImages.categoryShown'));
        renderCategoryImagesPanel();
      } catch (err) { showToast(t('settings.categoryImages.toggleHiddenFailed') + err.message, 'error'); }
    });
  });

  list.querySelectorAll('[data-pick-cat]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const categoryId = parseInt(btn.dataset.pickCat, 10);
      const result = await window.api.dialog.selectImage();
      if (!result) return;
      try {
        await window.api.categories.setImage(categoryId, result.url);
        renderCategoryImagesPanel();
      } catch (err) { showToast(t('settings.categoryImages.saveCategoryImageFailed') + err.message, 'error'); }
    });
  });
  list.querySelectorAll('[data-remove-cat]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const categoryId = parseInt(btn.dataset.removeCat, 10);
      const card = btn.closest('.category-image-card');
      const categoryName = card?.querySelector('.category-image-name')?.textContent || '';
      if (!(await confirmDialog(tf('settings.categoryImages.confirmRemoveCategoryImage', { name: categoryName }), { tone: 'danger', confirmLabel: t('common.delete', 'حذف') }))) return;
      try {
        await window.api.categories.setImage(categoryId, null);
        showToast(t('settings.categoryImages.categoryImageRemoved'));
        renderCategoryImagesPanel();
      } catch (err) { showToast(t('settings.categoryImages.removeCategoryImageFailed') + err.message, 'error'); }
    });
  });
  list.querySelectorAll('[data-move]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const categoryId = parseInt(btn.dataset.id, 10);
      try {
        await window.api.categories.move(categoryId, btn.dataset.move);
        renderCategoryImagesPanel();
      } catch (err) { showToast('تعذّر تغيير الترتيب: ' + err.message, 'error'); }
    });
  });
}

async function saveReceiptBarcodeEnabled() {
  try {
    await window.api.receipt.barcodeEnabled({ save: fieldReceiptBarcodeEnabled.checked });
    showToast(fieldReceiptBarcodeEnabled.checked ? 'تم تفعيل رمز QR على الفاتورة.' : 'تم إلغاء رمز QR من الفاتورة.');
  } catch (err) {
    showToast(t('settings.toast.saveErrorGeneric') + err.message, 'error');
    fieldReceiptBarcodeEnabled.checked = !fieldReceiptBarcodeEnabled.checked;
  }
}

async function saveQuickCashierEnabled() {
  try {
    await window.api.posMode.quickCashierEnabled({ save: fieldQuickCashierEnabled.checked });
    showToast(fieldQuickCashierEnabled.checked ? 'تم تفعيل الكاشير السريع.' : 'تم إخفاء الكاشير السريع.');
    document.querySelectorAll('[data-setting="quickCashier"]').forEach((el) => { el.style.display = fieldQuickCashierEnabled.checked ? '' : 'none'; });
  } catch (err) {
    showToast(t('settings.toast.saveErrorGeneric') + err.message, 'error');
    fieldQuickCashierEnabled.checked = !fieldQuickCashierEnabled.checked;
  }
}

async function saveOffersCategoryEnabled() {
  try {
    await window.api.pos.offersCategoryEnabled({ save: fieldOffersCategoryEnabled.checked });
    showToast(fieldOffersCategoryEnabled.checked ? 'سيظهر تبويب العروض في الكاشير.' : 'تم إخفاء تبويب العروض من الكاشير.');
  } catch (err) {
    showToast(t('settings.toast.saveErrorGeneric') + err.message, 'error');
    fieldOffersCategoryEnabled.checked = !fieldOffersCategoryEnabled.checked;
  }
}

async function saveTaxDefaultRate(e) {
  e.preventDefault();
  const btn = document.getElementById('saveTaxDefaultBtn');
  btn.disabled = true;
  try {
    await window.api.tax.defaultRate({ save: parseLocaleNumber(fieldTaxDefaultRate.value) || 0 });
    showToast(t('settings.tax.saved', 'تم حفظ نسبة الضريبة الافتراضية.'));
  } catch (err) {
    showToast(t('settings.toast.saveErrorGeneric') + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function saveLoyaltySettings(e) {
  e.preventDefault();
  const btn = document.getElementById('saveLoyaltyBtn');
  btn.disabled = true;
  btn.textContent = 'جارٍ الحفظ...';
  try {
    const r = await window.api.loyalty.settings({
      save: true,
      earnPerCurrencyUnit: parseLocaleNumber(fieldLoyaltyEarnRate.value) || 0,
      redeemPointsPerCurrencyUnit: parseLocaleNumber(fieldLoyaltyRedeemRate.value) || 0,
    });
    if (!r?.success) throw new Error(r?.message || 'تعذر حفظ إعدادات الولاء');
    showToast(t('settings.toast.loyaltySaved'));
  } catch (err) {
    showToast(t('settings.toast.saveErrorGeneric') + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'حفظ إعدادات الولاء';
  }
}

async function saveDeliveryPricing(e) {
  e.preventDefault();
  const btn = document.getElementById('saveDeliveryPricingBtn');
  btn.disabled = true;
  btn.textContent = 'جارٍ الحفظ...';
  try {
    await window.api.delivery.setPricing(parseLocaleNumber(fieldDeliveryDefaultFee.value) || 0, parseLocaleNumber(fieldDeliveryPricePerKm.value) || 0);
    showToast(t('settings.toast.deliveryPricingSaved'));
  } catch (err) {
    showToast(t('settings.toast.saveErrorGeneric') + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'حفظ تسعير التوصيل';
  }
}

async function saveWeighingPrefix(e) {
  e.preventDefault();
  const btn = document.getElementById('saveWeighingBtn');
  btn.disabled = true;
  btn.textContent = 'جارٍ الحفظ...';
  try {
    await window.api.weighing.setPrefix(fieldWeightedPrefix.value.trim());
    showToast(t('settings.toast.weighingSaved'));
  } catch (err) {
    showToast(t('settings.toast.saveErrorGeneric') + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'حفظ';
  }
}

// يعرض تاريخ آخر نسخة احتياطية تلقائية (تعمل يومياً في الخلفية بلا أي تدخل)
// حتى يطمئن صاحب المحل أن بياناته محمية فعلاً لا مجرد إعداد نظري.
async function loadAutoBackupStatus() {
  try {
    const status = await window.api.backup.autoStatus();
    if (status.lastDate) {
      autoBackupStatus.textContent = `✓ آخر نسخة احتياطية تلقائية: ${status.lastDate} (يُحتفظ بآخر ${status.retentionDays} يوماً)`;
      autoBackupStatus.style.color = 'var(--success, #16a34a)';
    } else {
      autoBackupStatus.textContent = 'لم تُنشأ أي نسخة احتياطية تلقائية بعد (ستُنشأ أول نسخة تلقائياً قريباً).';
      autoBackupStatus.style.color = 'var(--text-faint)';
    }
  } catch (_) { /* لا نزعج المستخدم لو فشل هذا العرض التوضيحي فقط */ }
}

async function createBackup() {
  createBackupBtn.disabled = true;
  backupStatus.textContent = 'جارٍ إنشاء النسخة الاحتياطية...';
  try {
    const result = await window.api.backup.create();
    if (result.canceled) {
      backupStatus.textContent = '';
    } else if (result.success) {
      backupStatus.textContent = `${t('backup.created','تم إنشاء النسخة الاحتياطية')}: ${result.path}`;
    } else {
      backupStatus.textContent = 'تعذّر إنشاء النسخة الاحتياطية.';
    }
  } catch (err) {
    backupStatus.textContent = ts('حدث خطأ: ') + err.message;
  } finally {
    createBackupBtn.disabled = false;
  }
}

async function restoreBackup() {
  restoreBackupBtn.disabled = true;
  backupStatus.textContent = 'في انتظار اختيار الملف...';
  try {
    const result = await window.api.backup.restore();
    if (result.canceled) {
      backupStatus.textContent = '';
    } else if (!result.success) {
      backupStatus.textContent = 'تعذّرت الاستعادة.';
    }
    // في حال النجاح، سيُغلق التطبيق نفسه (تُدار العملية من main.js)
  } catch (err) {
    backupStatus.textContent = ts('حدث خطأ: ') + err.message;
  } finally {
    restoreBackupBtn.disabled = false;
  }
}

// النسخة المحمولة تستخدم كلمة مرور يختارها المستخدم بدل مفتاح الجهاز، فتصلح
// للاستعادة على أي جهاز آخر (بعكس الزرين أعلاه المرتبطين بمفتاح هذا الجهاز تحديداً).
let portableBackupMode = 'create';

function openPortableBackupModal(mode) {
  portableBackupMode = mode;
  portableBackupForm.reset();
  portableBackupError.classList.add('hidden');
  if (mode === 'create') {
    portableBackupTitle.textContent = 'إنشاء نسخة محمولة';
    portableBackupHint.textContent = 'اختر كلمة مرور لا تقل عن 12 محرفاً واحفظها في مكان آمن — بدونها لن تستطيع استعادة هذه النسخة لاحقاً.';
    portableBackupConfirmField.classList.remove('hidden');
    portableBackupConfirm.required = true;
  } else {
    portableBackupTitle.textContent = 'استعادة نسخة محمولة';
    portableBackupHint.textContent = 'أدخل كلمة المرور التي استُخدمت عند إنشاء هذه النسخة المحمولة.';
    portableBackupConfirmField.classList.add('hidden');
    portableBackupConfirm.required = false;
  }
  portableBackupModal.classList.remove('hidden');
  portableBackupPassphrase.focus();
}

function closePortableBackupModal() {
  portableBackupModal.classList.add('hidden');
  portableBackupForm.reset();
  portableBackupError.classList.add('hidden');
}

async function submitPortableBackup(e) {
  e.preventDefault();
  const passphrase = portableBackupPassphrase.value;
  if (portableBackupMode === 'create' && passphrase !== portableBackupConfirm.value) {
    portableBackupError.textContent = 'كلمتا المرور غير متطابقتين.';
    portableBackupError.classList.remove('hidden');
    return;
  }
  portableBackupSubmit.disabled = true;
  portableBackupError.classList.add('hidden');
  try {
    if (portableBackupMode === 'create') {
      const result = await window.api.backup.createPortable(passphrase);
      if (result.canceled) {
        closePortableBackupModal();
        return;
      }
      if (result.success) {
        closePortableBackupModal();
        portableBackupStatus.textContent = `${ts('تم إنشاء النسخة المحمولة: ')}${result.path}`;
      } else {
        portableBackupError.textContent = ts('تعذّر إنشاء النسخة المحمولة.');
        portableBackupError.classList.remove('hidden');
      }
    } else {
      const result = await window.api.backup.restorePortable(passphrase);
      if (result.canceled) {
        closePortableBackupModal();
        return;
      }
      if (!result.success) {
        portableBackupError.textContent = result.message || ts('تعذّرت الاستعادة.');
        portableBackupError.classList.remove('hidden');
      }
      // في حال النجاح، سيُعاد تشغيل التطبيق نفسه (تُدار العملية من main.js)
    }
  } catch (err) {
    portableBackupError.textContent = ts('حدث خطأ: ') + err.message;
    portableBackupError.classList.remove('hidden');
  } finally {
    portableBackupSubmit.disabled = false;
  }
}

async function save(e) {
  e.preventDefault();
  const btn = document.getElementById('saveSettingsBtn');
  btn.disabled = true;
  btn.textContent = 'جارٍ الحفظ...';
  try {
    await window.api.branches.update({
      id: currentBranch.id,
      name: fieldBranchName.value.trim(),
      businessType: fieldBusinessType.value,
    });
    showToast(t('settings.toast.settingsSaved'));
  } catch (err) {
    showToast(t('settings.toast.saveErrorGeneric') + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'حفظ الإعدادات';
  }
}

/* ---------------- مشاركة بين كاشيرات نفس المحل (LAN) ---------------- */
async function loadLanStatus() {
  let status;
  try {
    status = await window.api.lan.getStatus();
  } catch {
    return;
  }

  lanRoleTabs.querySelectorAll('.login-mode-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.role === status.role);
  });
  lanMainPanel.classList.toggle('hidden', status.role !== 'main');
  lanTerminalPanel.classList.toggle('hidden', status.role !== 'terminal');

  if (status.role === 'main') {
    if (document.activeElement !== fieldLanDeviceName) fieldLanDeviceName.value = status.deviceName || '';
    if (status.pairingCode && status.pairingExpiresAt > Date.now()) {
      pairingCodeBox.classList.remove('hidden');
      pairingCodeDisplay.textContent = status.pairingCode;
      const waiterHost = (status.localAddresses && status.localAddresses[0]) || 'localhost';
      document.getElementById('waiterUrlDisplay').textContent = status.serverPort ? `https://${waiterHost}:${status.serverPort}/waiter` : '';
      const secondsLeft = Math.max(0, Math.round((status.pairingExpiresAt - Date.now()) / 1000));
      pairingCodeExpiry.textContent = `${ts('صالح لمدة')} ${Math.ceil(secondsLeft / 60)} ${ts('دقيقة تقريباً')}`;
    } else {
      pairingCodeBox.classList.add('hidden');
    }
  }

  if (status.role === 'terminal') {
    const connected = !!status.connectedTo;
    lanConnectedBox.classList.toggle('hidden', !connected);
    lanDiscoveryBox.classList.toggle('hidden', connected);
    if (connected) {
      lanConnectedInfo.textContent = `${t('lan.connectedToStore','متصل بمحل')}: ${status.branchName} — ${status.connectedTo}`;
    } else {
      renderDiscoveredDevices(status.discoveredDevices || []);
    }
  }
}

function renderDiscoveredDevices(devices) {
  if (devices.length === 0) {
    lanDevicesList.innerHTML = 'جارٍ البحث عن أجهزة رئيسية على الشبكة... تأكد أن الجهاز الرئيسي مفتوح وبنفس شبكة الواي فاي.';
    return;
  }
  lanDevicesList.innerHTML = devices
    .map(
      (d, i) => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:6px">
        <span>${escapeHtml(d.name)} (${escapeHtml(d.address)})</span>
        <button type="button" class="btn btn-primary btn-sm" data-connect-index="${i}">اتصال</button>
      </div>`
    )
    .join('');
  lanDevicesList.querySelectorAll('[data-connect-index]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const device = devices[Number(btn.dataset.connectIndex)];
      connectToDevice(device);
    });
  });
}

async function setLanRole(role) {
  if (role === 'terminal') {
    const current = await window.api.lan.getStatus();
    if (current.role !== 'terminal' && !(await confirmDialog(t('lan.pairConfirm','سيتحوّل هذا الجهاز إلى طرفية تابعة لمحل آخر، وتُستبدل هويته الحالية عند الاقتران. تأكيد؟'), { tone: 'warning' }))) return;
  }
  try {
    await window.api.lan.setRole(role, fieldLanDeviceName.value.trim());
    await loadLanStatus();
  } catch (err) {
    showToast(ts('حدث خطأ: ') + err.message, 'error');
  }
}

async function generatePairingCode() {
  generatePairingCodeBtn.disabled = true;
  try {
    if (fieldLanDeviceName.value.trim()) {
      await window.api.lan.setRole('main', fieldLanDeviceName.value.trim());
    }
    await window.api.lan.startPairingCode();
    await loadLanStatus();
  } catch (err) {
    showToast(ts('حدث خطأ: ') + err.message, 'error');
  } finally {
    generatePairingCodeBtn.disabled = false;
  }
}

async function connectToDevice(device) {
  const code = await promptDialog(`${t('lan.enterPairingCode','أدخل رمز الاقتران المعروض على شاشة')} "${device.name}":`, '');
  if (!code) return;
  try {
    const result = await window.api.lan.pairWithDevice(device.address, device.port, code.trim());
    showToast(`تم الاتصال بنجاح بمحل "${result.branchName}"`);
    await loadLanStatus();
  } catch (err) {
    showToast(t('settings.toast.connectionFailed') + err.message, 'error');
  }
}

async function disconnectLan() {
  if (!(await confirmDialog(t('lan.disconnectConfirm','فصل هذا الجهاز عن مشاركة المحل؟ سيصبح يعمل ببياناته المحلية فقط من الآن.'), { tone: 'warning' }))) return;
  try {
    await window.api.lan.disconnect();
    await loadLanStatus();
  } catch (err) {
    showToast(ts('حدث خطأ: ') + err.message, 'error');
  }
}

init();
