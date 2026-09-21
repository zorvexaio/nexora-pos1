let currentSale = null;
let modifySale = null;
let modifyCart = [];
let modifyBundles = [];
let modifyCategories = [];
let modifyCategoryId = null;
let modifyGlobalTaxMode = 'exclusive';
let modifyMinorUnit = 2;
let modifyProductCatalog = [];

const $ = (id) => document.getElementById(id);
const saleIdInput = $('saleIdInput');
const loadSaleBtn = $('loadSaleBtn');
const saleReturnPanel = $('saleReturnPanel');
const saleIdLabel = $('saleIdLabel');
const returnItemsBody = $('returnItemsBody');
const returnReasonInput = $('returnReasonInput');
const refundMethodSelect = $('refundMethodSelect');
const refundTotalPreview = $('refundTotalPreview');
const confirmReturnBtn = $('confirmReturnBtn');
const modifyCategoryTabs = $('modifyCategoryTabs');
const modifyDiscountType = $('modifyDiscountType');
const modifyDiscountValue = $('modifyDiscountValue');

const tr = {
  ar:{search:'بحث',cash:'نقداً',card:'بطاقة',mixed:'مختلط',credit:'آجل',modify:'تعديل',ret:'مرتجع',noSales:'لا توجد فواتير مطابقة',saved:'تم تعديل الفاتورة بنجاح بدون إنشاء فاتورة جديدة.',reason:'سبب التعديل مطلوب.'},
  en:{search:'Search',cash:'Cash',card:'Card',mixed:'Mixed',credit:'Credit',modify:'Modify',ret:'Return',noSales:'No matching sales',saved:'Sale modified successfully without creating a new invoice.',reason:'Modification reason is required.'},
  tr:{search:'Ara',cash:'Nakit',card:'Kart',mixed:'Karma',credit:'Veresiye',modify:'Düzenle',ret:'İade',noSales:'Eşleşen satış yok',saved:'Satış yeni fatura oluşturmadan başarıyla düzenlendi.',reason:'Düzenleme nedeni gerekli.'}
};
function lang(){return document.documentElement.getAttribute('data-lang')||'ar';}
function L(k){return tr[lang()]?.[k]||tr.ar[k]||k;}
function M(k,fallback){try{return typeof t==='function'?t(k,fallback):fallback;}catch{return fallback;}}

let canRefund=true;
async function init(){
  // المدير/الأدمن كالمعتاد؛ والكاشير الذي فعّل له المدير العام علامة "تعديل الفواتير" يدخل للتعديل فقط (بدون ارتجاع).
  const user=await guardPage(['admin','manager'],'../login.html',{allowIf:(u)=>Number(u.can_modify_sales)===1}); if(!user)return;
  canRefund=['admin','manager'].includes(user.role);
  if(!canRefund){ document.getElementById('saleReturnSection')?.classList.add('hidden'); }
  const branch=await window.api.branches.current(); $('branchName').textContent=branch?branch.name:'';
  loadSaleBtn.addEventListener('click',loadSale);
  $('salesSearchInput').addEventListener('input',renderSalesList);
  $('closeModifyBtn').addEventListener('click',()=>{$('modifyPanel').classList.add('hidden');modifySale=null;});
  $('modifyProductSearch').addEventListener('input',loadModifyProducts);
  $('modifyProductSearch').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();loadModifyProducts();}});
  modifyDiscountType.addEventListener('change',()=>{modifyDiscountValue.disabled=modifyDiscountType.value==='none';if(modifyDiscountType.value==='none')modifyDiscountValue.value=0;renderModifyCart();});
  modifyDiscountValue.addEventListener('input',renderModifyCart);
  try { const gp=await window.api.global.get(); modifyGlobalTaxMode=gp?.tax_mode||'exclusive'; const mu=Number(gp?.currency_minor_unit); modifyMinorUnit=Number.isInteger(mu)&&mu>=0&&mu<=3?mu:2; } catch { modifyGlobalTaxMode='exclusive'; modifyMinorUnit=2; }
  try { modifyCategories=(await window.api.categories.list()).filter(c=>!c.pos_hidden); } catch { modifyCategories=[]; }
  $('saveModifyBtn').addEventListener('click',saveModification);
  $('closePaymentModify').addEventListener('click',()=>$('paymentModifyModal').classList.add('hidden'));
  $('paymentModifyMethod').addEventListener('change',updatePaymentFields);
  confirmReturnBtn.addEventListener('click',submitReturn);
  await renderSalesList();
}

