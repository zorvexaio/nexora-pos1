#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const settings = fs.readFileSync(path.join(root, 'renderer', 'pages', 'settings.js'), 'utf8');
const pos = fs.readFileSync(path.join(root, 'renderer', 'pos.js'), 'utf8');
const db = fs.readFileSync(path.join(root, 'database', 'db.js'), 'utf8');

assert.match(settings, /data-remove-cat="\$\{c\.id\}"/, 'A category with an image must expose a remove action.');
assert.match(settings, /categories\.setImage\(categoryId, null\)/, 'Removing an image must clear the stored image path.');
assert.match(db, /UPDATE categories SET image_path=\? WHERE id=\?'\)\.run\(imagePath \|\| null/, 'The database must persist an empty image as NULL.');
assert.match(pos, /c\.image_path[\s\S]*?: `<span class="category-tab-icon"/, 'Image-free categories must retain their cashier tab fallback.');

console.log('CATEGORY IMAGE REMOVAL REGRESSION: PASS (removal and no-image cashier tab fallback)');
