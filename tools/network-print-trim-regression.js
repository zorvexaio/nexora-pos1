// Kitchen paper waste (network printers): the raster image must be cropped below the last inked row.
// Runs without Electron: `electron` is stubbed and a fake NativeImage is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { nativeImage: {} };
  return originalLoad.apply(this, arguments);
};
const { trimRasterBottom, buildFullPrintJob } = require('../lib/network-print');

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; console.log('PASS:', m); };

// fake image: white with black pixels in the given rows
function fakeImage(width, height, inkRows) {
  const bitmap = Buffer.alloc(width * height * 4, 255); // opaque white (BGRA)
  for (const y of inkRows) for (let x = 0; x < width; x++) { const o = (y * width + x) * 4; bitmap[o] = 0; bitmap[o + 1] = 0; bitmap[o + 2] = 0; bitmap[o + 3] = 255; }
  return { getSize: () => ({ width, height }), resize: () => { throw new Error('no resize expected'); }, toBitmap: () => bitmap };
}
// ESC @ (2 bytes) + ESC a 1 (3 bytes) then GS v 0 m xL xH yL yH
const rasterHeight = (job) => { assert.deepEqual([...job.subarray(5, 9)], [0x1d, 0x76, 0x30, 0x00]); return job[11] + (job[12] << 8); };

(async () => {
  // pure helper
  const bytesPerRow = 4;
  const raster = Buffer.alloc(bytesPerRow * 50, 0);
  raster[3 * bytesPerRow + 1] = 0x10; // ink in row 3
  const t = trimRasterBottom(raster, bytesPerRow, 50, 8);
  ok(t.height === 12 && t.raster.length === 12 * bytesPerRow, 'trim keeps the last inked row + 8 margin rows (row 3 -> 12 rows)');
  ok(trimRasterBottom(Buffer.alloc(bytesPerRow * 50, 0), bytesPerRow, 50, 8).height === 1, 'fully blank image collapses to a single row');
  const full = Buffer.alloc(bytesPerRow * 10, 0); full[9 * bytesPerRow] = 1;
  ok(trimRasterBottom(full, bytesPerRow, 10, 8).height === 10, 'ink on the last row: nothing is cut');

  // whole print job: one-item kitchen ticket = 24 inked rows inside a 400-row capture
  const image = fakeImage(64, 400, Array.from({ length: 24 }, (_, i) => 10 + i)); // ink rows 10..33
  const untrimmed = await buildFullPrintJob(image, { dotsWidth: 576, feedLinesAfter: 1 });
  const trimmed = await buildFullPrintJob(image, { dotsWidth: 576, feedLinesAfter: 1, trimBottom: true });
  ok(rasterHeight(untrimmed) === 400, 'without trimming the whole 400-row capture is printed (the old paper waste)');
  ok(rasterHeight(trimmed) === 42, 'with trimming only rows up to the last ink + margin are printed (34 + 8 = 42)');
  ok(trimmed.length < untrimmed.length / 5, 'the trimmed job is much smaller than the untrimmed one');
  const tail = [...trimmed.subarray(trimmed.length - 5)];
  ok(tail[0] === 0x0a && tail[1] === 0x1d && tail[2] === 0x56, 'job still ends with 1 line feed then the cutter command (no extra feed)');

  // wiring: kitchen only
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/trimBottom: modePrefix === 'kitchen'/.test(main), "main.js trims the network raster for the kitchen printer only");
  ok(/'kitchen', \{ paperWidth: width \}, 1\)/.test(main), 'kitchen ticket feed after content is 1 line (<= 1 as required)');
  console.log(`NETWORK PRINT TRIM REGRESSION: PASS (${checks} checks)`);
})().catch((e) => { console.error(e); process.exit(1); });
