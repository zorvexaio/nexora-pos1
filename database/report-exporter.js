const fs = require('fs');

const xml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// حماية من "CSV/Excel formula injection": لو اسم منتج أو مندوب توصيل (بيانات يُدخلها مستخدم)
// يبدأ بـ = أو + أو - أو @ ممكن يُفسَّر كصيغة عند فتح الملف ببعض برامج الجداول. نضيف علامة اقتباس
// أول القيمة فقط بهالحالة (تبقى القيمة نفسها ظاهرة، بس كنص وليس صيغة).
const neutralizeFormula = (value) => {
  const str = String(value ?? '');
  return /^[=+\-@]/.test(str) ? `'${str}` : str;
};
const col = (number) => {
  let result = '';
  while (number > 0) { const r = (number - 1) % 26; result = String.fromCharCode(65 + r) + result; number = Math.floor((number - 1) / 26); }
  return result;
};
function sheetXml(rows) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView rightToLeft="1" workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${(rows[0] || []).map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="22" customWidth="1"/>`).join('')}</cols><sheetData>${rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => typeof value === 'number' ? `<c r="${col(c + 1)}${r + 1}"><v>${Number.isFinite(value) ? value : 0}</v></c>` : `<c r="${col(c + 1)}${r + 1}" t="inlineStr"><is><t>${xml(neutralizeFormula(value))}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
}
function zip(entries) {
  // ZIP بدون ضغط: ملف XLSX قياسي وقابل للفتح في Excel، بلا اعتماديات native إضافية.
  const buffers = []; const central = []; let offset = 0;
  const crc32 = (data) => { let crc = ~0; for (const b of data) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (~crc) >>> 0; };
  for (const [name, content] of entries) {
    const filename = Buffer.from(name); const data = Buffer.from(content); const crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    buffers.push(local, filename, data);
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt32LE(crc, 16); header.writeUInt32LE(data.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(filename.length, 28); header.writeUInt32LE(offset, 42);
    central.push(header, filename); offset += local.length + filename.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...buffers, ...central, end]);
}
function dataSets(report) {
  const s = report.summary;
  const p = report.profitLoss;
  return [
    ['ملخص', [['المؤشر', 'القيمة'], ['عدد الفواتير', s.count], ['الإجمالي الفرعي', s.subtotal], ['الضريبة', s.tax], ['إجمالي المبيعات', s.total], ['من', report.range.from], ['إلى', report.range.to]]],
    ['الأصناف الأكثر مبيعاً', [['المنتج', 'الكمية', 'الإجمالي'], ...report.topProducts.map((p) => [p.name, p.qty, p.total])]],
    ['المبيعات اليومية', [['التاريخ', 'عدد الفواتير', 'الإجمالي'], ...report.daily.map((d) => [d.day, d.count, d.total])]],
    ['التوصيل', [['المندوب', 'عدد الطلبات', 'رسوم التوصيل'], ...report.delivery.byPerson.map((p) => [p.deliveryPerson, p.orderCount, p.deliveryFees])]],
    ['الربح والخسارة', [['المؤشر', 'القيمة'], ['صافي الإيراد', p.netRevenue], ['تكلفة المنتجات المباعة', p.cost], ['قيمة المرتجعات', p.returnsRevenue], ['الربح الإجمالي (قبل الرواتب)', p.grossProfit], ['مصروف الرواتب', p.payrollExpense], ['صافي الربح (بعد الرواتب)', p.netProfit], ['هامش الربح %', p.marginPercent]]],
    ['الأصناف الأكثر ربحاً', [['المنتج', 'الكمية', 'الإيراد', 'التكلفة', 'الربح'], ...p.byProduct.map((item) => [item.name, item.qty, item.revenue, item.cost, item.profit])]],
  ];
}
async function exportWorkbook(filePath, report) {
  const sheets = dataSets(report);
  const entries = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map(([name], i) => `<sheet name="${xml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf xfId="0" applyAlignment="1"><alignment horizontal="right"/></xf></cellXfs></styleSheet>`],
    ...sheets.map(([, rows], i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(rows)]),
  ];
  fs.writeFileSync(filePath, zip(entries));
}
function reportHtml(report) {
  const rows = dataSets(report).map(([title, values]) => `<section><h2>${xml(title)}</h2><table>${values.map((row, i) => `<tr>${row.map((v) => `<${i ? 'td' : 'th'}>${xml(v)}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table></section>`).join('');
  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><style>@page{size:A4 landscape;margin:14mm}body{font-family:Arial,sans-serif;color:#172033;direction:rtl}h1{color:#1d4ed8}section{break-inside:avoid;margin:16px 0}h2{font-size:16px;background:#eef4ff;padding:8px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #cbd5e1;padding:7px;text-align:right}th{background:#2563eb;color:#fff}</style></head><body><h1>تقرير المبيعات</h1><p>الفترة: ${xml(report.range.from)} - ${xml(report.range.to)}</p>${rows}</body></html>`;
}

function exportPayrollWorkbook(filePath, report) {
  const rows = [
    ['مسير الرواتب', report.monthKey],
    ['الحالة', report.status],
    [],
    ['الموظف','الوظيفة','الهوية/الإقامة','القسم','طريقة الأجر','الأجر','الأساسي','الغياب','خصم الغياب','المكافآت','الخصومات','السلف','الإضافي','الصافي','الدين المرحّل','المدفوع','المتبقي','الحالة'],
    ...report.rows.map(r=>[r.fullName,r.jobTitle,r.nationalId,r.department,r.payType,r.payRate,r.base,r.absence,r.absenceDeduction,r.bonuses,r.deductions,r.advances,r.overtime,r.net,r.debtCarry,r.paid,r.remaining,r.status])
  ];
  const sheets=[['مسير الرواتب',rows]];
  const entries=[
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="مسير الرواتب" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf xfId="0" applyAlignment="1"><alignment horizontal="right"/></xf></cellXfs></styleSheet>`],
    ['xl/worksheets/sheet1.xml', sheetXml(rows)]
  ];
  fs.writeFileSync(filePath, zip(entries));
}

module.exports = { exportWorkbook, reportHtml, exportPayrollWorkbook };
