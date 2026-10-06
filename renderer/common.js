// common.js — يُحمَّل قبل سكربت كل صفحة (index.html وصفحات pages/)
// يوفر: التحقق من الصلاحية قبل عرض الصفحة، وتعبئة شريط المستخدم وزر الخروج

// تعقيم أي نص قبل حقنه بـ innerHTML (يمنع XSS من بيانات مخزّنة كأسماء عملاء/منتجات).
// دوال هذا الملف (showToast وrenderEmptyState وrenderLoadingState) تستخدمها مباشرة،
// لذلك لازم تكون معرّفة هنا نفسه بدل الاعتماد على أن كل صفحة تعرّف نسختها الخاصة —
// شاشات مثل المشتريات والرواتب وجلسة الصندوق لم تكن تعرّفها محلياً، فكان أي استدعاء
// لـ showToast فيها يفشل بخطأ "escapeHtml is not defined" (راجع سجل التدقيق: أخطاء
// renderer_rejection المتكررة). لو صفحة مُعيّنة عندها نسختها الخاصة، إعادة التعريف
// هنا غير ضارة — تعريفات الدوال بنفس النطاق لا تتعارض بجافاسكربت.
// يطابق حساب الباك-إند (core/money.js): تقريب لكل سطر بالوحدة الصغرى، وضريبة شاملة = gross × rate ÷ (100 + rate).
// يُستخدم في معاينة السلة/تعديل الفاتورة حتى لا يختلف إجمالي الشاشة عن الفاتورة المحفوظة بوحدة صغرى.
function computeCartLineTax(price, quantity, ratePercent, inclusive, minorUnit = 2) {
  const unit = Number.isInteger(minorUnit) && minorUnit >= 0 && minorUnit <= 3 ? minorUnit : 2;
  const scale = 10 ** unit;
  const unitMinor = Math.round(Number((Number(price || 0) * scale).toFixed(6)));
  const grossMinor = Math.max(0, Math.round(Number((unitMinor * Number(quantity || 0)).toFixed(6))));
  const bps = Math.max(0, Math.round((Number(ratePercent) || 0) * 100));
  const den = inclusive ? 10000 + bps : 10000;
  const taxMinor = bps > 0 ? Math.floor((grossMinor * bps * 2 + den) / (2 * den)) : 0;
  const netMinor = inclusive ? Math.max(0, grossMinor - taxMinor) : grossMinor;
  return { grossMinor, taxMinor, netMinor, scale };
}
function sumCartTax(lines, minorUnit = 2) {
  const parts = lines.map((i) => computeCartLineTax(i.price, i.quantity, i.taxRate, !!i.taxInclusive, minorUnit));
  const scale = parts.length ? parts[0].scale : 10 ** (Number.isInteger(minorUnit) ? minorUnit : 2);
  return {
    subtotal: parts.reduce((n, p) => n + p.netMinor, 0) / scale,
    tax: parts.reduce((n, p) => n + p.taxMinor, 0) / scale,
  };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// escapeHtml() يضمن الأمان داخل عقدة نص فقط (بين وسمين). لا يضمن الأمان داخل قيمة attribute
// (مثل src="${...}") لأنه لا يهرّب علامة الاقتباس نفسها ("). استخدم هذي الدالة تحديداً كل ما
// كانت القيمة الهاربة موضوعة داخل attribute بقالب HTML string، حتى لو المصدر يبدو موثوقاً
// حالياً (مسار ملف من النظام، معرّف رقمي) — دفاعاً عن أي تغيير مستقبلي بمصدر القيمة.
function escAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// دالة عامة لتأخير تنفيذ الاستدعاءات المتكررة (مثال: البحث أثناء الكتابة)
// كانت معرّفة بنفس السطور حرفياً داخل 6 ملفات مختلفة — وُحّدت هنا.
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function roleLabels() {
  return { admin: t('role.admin'), manager: t('role.manager'), cashier: t('role.cashier') };
}

// خانات <input type="number"> ترفض الأرقام العربية/الفارسية (٠١٢٣٤٥٦٧٨٩ أو ۰۱۲۳۴۵۶۷۸۹)
// فتفضل فاضية بصمت لو المستخدم كتب بلوحة مفاتيح عربية. هالدالة تحوّل أي أرقام
// عربية/فارسية داخل نص لأرقام إنجليزية قبل parseFloat، حتى لو النص جاي أصلاً
// بصيغة غربية. تُستخدم بدل ما تُستدعى parseFloat مباشرة على أي خانة رقم بالواجهة.
function parseLocaleNumber(value) {
  if (value === null || value === undefined) return NaN;
  const arabicIndic = '٠١٢٣٤٥٦٧٨٩';
  const persian = '۰۱۲۳۴۵۶۷۸۹';
  const normalized = String(value).replace(/[٠-٩۰-۹]/g, (d) => {
    const arabicIdx = arabicIndic.indexOf(d);
    if (arabicIdx !== -1) return String(arabicIdx);
    return String(persian.indexOf(d));
  });
  return parseFloat(normalized);
}

// نفس فكرة parseLocaleNumber لكن للنصوص (PIN، رقم الفاتورة...) حيث لازم نحافظ
// على الشكل الكامل للنص (أصفار أولى، شرطات) بدل تحويله لرقم عشري.
function normalizeDigits(value) {
  if (value === null || value === undefined) return '';
  const arabicIndic = '٠١٢٣٤٥٦٧٨٩';
  const persian = '۰۱۲۳۴۵۶۷۸۹';
  return String(value).replace(/[٠-٩۰-۹]/g, (d) => {
    const arabicIdx = arabicIndic.indexOf(d);
    if (arabicIdx !== -1) return String(arabicIdx);
    return String(persian.indexOf(d));
  });
}

/**
 * يتحقق من وجود مستخدم مسجّل دخوله وأن دوره ضمن الأدوار المسموح بها لهذه الصفحة.
 * إن لم يكن مصرّحاً له، يُعيد توجيهه ويُرجع null (على استدعاء الصفحة عدم المتابعة في هذه الحالة).
 * allowedRoles = null يعني: أي مستخدم مسجّل دخوله يكفي (بدون قيد دور إضافي).
 */
async function guardPage(allowedRoles, redirectPath, options = {}) {
  const user = await window.api.auth.currentUser();

  if (!user) {
    window.location.href = redirectPath;
    return null;
  }
  // options.allowIf: استثناء بحسب المستخدم (مثل كاشير فُوِّض بتعديل الفواتير) رغم أن دوره ليس ضمن الأدوار المسموحة.
  if (allowedRoles && !allowedRoles.includes(user.role) && !(typeof options.allowIf === 'function' && options.allowIf(user))) {
    await infoDialog(t('common.noPermission'));
    window.location.href = redirectPath;
    return null;
  }

  setupTopbar(user);

  const branch = await window.api.branches.current();
  applyBusinessVisibility(branch);
  await applyQuickCashierVisibility();

  return user;
}

// يُخفي رابط "الكاشير السريع" عن أي محل لم يُفعِّله المدير من الإعدادات (مطفأ افتراضياً).
async function applyQuickCashierVisibility() {
  let enabled = false;
  try { enabled = (await window.api.posMode.quickCashierEnabled()).enabled === true; } catch (_) { /* نتعامل معه كمطفأ إن تعذّرت القراءة */ }
  document.querySelectorAll('[data-setting="quickCashier"]').forEach((el) => { el.style.display = enabled ? '' : 'none'; });
}

// Electron لا يدعم window.prompt() إطلاقاً (يرمي دائماً خطأ "prompt() is not
// supported")، لذلك أي شاشة كانت تستخدم prompt()/confirm-with-input كانت تفشل
// بصمت (الخطأ يظهر فقط كـ unhandledrejection عابر) — يبدو للمستخدم أن الزر
// "لا يفعل شيئاً". هاتان الدالتان تعوّضان عن prompt() بنافذة منبثقة حقيقية
// تستخدم نفس تنسيق .modal-overlay/.modal المستخدم بباقي التطبيق.
function promptDialog(label, defaultValue = '', options = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'modal';
    const h2 = document.createElement('h2');
    h2.textContent = label;
    const field = document.createElement('div');
    field.className = 'form-field';
    const input = document.createElement('input');
    input.type = options.type === 'number' ? 'text' : (options.type || 'text');
    input.inputMode = options.type === 'number' ? 'decimal' : undefined;
    input.value = defaultValue ?? '';
    field.appendChild(input);
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn btn-secondary'; cancelBtn.textContent = t('common.cancel', 'إلغاء');
    const okBtn = document.createElement('button');
    okBtn.type = 'button'; okBtn.className = 'btn btn-primary'; okBtn.textContent = t('common.ok', 'موافق');
    actions.appendChild(cancelBtn); actions.appendChild(okBtn);
    modal.appendChild(h2); modal.appendChild(field); modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const cleanup = (result) => { overlay.remove(); resolve(result); };
    cancelBtn.addEventListener('click', () => cleanup(null));
    okBtn.addEventListener('click', () => cleanup(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); cleanup(input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); cleanup(null); }
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

// نفس فكرة promptDialog لكن بقائمة اختيارات ثابتة (بدل ما يكتب المستخدم قيمة
// حرة عرضة للخطأ الإملائي، مثل نوع تسوية الراتب أو طريقة الصرف).
function selectDialog(label, choices, defaultValue) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'modal';
    const h2 = document.createElement('h2');
    h2.textContent = label;
    const field = document.createElement('div');
    field.className = 'form-field';
    const select = document.createElement('select');
    for (const c of choices) {
      const opt = document.createElement('option');
      opt.value = c.value; opt.textContent = c.text;
      if (c.value === defaultValue) opt.selected = true;
      select.appendChild(opt);
    }
    field.appendChild(select);
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn btn-secondary'; cancelBtn.textContent = t('common.cancel', 'إلغاء');
    const okBtn = document.createElement('button');
    okBtn.type = 'button'; okBtn.className = 'btn btn-primary'; okBtn.textContent = t('common.ok', 'موافق');
    actions.appendChild(cancelBtn); actions.appendChild(okBtn);
    modal.appendChild(h2); modal.appendChild(field); modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const cleanup = (result) => { overlay.remove(); resolve(result); };
    cancelBtn.addEventListener('click', () => cleanup(null));
    okBtn.addEventListener('click', () => cleanup(select.value));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
    setTimeout(() => select.focus(), 0);
  });
}

