const fingerprintInput = document.getElementById('fingerprintInput');
const copyFingerprintBtn = document.getElementById('copyFingerprintBtn');
const statusReason = document.getElementById('statusReason');
const licenseForm = document.getElementById('licenseForm');
const licenseFileInput = document.getElementById('licenseFileInput');
const licenseError = document.getElementById('licenseError');
const activateBtn = document.getElementById('activateBtn');

const REASON_KEYS = {
  no_license_file: 'license.reason.no_license_file',
  corrupt_file: 'license.reason.corrupt_file',
  invalid_signature: 'license.reason.invalid_signature',
  fingerprint_mismatch: 'license.reason.fingerprint_mismatch',
  expired: 'license.reason.expired',
  malformed_license: 'license.reason.malformed_license',
  revoked: 'license.reason.revoked',
};

async function init() {
  let lang = 'ar';
  try {
    if (window.api && window.api.language) lang = (await window.api.language.get()) || 'ar';
  } catch (err) {
    // نستمر باللغة الافتراضية إن تعذّر القراءة (مثلاً قبل تجهيز قاعدة البيانات)
  }
  applyTranslations(lang);

  const fp = await window.api.license.deviceFingerprint();
  fingerprintInput.value = fp;

  const status = await window.api.license.status();
  if (!status.valid && status.reason && REASON_KEYS[status.reason]) {
    statusReason.textContent = t(REASON_KEYS[status.reason]);
    statusReason.classList.remove('hidden');
  }
}

copyFingerprintBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(fingerprintInput.value);
  copyFingerprintBtn.textContent = t('license.copied');
  setTimeout(() => (copyFingerprintBtn.textContent = t('license.copyBtn')), 1500);
});

licenseForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  licenseError.classList.add('hidden');
  const file = licenseFileInput.files[0];
  if (!file) return;

  activateBtn.disabled = true;
  activateBtn.textContent = t('license.activating');
  try {
    const content = await file.text();
    const result = await window.api.license.activate(content);
    if (!result.success) {
      licenseError.textContent = result.message || t('license.defaultActivateError');
      licenseError.classList.remove('hidden');
    }
    // عند النجاح: العملية الرئيسية تفتح شاشة تسجيل الدخول وتُغلق هذه النافذة تلقائياً
  } catch (err) {
    licenseError.textContent = t('license.unexpectedError') + ': ' + err.message;
    licenseError.classList.remove('hidden');
  } finally {
    activateBtn.disabled = false;
    activateBtn.textContent = t('license.activateBtn');
  }
});

init();
