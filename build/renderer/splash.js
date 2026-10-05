// يحاول عرض شعار/اسم المتجر إن كانا محفوظين مسبقاً (أول تشغيل قد لا توجد بيانات بعد)
(async function applyBranding() {
  try {
    if (!window.api || !window.api.branding) return;
    const branding = await window.api.branding.get();
    if (branding && branding.storeName) {
      document.getElementById('splashTitle').textContent = branding.storeName;
    }
    if (branding && branding.logoPath) {
      const logoEl = document.getElementById('splashLogo');
      logoEl.textContent = '';
      const img = document.createElement('img');
      img.src = window.api.pathToFileURL(branding.logoPath);
      logoEl.appendChild(img);
    }
  } catch (err) {
    // لا مشكلة إن فشل — تبقى الشاشة الافتراضية
  }
})();