// تحل محلّ window.confirm() الأصلي بنفس شكل .modal-overlay/.modal، ومترجمة بالكامل.
// tone: 'default' | 'danger' | 'warning' — يلوّن الأيقونة وزر التأكيد، ولإجراءات الخطر
// يُركَّز زر الإلغاء افتراضياً (أكثر أماناً من تنفيذ حذف بضغطة Enter عارضة).
function confirmDialog(message, options = {}) {
  const {
    title = null,
    confirmLabel = t('common.ok', 'موافق'),
    cancelLabel = t('common.cancel', 'إلغاء'),
    tone = 'default',
  } = options;
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'alertdialog');
    modal.setAttribute('aria-modal', 'true');

    if (tone === 'danger' || tone === 'warning') {
      const icon = document.createElement('div');
      icon.className = `confirm-dialog-icon tone-${tone}`;
      icon.innerHTML = tone === 'danger'
        ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.3 3.9 2.5 17.5A1.6 1.6 0 0 0 4 20h16a1.6 1.6 0 0 0 1.5-2.5L13.7 3.9a1.6 1.6 0 0 0-2.8 0Z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 8v5M12 16h.01"/><circle cx="12" cy="12" r="9"/></svg>';
      modal.appendChild(icon);
    }
    if (title) {
      const h2 = document.createElement('h2');
      h2.className = 'confirm-dialog-title';
      h2.textContent = title;
      modal.appendChild(h2);
    }
    const p = document.createElement('div');
    p.className = 'confirm-dialog-message';
    p.textContent = message;
    modal.appendChild(p);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn btn-secondary'; cancelBtn.textContent = cancelLabel;
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = tone === 'danger' ? 'btn btn-danger' : 'btn btn-primary';
    okBtn.textContent = confirmLabel;
    actions.appendChild(cancelBtn); actions.appendChild(okBtn);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const cleanup = (result) => { overlay.remove(); document.removeEventListener('keydown', onKeydown); resolve(result); };
    cancelBtn.addEventListener('click', () => cleanup(false));
    okBtn.addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    function onKeydown(e) {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        // في إجراءات الخطر لا نؤكد بـ Enter العارض — التركيز على الإلغاء أصلاً
        if (tone === 'danger') cleanup(false);
        else cleanup(true);
      }
    }
    document.addEventListener('keydown', onKeydown);
    setTimeout(() => (tone === 'danger' ? cancelBtn : okBtn).focus(), 0);
  });
}

