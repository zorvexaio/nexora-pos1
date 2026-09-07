const fs=require("fs"); const assert=require("assert");
const main=fs.readFileSync("main.js","utf8");
const settings=fs.readFileSync("renderer/pages/settings.html","utf8");
// ملاحظة: منذ v0.47.0 صارت نداءات الطباعة التلقائية تُرفَق نتيجتها بالرد
// (printOutcome) بدل تجاهلها بـ void، حتى تقدر الواجهة تنبّه المستخدم فوراً
// لو الطابعة فشلت. حدّثنا هالفحص ليطابق ذلك بدل الصيغة القديمة `void autoSendKitchen(saleId)`.
assert(/autoSendKitchen\(saleId\)\.then\(/.test(main),"table save must route to kitchen");
assert(/ipcMain\.handle\('tables:close'[\s\S]*?autoPrintReceipt\(saleId\)\.then\(/.test(main),"table close must route to receipt");
const close=main.slice(main.indexOf("ipcMain.handle('tables:close'"),main.indexOf("// تحرير طاولة",main.indexOf("ipcMain.handle('tables:close'")));
assert(!/autoSendKitchen\(/.test(close),"table close must not route to kitchen");
const split=main.slice(main.indexOf("ipcMain.handle('tables:split'"),main.indexOf("ipcMain.handle('tables:close'"));
assert(/autoPrintReceipt\(result\.id\)\.then\(/.test(split) && !/autoSendKitchen\(/.test(split),"table payment split must only route to receipt");
assert(/fieldKitchenPrinterName/.test(settings)&&/fieldReceiptPrinterName/.test(settings),"separate printer fields exist");
console.log("V0.45.6 ROUTING REGRESSION: PASS");