async function renderSalesList(){
  const q=normalizeDigits(($('salesSearchInput').value||'').trim()).toLowerCase();
  // فقط الفواتير المكتملة والمرتجعة جزئياً (لا طلبات مفتوحة ولا ملغاة ولا مرتجعة بالكامل). البحث من الخادم فيصل لأي فاتورة قديمة.
  const filtered=(await window.api.sales.list({statuses:['completed','partially_refunded'],search:q})).slice(0,100);
  const payLabel=(m)=>({cash:ts('نقدي'),card:ts('بطاقة'),mixed:ts('مختلط'),credit:ts('آجل')}[m]||m||'');
  $('salesManageList').innerHTML=filtered.length?filtered.map(s=>`<div class="returns-sale-row"><div><strong>${escapeHtml(s.invoice_number||s.id)}</strong><small>${escapeHtml(s.created_at||'')} ${s.customer_name?` · ${escapeHtml(s.customer_name)}`:''} · ${escapeHtml(payLabel(s.payment_method))}${s.status==='partially_refunded'?` · ${escapeHtml(ts('مرتجعة جزئياً'))}`:''}</small></div><div><b>${Number(s.grand_total||0).toFixed(2)}</b><button class="btn btn-secondary btn-sm" data-paymodify="${s.id}">${L('modify')} ${lang()==='ar'?'الدفع':lang()==='tr'?'Ödeme':'Payment'}</button><button class="btn btn-secondary btn-sm" data-modify="${s.id}">${L('modify')}</button>${canRefund?`<button class="btn btn-danger btn-sm" data-return="${s.invoice_number||''}">${L('ret')}</button>`:''}</div></div>`).join(''):`<div class="drawer-empty">${L('noSales')}</div>`;
  $('salesManageList').querySelectorAll('[data-modify]').forEach(b=>b.addEventListener('click',()=>openModifier(Number(b.dataset.modify))));
  $('salesManageList').querySelectorAll('[data-paymodify]').forEach(b=>b.addEventListener('click',()=>openPaymentModifier(Number(b.dataset.paymodify))));
  $('salesManageList').querySelectorAll('[data-return]').forEach(b=>b.addEventListener('click',()=>{saleIdInput.value=b.dataset.return;loadSale();window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'});}));
}

async function openPaymentModifier(id){
  const sale=await window.api.sales.get(id); if(!sale)return;
  $('paymentModifyModal').classList.remove('hidden');$('paymentModifyInvoice').textContent=sale.invoice_number||sale.id;
  $('paymentModifyMethod').value=sale.payment_method||'cash';$('paymentModifyCash').value=Number(sale.cash_amount||0);$('paymentModifyCard').value=Number(sale.card_amount||0);$('paymentModifyReason').value='';
  updatePaymentFields();
  $('savePaymentModify').onclick=async()=>{const reason=$('paymentModifyReason').value.trim();if(!reason){showToast(L('reason'),'error');return;}const method=$('paymentModifyMethod').value;try{const r=await window.api.sales.correctPaymentMethod({saleId:id,newMethod:method,cashAmount:Number($('paymentModifyCash').value||0),cardAmount:Number($('paymentModifyCard').value||0),reason});$('paymentModifyModal').classList.add('hidden');showToast(lang()==='ar'?'تم تصحيح طريقة الدفع بدون إنشاء فاتورة جديدة.':lang()==='tr'?'Ödeme yöntemi yeni fatura oluşturmadan düzeltildi.':'Payment method corrected without creating a new invoice.','success');if(r.relatedShiftClosed)showToast(lang()==='ar'?'الوردية الأصلية مغلقة: تم حفظ التصحيح في التدقيق فقط.':lang()==='tr'?'Orijinal vardiya kapalı: düzeltme yalnızca denetime kaydedildi.':'Original shift is closed: the correction was audit-only.','warning');await renderSalesList();}catch(e){showToast(e.message||String(e),'error');}};
}
function updatePaymentFields(){const m=$('paymentModifyMethod').value;const mixed=m==='mixed';$('paymentMixedFields').classList.toggle('hidden',!mixed);$('paymentCardField').classList.toggle('hidden',!mixed);}

async function openModifier(id){
  modifySale=await window.api.sales.get(id); if(!modifySale) return;
  modifyCart=modifySale.items.map(i=>({productId:i.product_id,name:i.product_name,quantity:Number(i.quantity),price:Number(i.unit_price),taxRate:Number(i.tax_rate||0),taxInclusive:Number(i.tax_inclusive||0)===1,notes:i.notes||'',categoryId:i.category_id||null}));
  modifyCategoryId=null;
  modifyDiscountType.value=modifySale.discount_type||'none';
  modifyDiscountValue.value=Number(modifySale.discount_value||0);
  modifyDiscountValue.disabled=modifyDiscountType.value==='none';
  $('modifyInvoiceLabel').textContent=modifySale.invoice_number||modifySale.id;
  $('modifyReasonInput').value=''; $('modifyPanel').classList.remove('hidden');
  modifyBundles=await window.api.bundles.listActive(); renderModifyCart(); await loadModifyProducts();
  $('modifyPanel').scrollIntoView({behavior:'smooth',block:'start'});
}

async function loadModifyProducts(){
  const q=($('modifyProductSearch').value||'').trim();
  const products=await window.api.products.list({search:q,categoryId:(!q&&modifyCategoryId)?modifyCategoryId:undefined,topLevelOnly:!q,limit:q?80:120});
  modifyProductCatalog=products;
  renderModifyCategoryTabs();
  $('modifyProductGrid').innerHTML=products.map(p=>`<button class="modify-product-card" data-pid="${p.id}"><strong>${escapeHtml(p.name)}</strong><span>${Number(p.price||0).toFixed(2)}</span></button>`).join('');
  $('modifyProductGrid').querySelectorAll('[data-pid]').forEach(b=>b.addEventListener('click',()=>addModifyProduct(Number(b.dataset.pid),b.querySelector('strong').textContent)));
  $('modifyBundleList').innerHTML=modifyBundles.map(b=>`<button class="modify-bundle" data-bid="${b.id}">${escapeHtml(b.name)}</button>`).join('');
  $('modifyBundleList').querySelectorAll('[data-bid]').forEach(b=>b.addEventListener('click',()=>addBundle(Number(b.dataset.bid))));
}
function renderModifyCategoryTabs(){
  if(!modifyCategoryTabs)return;
  modifyCategoryTabs.innerHTML=[`<button type="button" class="modify-category-tab ${!modifyCategoryId?'active':''}" data-cat="">${escapeHtml(M('returns.allCategories','الكل'))}</button>`,...modifyCategories.map(c=>`<button type="button" class="modify-category-tab ${Number(modifyCategoryId)===Number(c.id)?'active':''}" data-cat="${c.id}">${escapeHtml(c.name)}</button>`)].join('');
  modifyCategoryTabs.querySelectorAll('[data-cat]').forEach(b=>b.addEventListener('click',()=>{modifyCategoryId=b.dataset.cat?Number(b.dataset.cat):null;loadModifyProducts();}));
}
function addModifyProduct(productId,name,fallbackPrice=0){
  const p=modifyProductCatalog.find(x=>Number(x.id)===productId)||null;
  const x=modifyCart.find(i=>i.productId===productId);
  if(x){x.quantity+=1;}
  else modifyCart.push({productId,name,quantity:1,price:Number(p?.price ?? fallbackPrice ?? 0),taxRate:Number((p?.tax_profile_rate ?? p?.tax_rate ?? 0)),taxInclusive:p?.tax_profile_rate!=null?Number(p.tax_profile_inclusive)===1:modifyGlobalTaxMode==='inclusive',notes:'',categoryId:p?.category_id||null});
  renderModifyCart();
}
function addBundle(id){
  const b=modifyBundles.find(x=>Number(x.id)===id);if(!b)return;
  for(const i of (b.items||[])) addModifyProduct(Number(i.product_id),i.product_name,Number(i.price||0));
  renderModifyCart();
}
function bundleDiscountPreview(){
  if(!modifyBundles.length || !modifyCart.length) return 0;
  const remaining=new Map(modifyCart.map(i=>[Number(i.productId),Number(i.quantity||0)]));
  let total=0;
  for(const b of modifyBundles){
    const items=b.items||[]; if(!items.length) continue;
    let applications=Infinity;
    for(const item of items){const available=remaining.get(Number(item.product_id))||0;applications=Math.min(applications,Math.floor(available/Number(item.quantity||1)));}
    if(!Number.isFinite(applications)||applications<1) continue;
    const subtotal=items.reduce((n,i)=>n+Number(i.price||0)*Number(i.quantity||0),0);
    const d=b.discount_type==='fixed_price'?Math.max(0,subtotal-Number(b.discount_value||0)):subtotal*(Math.min(Math.max(Number(b.discount_value||0),0),100)/100);
    total+=d*applications;
    for(const item of items) remaining.set(Number(item.product_id),(remaining.get(Number(item.product_id))||0)-Number(item.quantity||0)*applications);
  }
  return Math.max(0,total);
}
function renderModifyCart(){
  const { subtotal: netSubtotal, tax: taxTotal } = sumCartTax(modifyCart, modifyMinorUnit);
  const type=modifyDiscountType.value;const value=Number(modifyDiscountValue.value||0);const discount=type==='percent'?netSubtotal*(Math.min(value,100)/100):type==='fixed'?Math.min(value,netSubtotal):0;
  const bundleDiscount=bundleDiscountPreview();
  const total=Math.max(0,netSubtotal+taxTotal-discount-bundleDiscount+Number(modifySale?.delivery_fee||0)-Number(modifySale?.loyalty_redeemed_value||0));
  $('modifyCart').innerHTML=modifyCart.length?modifyCart.map((i,idx)=>`<div class="modify-cart-row"><div><strong>${escapeHtml(i.name)}</strong><small>${Number(i.price||0).toFixed(2)}</small></div><input type="number" min="0" step="0.001" value="${i.quantity}" data-qty="${idx}"><button class="btn btn-danger btn-sm" data-del="${idx}">×</button></div>`).join(''):'<div class="drawer-empty">—</div>';
  $('modifyCart').querySelectorAll('[data-qty]').forEach(e=>e.addEventListener('change',()=>{const i=modifyCart[Number(e.dataset.qty)];i.quantity=Math.max(0,Number(e.value)||0);renderModifyCart();}));
  $('modifyCart').querySelectorAll('[data-del]').forEach(e=>e.addEventListener('click',()=>{modifyCart.splice(Number(e.dataset.del),1);renderModifyCart();}));
  $('modifyTotals').innerHTML=`<div>${escapeHtml(M('returns.netItems','صافي الأصناف'))}: <b>${netSubtotal.toFixed(2)}</b></div><div>${escapeHtml(M('returns.tax','الضريبة'))}: <b>${taxTotal.toFixed(2)}</b></div><div>${escapeHtml(M('returns.modifyDiscount','الخصم'))}: <b>-${(discount+bundleDiscount).toFixed(2)}</b></div><div class="strong">${escapeHtml(M('returns.total','الإجمالي'))}: <b>${total.toFixed(2)}</b></div>`;
}
async function saveModification(){
  if(!modifySale||!modifyCart.length){showToast(L('reason'),'error');return;}
  const reason=$('modifyReasonInput').value.trim();if(!reason){showToast(L('reason'),'error');return;}
  if(!(await confirmDialog(`${L('modify')} ${modifySale.invoice_number||modifySale.id}?`,{tone:'warning'})))return;
  $('saveModifyBtn').disabled=true;
  try{const result=await window.api.sales.modifyItems({saleId:modifySale.id,items:modifyCart.filter(i=>Number(i.quantity)>0).map(i=>({productId:i.productId,quantity:i.quantity,notes:i.notes})),reason,bundleIds:modifyBundles.filter(b=>modifyCart.some(i=>(b.items||[]).some(x=>Number(x.product_id)===Number(i.productId)))).map(b=>b.id),discountType:modifyDiscountType.value,discountValue:Number(modifyDiscountValue.value||0)});showToast(L('saved'),'success');if(result.printOutcome?.kitchenDelta?.success===false)showToast(`${M('returns.deltaPrintFailed','تعذر طباعة تعديل المطبخ')}: ${(result.printOutcome.kitchenDelta.reason||'Error')}`,'error');$('modifyPanel').classList.add('hidden');await renderSalesList();}catch(e){showToast(e.message||String(e),'error');}finally{$('saveModifyBtn').disabled=false;}
}

async function loadSale(){
  const invoiceNumber=normalizeDigits(saleIdInput.value.trim());if(!invoiceNumber)return;
  const sale=await window.api.returns.saleForReturn(invoiceNumber);
  if(!sale){showToast(ts('لا توجد فاتورة بهذا الرقم'),'error');saleReturnPanel.classList.add('hidden');return;}
  currentSale=sale;saleIdLabel.textContent=sale.invoice_number||sale.id;renderItems();saleReturnPanel.classList.remove('hidden');
}
function renderItems(){
  returnItemsBody.innerHTML='';
  for(const item of currentSale.items){const maxReturnable=item.quantity-item.already_returned;const fractional=['kg','liter'].includes(item.unit);const step=fractional?'0.001':'1';const row=document.createElement('tr');row.innerHTML=`<td>${escapeHtml(item.product_name)}</td><td>${item.quantity}</td><td>${item.already_returned}</td><td><input type="text" inputmode="decimal" min="0" max="${maxReturnable}" step="${step}" value="0" data-sale-item-id="${item.id}" data-unit-price="${item.unit_price}" style="width:80px;" ${maxReturnable<=0?'disabled':''}/></td><td>${item.unit_price.toFixed(2)}</td>`;returnItemsBody.appendChild(row);}
  returnItemsBody.querySelectorAll('input').forEach(el=>el.addEventListener('input',updatePreview));updatePreview();
}
function updatePreview(){let total=0;returnItemsBody.querySelectorAll('input').forEach(el=>{total+=(parseLocaleNumber(el.value)||0)*parseFloat(el.dataset.unitPrice);});refundTotalPreview.textContent=`${t('returns.refundTotal','إجمالي الاسترداد')}: ${total.toFixed(2)}`;}
async function submitReturn(){
  const items=[];returnItemsBody.querySelectorAll('input').forEach(el=>{const qty=parseLocaleNumber(el.value)||0;if(qty>0)items.push({saleItemId:parseInt(el.dataset.saleItemId,10),quantity:qty});});
  if(!items.length){showToast(ts('حدد كمية إرجاع لصنف واحد على الأقل'),'error');return;}
  if(!(await confirmDialog(ts('هل تريد تنفيذ هذا المرتجع؟ سيتم إرجاع الكمية للمخزون تلقائياً.'),{tone:'warning'})))return;
  confirmReturnBtn.disabled=true;try{const result=await window.api.returns.create({saleId:currentSale.id,items,reason:returnReasonInput.value.trim(),refundMethod:refundMethodSelect.value,clientRequestId:(crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random()}`)});showToast(`${t('returns.success','تم تنفيذ المرتجع بنجاح. المبلغ المسترد')}: ${result.totalRefunded.toFixed(2)}`,'success');saleReturnPanel.classList.add('hidden');saleIdInput.value='';await renderSalesList();}catch(err){showToast(ts('حدث خطأ: ')+err.message,'error');}finally{confirmReturnBtn.disabled=false;}
}
init();
