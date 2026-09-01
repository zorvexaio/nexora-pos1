'use strict';
const { parseGs1 } = require('../database/gs1-barcode');
const gs = String.fromCharCode(29);
const value = parseGs1('01012345678901211727010110LOT-ABC' + gs + '21SER123');
if (value.gtin !== '01234567890121') throw new Error('GTIN parse failed');
if (value.expiryDate !== '270101') throw new Error('expiry date parse failed');
if (value.lot !== 'LOT-ABC') throw new Error('lot parse failed');
if (value.serial !== 'SER123') throw new Error('serial parse failed');
console.log('GS1 regression: PASS');
