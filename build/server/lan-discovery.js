// ==========================================================
// اكتشاف تلقائي للجهاز الرئيسي على شبكة المحل المحلية (LAN) عبر بث UDP.
// الهدف: الكاشير الثاني والثالث... يفتحون التطبيق فقط، ويظهر لهم الجهاز الرئيسي تلقائياً
// بالاسم، بدون أي حاجة لمعرفة أو كتابة عنوان IP يدوياً.
//
// الجهاز الرئيسي: يبث كل ثانيتين رسالة صغيرة (اسم المحل + المنفذ) على عنوان البث المحلي.
// الأجهزة الطرفية: تستمع لهذا البث، وتحتفظ بقائمة "الأجهزة المكتشفة حديثاً" (تُحذف تلقائياً
// إن لم يُسمع منها بث خلال 6 ثوانٍ — أي أنها أُغلقت أو غادرت الشبكة).
// ==========================================================
const dgram = require('dgram');
const os = require('os');

const DISCOVERY_PORT = 41234;
const BROADCAST_INTERVAL_MS = 2000;
const STALE_AFTER_MS = 6000;
const MAGIC = 'POS_LAN_MAIN_V1';

function getLocalIPv4Addresses() {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
    }
  }
  return addresses;
}

// يبدأ بث دوري يُعلن وجود هذا الجهاز كـ"جهاز رئيسي" على الشبكة المحلية.
// getInfo() تُستدعى قبل كل بث لأخذ أحدث بيانات (اسم المحل قد يتغيّر من الإعدادات).
function startBeacon(getInfo) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let timer = null;

  socket.on('error', () => {
    // فشل البث لا يجب أن يوقف التطبيق — المستخدم ببساطة لن يُكتشف تلقائياً، ويقدر يدخل IP يدوياً
  });

  socket.bind(() => {
    socket.setBroadcast(true);
    timer = setInterval(() => {
      const info = getInfo();
      if (!info) return;
      const message = Buffer.from(
        JSON.stringify({ magic: MAGIC, name: info.name, port: info.port, branchUuid: info.branchUuid })
      );
      socket.send(message, 0, message.length, DISCOVERY_PORT, '255.255.255.255', () => {});
    }, BROADCAST_INTERVAL_MS);
    timer.unref();
  });

  return {
    stop: () => {
      if (timer) clearInterval(timer);
      socket.close();
    },
  };
}

// يستمع لبثّ الأجهزة الرئيسية على الشبكة، ويستدعي onUpdate(devices) في كل مرة تتغيّر فيها
// قائمة الأجهزة المكتشفة (إضافة جهاز جديد، أو اختفاء جهاز لم يُسمع منه بث لفترة).
function startListener(onUpdate) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const devices = new Map(); // key: `${address}:${port}` -> { name, address, port, branchUuid, lastSeen }

  socket.on('error', () => {
    // فشل الاستماع لا يجب أن يوقف التطبيق — المستخدم يقدر يدخل IP يدوياً كبديل
  });

  socket.on('message', (msg, rinfo) => {
    let parsed;
    try {
      parsed = JSON.parse(msg.toString());
    } catch {
      return;
    }
    if (!parsed || parsed.magic !== MAGIC) return;

    const key = `${rinfo.address}:${parsed.port}`;
    devices.set(key, {
      name: parsed.name,
      address: rinfo.address,
      port: parsed.port,
      branchUuid: parsed.branchUuid,
      lastSeen: Date.now(),
    });
    onUpdate(pruneAndList());
  });

  function pruneAndList() {
    const now = Date.now();
    for (const [key, device] of devices) {
      if (now - device.lastSeen > STALE_AFTER_MS) devices.delete(key);
    }
    return Array.from(devices.values());
  }

  const pruneTimer = setInterval(() => onUpdate(pruneAndList()), 2000);
  pruneTimer.unref();

  socket.bind(DISCOVERY_PORT, () => {
    try {
      socket.setBroadcast(true);
    } catch {
      // بعض الأنظمة لا تحتاج هذا للاستماع فقط
    }
  });

  return {
    stop: () => {
      clearInterval(pruneTimer);
      socket.close();
    },
    listNow: pruneAndList,
  };
}

module.exports = { startBeacon, startListener, getLocalIPv4Addresses, DISCOVERY_PORT };