// تحل محلّ window.alert() في الحالات التي تعرض معلومات مركّبة/متعددة الأسطر (تفاصيل
// تحويل، ملخص إغلاق وردية...). لرسائل الحالة القصيرة (نجاح/خطأ سطر واحد) استخدم
// showToast() بدلها فهي أخف وغير معطِّلة لعمل المستخدم.
function infoDialog(message, options = {}) {
  const { title = null, okLabel = t('common.ok', 'موافق') } = options;
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'alertdialog');
    modal.setAttribute('aria-modal', 'true');
    if (title) {
      const h2 = document.createElement('h2');
      h2.className = 'confirm-dialog-title';
      h2.textContent = title;
      modal.appendChild(h2);
    }
    const p = document.createElement('div');
    p.className = 'confirm-dialog-message';
    p.textContent = message;
    modal.appendChild(p);
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const okBtn = document.createElement('button');
    okBtn.type = 'button'; okBtn.className = 'btn btn-primary'; okBtn.textContent = okLabel;
    actions.appendChild(okBtn);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const cleanup = () => { overlay.remove(); document.removeEventListener('keydown', onKeydown); resolve(); };
    okBtn.addEventListener('click', cleanup);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });
    function onKeydown(e) { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); cleanup(); } }
    document.addEventListener('keydown', onKeydown);
    setTimeout(() => okBtn.focus(), 0);
  });
}

async function applyRuntimeBranding() {
  try {
    const branding = await window.api.branding.get();
    const brand = document.querySelector('.brand');
    if (brand && branding?.storeName) {
      const text = brand.querySelector('[data-i18n="app.brand"]') || brand.lastElementChild || brand;
      if (text) text.textContent = branding.storeName;
    }
    if (brand && branding?.logoPath) {
      const img = document.createElement('img');
      img.className = 'brand-logo';
      img.alt = '';
      img.src = window.api.pathToFileURL(branding.logoPath);
      brand.querySelector('.brand-mark')?.replaceChildren(img);
    }
  } catch (_) {}
}

