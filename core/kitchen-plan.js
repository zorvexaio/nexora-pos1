'use strict';

// قرار طباعة تذكرة المطبخ عند حفظ طلب طاولة.
// setOpenSaleItems يُرجع kitchenDelta (ما تغيّر عمّا وصل للمطبخ فعلاً) و kitchenFirst (لم يصل شيء بعد).
//  - لا تغيير            -> لا تذكرة (حفظ متكرر بلا تعديل لا يطبع شيئاً)
//  - أول إرسال للطلب      -> تذكرة كاملة
//  - تعديلات لاحقة        -> تذكرة "تعديل" تحتوي الإضافات/الإلغاءات/تغيير الملاحظات فقط
function planKitchenTicket(saveResult) {
  const delta = Array.isArray(saveResult && saveResult.kitchenDelta) ? saveResult.kitchenDelta : [];
  if (delta.length === 0) return { action: 'none' };
  if (saveResult.kitchenFirst) return { action: 'full' };
  return { action: 'delta', items: delta };
}

module.exports = { planKitchenTicket };
