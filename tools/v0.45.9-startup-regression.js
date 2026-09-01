const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const db=fs.readFileSync(path.join(root,'database','db.js'),'utf8');
const main=fs.readFileSync(path.join(root,'main.js'),'utf8');
if(!/function\s+setUserShiftType\s*\(/.test(db)) throw new Error('setUserShiftType implementation missing');
if(!/setUserShiftType,/.test(db)) throw new Error('setUserShiftType export missing');
if(!/db\.setUserShiftType\(userId, shiftType\)/.test(main)) throw new Error('IPC handler not wired');
console.log('v0.45.9 startup regression: PASS');