function setupTopbar(user) {
  const nameEl = document.getElementById('currentUserName');
  const roleEl = document.getElementById('currentUserRoleBadge');
  const logoutBtn = document.getElementById('logoutBtn');

  if (nameEl) nameEl.textContent = user.full_name;
  if (roleEl) roleEl.textContent = roleLabels()[user.role] || user.role;
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      if (await confirmDialog(t('common.confirmLogout'))) {
        await window.api.auth.logout();
      }
    });
  }

  applyNavVisibility(user);
  applyNavIcons();
  // بعد اكتمال ترجمة اللغة غير المتزامنة (قد تسبق أو تلحق setupTopbar)
  setTimeout(() => { try { applyNavIcons(); } catch (_) {} }, 0);
  setTimeout(() => { try { applyNavIcons(); } catch (_) {} }, 100);
  setupThemeToggle();
  setupChangePasswordButton(user);
  applyRuntimeBranding();
  // توحيد علامة N المميزة على كل الصفحات (بعض الصفحات كانت نصاً عادياً بلا brand-mark)
  document.querySelectorAll('.brand:not(.brand-premium)').forEach((el) => {
    if (el.querySelector('.brand-mark')) return;
    const mark = document.createElement('span');
    mark.className = 'brand-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = 'N';
    el.classList.add('brand-premium');
    el.prepend(mark);
  });
}

