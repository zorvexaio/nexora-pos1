const loginForm = document.getElementById('loginForm');
const usernameInput = document.getElementById('usernameInput');
const passwordInput = document.getElementById('passwordInput');
const loginError = document.getElementById('loginError');
const loginBtn = document.getElementById('loginBtn');

const passwordModeBtn = document.getElementById('passwordModeBtn');
const pinModeBtn = document.getElementById('pinModeBtn');
const pinPad = document.getElementById('pinPad');
const pinDisplay = document.getElementById('pinDisplay');
const pinError = document.getElementById('pinError');

let pinValue = '';
const PIN_MAX_LENGTH = 6;

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.classList.add('hidden');
  loginBtn.disabled = true;
  loginBtn.textContent = t('login.loggingIn');

  try {
    const result = await window.api.auth.login({
      username: usernameInput.value.trim(),
      password: passwordInput.value,
    });
    if (!result.success) {
      loginError.textContent = result.message || t('login.failed');
      loginError.classList.remove('hidden');
    }
    // عند النجاح: العملية الرئيسية تفتح النافذة الرئيسية وتُغلق هذه النافذة تلقائياً
  } catch (err) {
    loginError.textContent = t('login.unexpectedError') + err.message;
    loginError.classList.remove('hidden');
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = t('login.submit');
  }
});

/* ---------------- تبديل بين وضع كلمة المرور ووضع PIN ---------------- */
passwordModeBtn.addEventListener('click', () => setMode('password'));
pinModeBtn.addEventListener('click', () => setMode('pin'));

function setMode(mode) {
  const isPin = mode === 'pin';
  pinModeBtn.classList.toggle('active', isPin);
  passwordModeBtn.classList.toggle('active', !isPin);
  pinPad.classList.toggle('hidden', !isPin);
  loginForm.classList.toggle('hidden', isPin);
  loginError.classList.add('hidden');
  pinError.classList.add('hidden');
  resetPin();
}

/* ---------------- لوحة أرقام PIN ---------------- */
document.querySelectorAll('.pin-key[data-digit]').forEach((btn) => {
  btn.addEventListener('click', () => addPinDigit(btn.dataset.digit));
});
document.getElementById('pinClearBtn').addEventListener('click', resetPin);
document.getElementById('pinBackspaceBtn').addEventListener('click', () => {
  pinValue = pinValue.slice(0, -1);
  renderPinDisplay();
});

// دعم لوحة المفاتيح الفعلية أيضاً (بعض الأجهزة موصولة بلوحة مفاتيح رقمية بدل شاشة لمس)
document.addEventListener('keydown', (e) => {
  if (pinPad.classList.contains('hidden')) return;
  if (/^[0-9]$/.test(e.key)) addPinDigit(e.key);
  else if (e.key === 'Backspace') { pinValue = pinValue.slice(0, -1); renderPinDisplay(); }
  else if (e.key === 'Escape') resetPin();
});

function addPinDigit(digit) {
  if (pinValue.length >= PIN_MAX_LENGTH) return;
  pinValue += digit;
  renderPinDisplay();
  if (pinValue.length >= 4) submitPin();
}

function resetPin() {
  pinValue = '';
  renderPinDisplay();
}

function renderPinDisplay() {
  const dots = pinValue.split('').map(() => '●').join(' ');
  const placeholders = '— '.repeat(Math.max(0, 4 - pinValue.length)).trim();
  pinDisplay.textContent = [dots, placeholders].filter(Boolean).join(' ');
}

async function submitPin() {
  pinError.classList.add('hidden');
  document.querySelectorAll('.pin-key').forEach((b) => (b.disabled = true));
  try {
    const result = await window.api.auth.loginWithPin(pinValue);
    if (!result.success) {
      pinError.textContent = result.message || 'رقم PIN غير صحيح';
      pinError.classList.remove('hidden');
      resetPin();
    }
    // عند النجاح: العملية الرئيسية تفتح النافذة الرئيسية وتُغلق هذه النافذة تلقائياً
  } catch (err) {
    pinError.textContent = 'حدث خطأ أثناء التحقق: ' + err.message;
    pinError.classList.remove('hidden');
    resetPin();
  } finally {
    document.querySelectorAll('.pin-key').forEach((b) => (b.disabled = false));
  }
}

(async function showBootstrapInfo(){
  try {
    const info = await window.api.auth.bootstrapInfo();
    if (info?.username && info?.temporaryPassword) {
      const box = document.getElementById('bootstrapInfo');
      box.textContent = `${t('setup.adminCredentials', 'حساب المدير الأول')}: ${info.username} — ${t('setup.tempPassword', 'كلمة المرور المؤقتة')}: ${info.temporaryPassword}`;
      box.classList.remove('hidden');
    }
  } catch (_) {}
})();

// شاشة splash تعرض اسم/شعار المتجر (إن وُجدا) قبل هذه الشاشة مباشرة — بدون هذا، كانت
// شاشة الدخول ترجع فجأة للاسم العام "نظام نقاط البيع" بلا شعار، فتنقطع الهوية البصرية
// للمتجر بين splash والدخول ثم تعود بالداخل (common.js يطبّقها على شريط التطبيق).
// نفس منطق splash.js/common.js بالضبط، بلا أي اعتماد على common.js نفسه.
(async function applyLoginBranding() {
  try {
    if (!window.api || !window.api.branding) return;
    const branding = await window.api.branding.get();
    if (branding && branding.storeName) {
      document.getElementById('loginBrandTitle').textContent = branding.storeName;
    }
    if (branding && branding.logoPath) {
      const mark = document.getElementById('loginBrandMark');
      const img = document.createElement('img');
      img.className = 'brand-logo';
      img.alt = '';
      img.src = window.api.pathToFileURL(branding.logoPath);
      mark.replaceWith(img);
    }
  } catch (_) {
    // لا مشكلة إن فشل — تبقى العلامة الافتراضية
  }
})();
