#!/usr/bin/env node
// يعيد بناء الوحدة الأصلية (better-sqlite3-multiple-ciphers) لتطابق إصدار Electron المُثبَّت.
// قد تفشل هذه الخطوة لعدة أسباب مختلفة تماماً، ويجب تمييزها بدل افتراض سبب واحد دائماً:
//   1) فشل استدعاء npx.cmd نفسه على ويندوز (خطأ على مستوى spawn، قبل تشغيل أي شيء فعلياً) —
//      يظهر هذا كفشل "صامت" تماماً بلا أي مخرجات من npx/gyp إطلاقاً، وهو أكثر الأسباب شيوعاً
//      لهذا النمط بالذات. يُصلَح عادة بتمرير shell:true عند استدعاء ملفات .cmd على ويندوز.
//   2) تنزيل ثنائيات/رؤوس Electron يفشل بسبب حجب/بطء الوصول لخوادم electronjs.org أو
//      github.com — هنا تفيد إعادة المحاولة عبر مرآة بديلة (npmmirror.com).
//   3) أدوات البناء المحلية (Python / Visual Studio Build Tools) غير مثبَّتة على الجهاز —
//      وهنا لن تفيد أي مرآة تنزيل إطلاقاً، لأن node-gyp يفشل محلياً قبل أي اتصال بالشبكة.
const { spawnSync } = require('child_process');

function runRebuild(env) {
  const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  // shell:true ضروري على ويندوز لاستدعاء ملفات .cmd (مثل npx.cmd) بشكل موثوق عبر
  // spawnSync؛ بدونها قد يفشل الاستدعاء صامتاً (خطأ spawn داخلي) قبل أن يُشغَّل أي أمر
  // فعلياً، فتظهر النتيجة "فشل" بلا أي مخرجات إطلاقاً من npx أو gyp — وهذا بالضبط ما كان
  // يحدث. نلتقط المخرجات (بدل تمريرها فقط) حتى نحلّلها، ثم نطبعها كاملة فوراً للمستخدم.
  const result = spawnSync(
    npxBin,
    ['@electron/rebuild', '-f', '-w', 'better-sqlite3-multiple-ciphers'],
    { encoding: 'utf8', env, shell: process.platform === 'win32' }
  );
  const spawnErrorText = result.error ? `[spawn error] ${result.error.code || ''} ${result.error.message || ''}` : '';
  const output = `${result.stdout || ''}\n${result.stderr || ''}\n${spawnErrorText}`;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (spawnErrorText) console.error(spawnErrorText);
  return { ok: !result.error && result.status === 0, output };
}

function diagnose(output) {
  const o = String(output || '').trim();
  if (/\[spawn error\]/.test(o) || (o.replace(/\n/g, '').trim() === '')) {
    return [
      'السبب الأرجح: تعذّر استدعاء الأمر "npx" نفسه على هذا الجهاز (لا علاقة له بالإنترنت أو Python أو Visual Studio).',
      'تحقق يدوياً: افتح PowerShell جديد وشغّل الأمر التالي مباشرة لترى الخطأ الحقيقي كاملاً:',
      'npx @electron/rebuild -f -w better-sqlite3-multiple-ciphers',
      'إن ظهرت رسالة أن "npx" غير معروف كأمر: أعد تثبيت Node.js من https://nodejs.org (النسخة LTS)، تأكد أن',
      'خيار "Add to PATH" مفعّل أثناء التثبيت، ثم أعد تشغيل الجهاز (لا يكفي إغلاق PowerShell فقط) وجرّب مجدداً.',
    ].join('\n');
  }
  if (/find VS|Visual Studio|VCINSTALLDIR|MSB\d{4}|could not find.*visual studio/i.test(o)) {
    return [
      'السبب الأرجح: أدوات بناء Visual Studio (C++ build tools) غير مثبَّتة على هذا الجهاز.',
      'الحل: ثبّت "Visual Studio Build Tools" مع مكوّن "Desktop development with C++" من:',
      'https://visualstudio.microsoft.com/visual-cpp-build-tools/',
      'ثم أعد تشغيل PowerShell وجرّب "npm run rebuild" مجدداً. لا علاقة لهذا بالإنترنت أو المرايا.',
    ].join('\n');
  }
  if (/can'?t find python|python is not set|ENOENT.*python|gyp ERR!.*python/i.test(o)) {
    return [
      'السبب الأرجح: Python غير مثبَّت أو غير موجود بمسار PATH (مطلوب لبناء الوحدة الأصلية).',
      'الحل: ثبّت Python 3.x من https://www.python.org/downloads/ (فعّل خيار "Add python.exe to PATH" أثناء التثبيت)،',
      'ثم أعد تشغيل PowerShell وجرّب "npm run rebuild" مجدداً. لا علاقة لهذا بالإنترنت أو المرايا.',
    ].join('\n');
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|getaddrinfo|self signed certificate|unable to get local issuer certificate|403|network/i.test(o)) {
    return [
      'السبب الأرجح: مشكلة اتصال فعلية بالشبكة (حجب/بطء/شهادة SSL) عند تنزيل ثنائيات Electron.',
      'جرّب: شبكة إنترنت مختلفة (بيانات الهاتف مثلاً)، أو أوقف مؤقتاً أي VPN/برنامج حماية يعترض الاتصال، ثم أعد المحاولة.',
    ].join('\n');
  }
  return [
    'تعذر تحديد السبب تلقائياً من المخرجات أعلاه.',
    'راجع النص الكامل أعلاه (خصوصاً أي سطر يبدأ بـ "gyp ERR!" أو "Error:")، أو راجع docs/WINDOWS_CUSTOMER_RELEASE.md.',
  ].join('\n');
}

const first = runRebuild(process.env);
if (first.ok) process.exit(0);

console.log('\n[rebuild] المحاولة الأولى فشلت. إعادة المحاولة تلقائياً عبر مرآة تنزيل بديلة (npmmirror.com)...\n');

const mirrorUrl = 'https://npmmirror.com/mirrors/electron/';
const mirrorEnv = Object.assign({}, process.env, {
  ELECTRON_MIRROR: mirrorUrl,
  npm_config_electron_mirror: mirrorUrl,
});

const second = runRebuild(mirrorEnv);
if (second.ok) process.exit(0);

console.error('\n[rebuild] فشلت إعادة البناء حتى مع المرآة البديلة.\n');
console.error(diagnose(first.output + '\n' + second.output));
console.error('\n[rebuild] راجع أيضاً: docs/WINDOWS_CUSTOMER_RELEASE.md');
process.exit(1);