// زر "تغيير كلمة المرور" يُضاف مرة واحدة بجانب زر الخروج في كل الصفحات (بدون
// الحاجة لتعديل كل ملف HTML)، ويعمل لأي مستخدم مسجّل دخوله في أي وقت — وليس
// فقط عند الإجبار الأولي بعد أول تسجيل دخول.
function setupChangePasswordButton(user) {
  const host = document.querySelector('.user-info');
  if (!host || document.getElementById('changePasswordBtn')) return;

  const forced = !!(user && user.must_change_password);

  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'changePasswordBtn';
  button.className = 'btn btn-secondary btn-sm';
  button.textContent = '🔑';
  button.title = t('common.changePassword');
  host.insertBefore(button, document.getElementById('logoutBtn'));

  const modal = document.createElement('div');
  modal.className = 'modal-overlay hidden';
  modal.id = 'changePasswordModal';
  modal.innerHTML = `
    <div class="modal">
      <h2>${t('common.changePasswordTitle')}</h2>
      <p id="cpForcedNote" class="hidden">${t('common.changePasswordForcedNote')}</p>
      <form id="changePasswordForm">
        <div class="form-field"><label>${t('common.currentPassword')}</label><input id="cpCurrentPassword" type="password" required /></div>
        <div class="form-field"><label>${t('common.newPassword')}</label><input id="cpNewPassword" type="password" minlength="8" required /></div>
        <div class="form-field"><label>${t('common.confirmNewPassword')}</label><input id="cpConfirmPassword" type="password" minlength="8" required /></div>
        <div id="cpError" class="payment-error hidden"></div>
        <div id="cpSuccess" class="hidden" style="color:var(--success);font-size:13px;"></div>
        <div class="modal-actions">
          <button type="button" id="cpCancel" class="btn btn-secondary">${t('common.cancel')}</button>
          <button type="submit" class="btn btn-primary">${t('common.save')}</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(modal);

  const form = document.getElementById('changePasswordForm');
  const error = document.getElementById('cpError');
  const success = document.getElementById('cpSuccess');
  const cancelBtn = document.getElementById('cpCancel');
  const forcedNote = document.getElementById('cpForcedNote');
  let isForced = forced;

  const openModal = () => {
    modal.classList.remove('hidden');
    cancelBtn.classList.toggle('hidden', isForced);
    forcedNote.classList.toggle('hidden', !isForced);
  };
  const closeModal = () => {
    if (isForced) return; // لا يُغلق إجبارياً حتى تُغيَّر كلمة المرور
    modal.classList.add('hidden');
    form.reset();
    error.classList.add('hidden');
    success.classList.add('hidden');
  };

  button.addEventListener('click', openModal);
  cancelBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.classList.add('hidden');
    success.classList.add('hidden');
    const currentPassword = document.getElementById('cpCurrentPassword').value;
    const newPassword = document.getElementById('cpNewPassword').value;
    const confirmPassword = document.getElementById('cpConfirmPassword').value;
    if (newPassword.length < 8) { error.textContent = t('common.passwordTooShort'); error.classList.remove('hidden'); return; }
    if (newPassword !== confirmPassword) { error.textContent = t('pos.passwordMismatch'); error.classList.remove('hidden'); return; }
    try {
      await window.api.auth.changeOwnPassword({ currentPassword, newPassword });
      isForced = false;
      success.textContent = t('common.passwordChanged');
      success.classList.remove('hidden');
      form.reset();
      setTimeout(closeModal, 1500);
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
    }
  });

  if (forced) openModal();
}

async function setupThemeToggle() {
  const host = document.querySelector('.topbar-right');
  if (!host || document.getElementById('themeToggle')) return;
  let theme = 'light';
  try { theme = await window.api.theme.get(); } catch (_) { /* لا توقف الصفحة إن فشل التخزين */ }
  document.body.dataset.theme = theme;
  const button = document.createElement('button');
  button.type = 'button'; button.id = 'themeToggle'; button.className = 'theme-toggle';
  const render = () => { button.textContent = theme === 'dark' ? '☀️' : '🌙'; button.title = theme === 'dark' ? t('common.lightMode') : t('common.darkMode'); };
  render();
  button.addEventListener('click', async () => { theme = theme === 'dark' ? 'light' : 'dark'; document.body.dataset.theme = theme; render(); await window.api.theme.set(theme); });
  // صف أدوات مضغوط: وضع الليل + اللغة جنب بعض بدل عمود طويل
  let tools = host.querySelector('.sidebar-tools');
  if (!tools) {
    tools = document.createElement('div');
    tools.className = 'sidebar-tools';
    const lang = host.querySelector('#langSwitcher, .lang-switcher');
    host.prepend(tools);
    tools.appendChild(button);
    if (lang) tools.appendChild(lang);
  } else {
    tools.prepend(button);
  }
}

// يُخفي روابط شريط التنقّل التي لا تناسب دور المستخدم الحالي
// (كل رابط محمي يحمل data-roles="admin,manager" مثلاً في الـ HTML)
// للكاشير: يبقى فقط كاشير / سريع / طاولات / صندوق (+ مرتجعات إن فُوِّض) — بدون محاسبة ورواتب.
function applyNavVisibility(user) {
  const role = (user && user.role) || 'cashier';
  const cashierAllowed = new Set(['nav.pos', 'nav.quickCashier', 'nav.tables', 'nav.cashSession']);
  document.querySelectorAll('.nav-links a').forEach((a) => {
    const key = a.getAttribute('data-i18n') || '';
    const rolesAttr = a.getAttribute('data-roles');
    if (rolesAttr) {
      const roles = rolesAttr.split(',');
      const delegatedReturns = /(^|\/)returns\.html$/.test(a.getAttribute('href') || '') && Number(user.can_modify_sales) === 1;
      if (!roles.includes(role) && !delegatedReturns) {
        a.style.display = 'none';
        return;
      }
    }
    // كاشير: أخفِ أي رابط إداري حتى لو نُسي data-roles في صفحة ما
    if (role === 'cashier' && key && !cashierAllowed.has(key)) {
      const isDelegatedReturns = key === 'nav.returns' && Number(user.can_modify_sales) === 1;
      if (!isDelegatedReturns) a.style.display = 'none';
    }
  });
}

// أيقونات نصية بجانب روابط الشريط الجانبي — على كل الصفحات (كاشير / سريع / إعدادات…)
function applyNavIcons() {
  // مُصدَّرة لـ i18n.js حتى لا تُمسَح الأيقونات بعد applyTranslations
  const map = {
    'nav.pos': '◉',
    'nav.quickCashier': '⚡',
    'nav.tables': '⊞',
    'nav.cashSession': '▣',
    'nav.returns': '↺',
    'nav.products': '▦',
    'nav.bundles': '✦',
    'nav.inventory': '▤',
    'nav.customers': '☺',
    'nav.suppliers': '⇄',
    'nav.reports': '▤',
    'nav.accounting': '¤',
    'nav.audit': '☰',
    'nav.payroll': '₽',
    'nav.users': '◎',
    'nav.settings': '⚙'
  };
  // مطابقة احتياطية بالمسار لو اختفى data-i18n
  const hrefMap = [
    [/index\.html|^\.?\/?$|pos/i, '◉'],
    [/quick-cashier/i, '⚡'],
    [/tables/i, '⊞'],
    [/shift/i, '▣'],
    [/returns/i, '↺'],
    [/products/i, '▦'],
    [/bundles/i, '✦'],
    [/inventory/i, '▤'],
    [/customers/i, '☺'],
    [/suppliers/i, '⇄'],
    [/reports/i, '▤'],
    [/accounting/i, '¤'],
    [/audit/i, '☰'],
    [/payroll/i, '₽'],
    [/users/i, '◎'],
    [/settings/i, '⚙'],
  ];
  document.querySelectorAll('.nav-links a').forEach((a) => {
    const key = a.getAttribute('data-i18n') || '';
    let symbol = map[key];
    if (!symbol) {
      const href = a.getAttribute('href') || '';
      for (const [re, sym] of hrefMap) {
        if (re.test(href)) { symbol = sym; break; }
      }
    }
    symbol = symbol || '•';

    let ico = a.querySelector(':scope > .nav-ico');
    if (!ico) {
      ico = document.createElement('span');
      ico.className = 'nav-ico';
      ico.setAttribute('aria-hidden', 'true');
      a.prepend(ico);
    }
    ico.textContent = symbol;

    // نص الرابط في span منفصل حتى لا تمسح الترجمة الأيقونة
    let label = a.querySelector(':scope > .nav-label');
    if (!label) {
      label = document.createElement('span');
      label.className = 'nav-label';
      // اجمع النص الحالي (بدون الأيقونة) ثم انقله للتسمية
      let text = '';
      Array.from(a.childNodes).forEach((n) => {
        if (n === ico || n === label) return;
        if (n.nodeType === 3) {
          text += n.nodeValue;
          n.remove();
        } else if (n.nodeType === 1 && !n.classList.contains('nav-ico')) {
          text += n.textContent;
          n.remove();
        }
      });
      if (text.trim()) label.textContent = text.trim();
      a.appendChild(label);
    }
  });
}

window.applyNavIcons = applyNavIcons;

/** يمرّر الرابط النشط إلى منتصف الشريط الجانبي حتى لا يحتاج المستخدم للنزول يدوياً */
function scrollActiveNavIntoView() {
  const nav = document.querySelector('.nav-links');
  const active = nav && nav.querySelector('a.active');
  if (!active || !nav) return;
  try {
    const navRect = nav.getBoundingClientRect();
    const itemRect = active.getBoundingClientRect();
    const offset = (itemRect.top + itemRect.bottom) / 2 - (navRect.top + navRect.bottom) / 2;
    nav.scrollTop += offset;
  } catch (_) { /* ignore */ }
}
window.scrollActiveNavIntoView = scrollActiveNavIntoView;

// ضمان ظهور الأيقونات حتى لو تأخر guardPage أو لم يُستدعَ setupTopbar
if (typeof document !== 'undefined') {
  const runIcons = () => {
    try { applyNavIcons(); } catch (_) {}
    try { scrollActiveNavIntoView(); } catch (_) {}
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runIcons);
  } else {
    runIcons();
  }
  window.addEventListener('load', runIcons);
}

// يُخفي أي عنصر خاص بقطاع معيّن، وليس روابط القائمة فقط.
// مثال: data-business="fashion" لحقول المقاس/اللون و data-business="restaurant" للطاولات.
function applyBusinessVisibility(branch) {
  const type = branch ? branch.business_type || 'general' : 'general';
  document.querySelectorAll('[data-business]').forEach((element) => {
    const allowed = element.getAttribute('data-business').split(',');
    // "عام" يعني "يظهر كل شيء" كما هو موصوف فعليًا في شاشة الإعدادات —
    // لذلك لا نخفي عناصر خاصة بأزياء/مطاعم/سوبرماركت عن محل نوعه "عام".
    element.hidden = type !== 'general' && !allowed.includes(type);
  });
  const terminology = type === 'restaurant' ? t('common.itemTerm') : t('common.productTerm');
  document.querySelectorAll('[data-product-label]').forEach((element) => { element.textContent = terminology; });
}


// Global accessibility shortcuts: Escape closes the top-most modal; Ctrl/Cmd+Enter submits the active form.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    const modals = Array.from(document.querySelectorAll('.modal-overlay:not(.hidden)'));
    const modal = modals[modals.length - 1];
    if (modal) {
      const close = modal.querySelector('[data-modal-close], .modal-actions .btn-secondary');
      if (close) { event.preventDefault(); close.click(); }
    }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    const target = event.target;
    const form = target?.closest?.('form');
    if (form) {
      event.preventDefault();
      form.requestSubmit();
    }
  }
});

// Premium command palette: keyboard-first navigation without touching business IPC.
(() => {
  let palette = null;
  let input = null;
  let items = [];
  let selected = 0;
  // المسارات مكتوبة كلها نسبةً لمجلد renderer/ (الجذر)، بصرف النظر من أين فُتحت
  // اللوحة. common.js يُحمَّل من renderer/index.html (الكاشير، بجذر renderer/)
  // ومن كل صفحات renderer/pages/*.html (مستوى أعمق بمجلد واحد) على حد سواء —
  // فمسار نسبي واحد ثابت (مثل 'tables.html' بلا بادئة pages/) كان يعمل فقط لو
  // فُتحت اللوحة من داخل pages/، ويفشل (صفحة غير موجودة) لو فُتحت من الكاشير نفسه،
  // والعكس صحيح لرابط الكاشير '../index.html'. pageRoot() تحسب البادئة الصحيحة
  // ديناميكياً حسب موقع الصفحة الحالية فعلياً بدل افتراض موقع واحد ثابت.
  const routes = [
    ['nav.pos', 'index.html'],
    ['nav.tables', 'pages/tables.html'],
    ['nav.products', 'pages/products.html'],
    ['nav.bundles', 'pages/bundles.html'],
    ['nav.inventory', 'pages/inventory.html'],
    ['nav.customers', 'pages/customers.html'],
    ['nav.suppliers', 'pages/suppliers.html'],
    ['nav.reports', 'pages/reports.html'],
    ['nav.accounting', 'pages/accounting.html'],
    ['nav.returns', 'pages/returns.html'],
    ['nav.cashSession', 'pages/shift.html'],
    ['nav.audit', 'pages/audit.html'],
    ['nav.payroll', 'pages/payroll.html'],
    ['nav.users', 'pages/users.html'],
    ['nav.settings', 'pages/settings.html']
  ];
  function pageRoot() { return location.pathname.includes('/renderer/pages/') ? '../' : ''; }
  function visibleRoutes() {
    const root = pageRoot();
    return routes
      .filter(([key]) => {
        const nav = Array.from(document.querySelectorAll('.nav-links a')).find(a => a.getAttribute('data-i18n') === key);
        return !nav || nav.offsetParent !== null;
      })
      .map(([key, href]) => [key, root + href]);
  }
  function close() { if (palette) palette.remove(); palette = null; input = null; items = []; }
  const safe = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch]));
  function render(list, q='') {
    if (!palette) return;
    const body = palette.querySelector('.command-palette-list');
    body.innerHTML = '';
    const filtered = list.filter(([key]) => t(key).toLowerCase().includes(q.toLowerCase()));
    items = filtered;
    if (!filtered.length) { body.innerHTML = `<div class="command-empty">${safe(t('common.commandEmpty', 'No matching actions'))}</div>`; selected=0; return; }
    filtered.forEach(([key, href], idx) => {
      const row = document.createElement('button'); row.type='button'; row.className='command-item'; row.setAttribute('data-index', String(idx));
      row.innerHTML = `<span>${safe(t(key))}</span><kbd>${idx+1}</kbd>`;
      row.addEventListener('click', () => { close(); location.href = href; });
      body.appendChild(row);
    });
    selected = Math.min(selected, filtered.length-1); updateSelected();
  }
  function updateSelected() { palette?.querySelectorAll('.command-item').forEach((el,i)=>el.classList.toggle('selected', i===selected)); }
  function open() {
    if (palette) return;
    palette = document.createElement('div'); palette.className='command-palette-backdrop';
    palette.innerHTML = `<div class="command-palette" role="dialog" aria-modal="true"><div class="command-palette-head"><span>${safe(t('common.commandPalette','Quick navigation'))}</span><kbd>Esc</kbd></div><input class="command-palette-input" autocomplete="off" placeholder="${safe(t('common.commandSearch','Search screens...'))}"><div class="command-palette-list"></div><div class="command-palette-foot"><span>${safe(t('common.commandHint','Use ↑ ↓ and Enter'))}</span><kbd>Ctrl K</kbd></div></div>`;
    document.body.appendChild(palette); input=palette.querySelector('input');
    const list=visibleRoutes(); render(list); input.focus();
    input.addEventListener('input',()=>render(list,input.value));
    palette.addEventListener('click',e=>{ if(e.target===palette) close(); });
  }
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==='k') { e.preventDefault(); open(); return; }
    if (!palette) return;
    if (e.key==='Escape') { e.preventDefault(); close(); }
    else if (e.key==='ArrowDown') { e.preventDefault(); selected=Math.min(selected+1,items.length-1); updateSelected(); }
    else if (e.key==='ArrowUp') { e.preventDefault(); selected=Math.max(selected-1,0); updateSelected(); }
    else if (e.key==='Enter' && items[selected]) { e.preventDefault(); const href=items[selected][1]; close(); location.href=href; }
  });
})();

// Main-process heartbeat: lets the application distinguish an actual renderer stall from a slow IPC call.
//
// مهم: "busy" هنا تشمل أيضاً أي نافذة منبثقة مفتوحة (مثل نماذج الرواتب:
// إضافة عامل / تسجيل سلفة أو خصم...) وأي حقل إدخال يكتب فيه المستخدم حالياً.
// السابق كان يتحقق فقط من عناصر .loading أو aria-busy، فإذا تأخر رد IPC
// أثناء كتابة المستخدم داخل نموذج رواتب مفتوح (بلا مؤشر busy خاص به)،
// كان الـ watchdog في العملية الرئيسية يعيد تحميل النافذة تلقائياً بعد 12
// ثانية ويمسح ما كُتب — وهذا ما كان يظهر للمستخدم كـ"جمود" مفاجئ.
function isUserActivelyEngaged() {
  const openModal = document.querySelector(
    '.pro-modal:not(.hidden), .modal-overlay:not(.hidden)'
  );
  if (openModal) return true;
  const active = document.activeElement;
  if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || '')) return true;
  return false;
}
(() => {
  const heartbeat = () => {
    try {
      const paymentModal = document.getElementById('paymentModal');
      window.api?.system?.rendererHeartbeat?.({
        route: location.pathname,
        visible: document.visibilityState === 'visible',
        busy: !!document.querySelector('.loading, [aria-busy=\"true\"]') || isUserActivelyEngaged(),
        paymentOpen: !!paymentModal && !paymentModal.classList.contains('hidden'),
      });
    } catch (_) {}
  };
  heartbeat();
  setInterval(heartbeat, 2000);
})();

// Performance safety net: never reload immediately on a stall. We record the stall and expose
// a recovery banner after the event loop becomes responsive again. This helps diagnose rare
// keyboard/input freezes without risking data loss from an automatic page refresh.
(() => {
  const startedAt = performance.now();
  let lastTick = startedAt;
  let lastRecovery = 0;
  const tick = () => {
    const now = performance.now();
    const lag = now - lastTick;
    if (lag > 1500 && now - lastRecovery > 5000) {
      lastRecovery = now;
      try {
        window.api?.audit?.clientEvent?.({
          level: 'warning',
          type: 'renderer_stall',
          details: { lagMs: Math.round(lag), route: location.pathname },
        });
      } catch (_) {}
    }
    lastTick = now;
  };
  setInterval(tick, 500);
  window.addEventListener('error', (event) => {
    const message = String(event?.error?.message || event?.message || 'unknown');
    try { window.api?.audit?.clientEvent?.({ level: 'error', type: 'renderer_error', details: { message } }); } catch (_) {}
    showErrorToast(t('common.unexpectedError', 'حدث خطأ غير متوقع: ') + message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const message = String(event?.reason?.message || event?.reason || 'unknown');
    try { window.api?.audit?.clientEvent?.({ level: 'error', type: 'renderer_rejection', details: { message } }); } catch (_) {}
    // هذا هو المسار الذي كانت فيه أخطاء العمليات (مثلاً فتح نافذة "منتج جديد" حين
    // يفشل نداء IPC بصمت) تُسجَّل بسجل التدقيق فقط دون أن يرى المستخدم أي شيء —
    // فتبدو الواجهة وكأنها "لا تستجيب" بدون أي تفسير. الآن تظهر كرسالة مرئية فوراً.
    showErrorToast(message);
  });
})();

// رسالة خطأ عائمة صغيرة تظهر لأي فشل غير متوقع (JS أو IPC) بدل ما يبقى صامتاً
// بسجل التدقيق فقط. تُستخدم من معالجات error/unhandledrejection أعلاه.
function showToast(message, type = 'success', options = {}) {
  let container = document.getElementById('nexoraToastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'nexoraToastContainer';
    container.className = 'nexora-toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `nexora-toast nexora-toast-${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.innerHTML = `<span class="nexora-toast-icon" aria-hidden="true">${type === 'success' ? '✓' : type === 'error' ? '!' : 'i'}</span><span>${escapeHtml(String(message || ''))}</span>`;
  container.appendChild(toast);
  const duration = Number(options.duration || (type === 'error' ? 6500 : 3000));
  setTimeout(() => toast.remove(), duration);
  return toast;
}

function setBusy(element, busy, label) {
  if (!element) return;
  if (busy) {
    if (!element.dataset.busyLabel) element.dataset.busyLabel = element.textContent;
    element.disabled = true;
    element.setAttribute('aria-busy', 'true');
    if (label) element.textContent = label;
  } else {
    element.disabled = false;
    element.removeAttribute('aria-busy');
    if (element.dataset.busyLabel) {
      element.textContent = element.dataset.busyLabel;
      delete element.dataset.busyLabel;
    }
  }
}

function renderPageEmptyState(container, { icon = '○', title = '', message = '', actionText = '', onAction = null } = {}) {
  if (!container) return;
  container.innerHTML = `
    <div class="nexora-empty-state">
      <div class="nexora-empty-icon" aria-hidden="true">${escapeHtml(icon)}</div>
      <h3>${escapeHtml(title)}</h3>
      ${message ? `<p>${escapeHtml(message)}</p>` : ''}
      ${actionText ? '<button type="button" class="btn btn-primary nexora-empty-action"></button>' : ''}
    </div>`;
  const btn = container.querySelector('.nexora-empty-action');
  if (btn) {
    btn.textContent = actionText;
    if (onAction) btn.addEventListener('click', onAction);
  }
}

function setPageLoading(container, loading, label = 'جارٍ التحميل...') {
  if (!container) return;
  if (loading) {
    container.setAttribute('aria-busy', 'true');
    if (!container.dataset.loadingMarkup) container.dataset.loadingMarkup = container.innerHTML;
    container.innerHTML = `<div class="nexora-loading-state"><span class="nexora-spinner" aria-hidden="true"></span><span>${escapeHtml(label)}</span></div>`;
  } else {
    container.removeAttribute('aria-busy');
    delete container.dataset.loadingMarkup;
  }
}

function enhanceFormSubmit(form, button, successMessage) {
  if (!form || !button) return;
  form.addEventListener('submit', async () => {
    setBusy(button, true, t('common.savingBusy', 'جارٍ الحفظ...'));
    if (successMessage) setTimeout(() => showToast(successMessage), 0);
  }, { once: false });
}

function showErrorToast(message) {
  let container = document.getElementById('errorToastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'errorToastContainer';
    container.className = 'error-toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'error-toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 7000);
}


/* ---- Keyboard shortcuts help (? key) ---- */
function showKeyboardHelp() {
  if (document.getElementById('nexora-keys-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'nexora-keys-overlay';
  overlay.className = 'nexora-keys-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Keyboard shortcuts');
  overlay.innerHTML = `
    <div class="nexora-keys-card">
      <h2>اختصارات لوحة المفاتيح</h2>
      <ul>
        <li><kbd>F2</kbd> التركيز على البحث / الباركود</li>
        <li><kbd>F4</kbd> إتمام البيع</li>
        <li><kbd>Ctrl</kbd>+<kbd>Enter</kbd> إتمام البيع</li>
        <li><kbd>Esc</kbd> مسح البحث / إغلاق</li>
        <li><kbd>?</kbd> هذه المساعدة</li>
      </ul>
      <button type="button" class="btn btn-primary" id="nexora-keys-close">إغلاق</button>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#nexora-keys-close').onclick = close;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === '?' && !e.ctrlKey && !e.metaKey && !['INPUT','TEXTAREA','SELECT'].includes(e.target?.tagName)) {
    e.preventDefault();
    showKeyboardHelp();
  }
});
