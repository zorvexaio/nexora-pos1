const assert=require('assert');
const money=require('../core/money');
function eq(a,b,m){assert.strictEqual(a,b,m);}
// Independent integer reference (half-up), does not call core/money.
function refTax(gross,rate,inclusive){
  if(!rate) return 0;
  const den=inclusive?100+rate:100;
  return Math.floor((gross*rate*2+den)/(2*den));
}
// Standard tax-inclusive extraction: tax = gross * rate / (100 + rate).
const GROSSES=[1,5,49,99,999,1234,9999,10000,45000,123457,99999999];
let combos=0;
for(const rate of [0,5,10,15]){
  for(const gross of GROSSES){
    const tax=money.taxMinor(gross,rate,true);
    const net=gross-tax;
    eq(tax,refTax(gross,rate,true),`inclusive tax ${rate}% on ${gross}`);
    eq(net+tax,gross,`inclusive balance ${rate}% on ${gross}`);
    // Rounding can move the inverse by at most one minor unit; it must never drift further.
    assert.ok(Math.abs(money.taxMinor(net,rate,false)-tax)<=1,`inclusive/exclusive inverse within 1 unit ${rate}% on ${gross}`);
    const exTax=money.taxMinor(gross,rate,false);
    eq(exTax,refTax(gross,rate,false),`exclusive tax ${rate}% on ${gross}`);
    eq(gross+exTax,gross+refTax(gross,rate,false),`exclusive total ${rate}% on ${gross}`);
    combos++;
  }
}
// Review example: 450.00 inclusive @10% -> net 409.09 + tax 40.91 (NOT 405 + 45).
eq(money.taxMinor(45000,10,true),4091,'450 inclusive @10% tax');
eq(45000-money.taxMinor(45000,10,true),40909,'450 inclusive @10% net');
// Exclusive keeps the "add on top" behaviour.
eq(money.taxMinor(45000,10,false),4500,'450 exclusive @10% tax added on top');
// 0% never produces tax in either mode.
eq(money.taxMinor(123457,0,true),0,'0% inclusive');
eq(money.taxMinor(123457,0,false),0,'0% exclusive');
console.log(`TAX INCLUSIVE REGRESSION: PASS (${combos} rate x amount combos, inclusive + exclusive)`);
