import { test } from 'node:test';
import assert from 'node:assert/strict';
import { page, productGrid } from './helpers.js';

test('cssEscape handles ids that start with digits and special characters', () => {
  // Expected values follow the CSSOM spec (same output as the browser's CSS.escape).
  const { K } = page('');
  assert.equal(K.cssEscape('123-grid'), '\\31 23-grid');
  assert.equal(K.cssEscape('a:b.c'), 'a\\:b\\.c');
  assert.equal(K.cssEscape('w-1/2'), 'w-1\\/2');
  assert.equal(K.cssEscape('-5'), '-\\35 ');
  assert.equal(K.cssEscape('-'), '\\-');
});

test('uniqueSelector never produces invalid selectors and is unique', () => {
  const { K, document, $$ } = page(`
    <div id="123-grid"><span class="x">a</span><span class="x">b</span></div>
    <div id=":r1:"><p>one</p><p>two</p></div>
    <ul><li class="w-1/2 hover:bg-red">x</li><li class="w-1/2">y</li></ul>`);
  for (const el of $$('body *')) {
    const sel = K.uniqueSelector(el);
    const found = document.querySelectorAll(sel);
    assert.equal(found.length, 1, `selector ${sel} should be unique`);
    assert.equal(found[0], el);
  }
});

test('uniqueSelector prefers ids, test attributes and semantic classes', () => {
  const { K, $ } = page(`
    <form><input name="email"><button data-testid="submit-btn">Go</button></form>
    <div id="main"><span class="price">1</span></div>
    <div class="css-1x2y3z4 sc-bdVaJa"><em>dyn</em></div>`);
  assert.equal(K.uniqueSelector($('input')), 'input[name="email"]');
  assert.equal(K.uniqueSelector($('button')), 'button[data-testid="submit-btn"]');
  assert.equal(K.uniqueSelector($('#main')), 'div#main');
  assert.equal(K.uniqueSelector($('.price')), 'span.price');
  assert.ok(!K.uniqueSelector($('em')).includes('css-1x2y3z4'));
});

test('optimizeModel leaves no ticked attributes on skipped nodes', () => {
  const { K, document } = page(`<main id="main"><div class="grid">${'<div class="col"><article class="card"><span class="price">1</span></article></div>'.repeat(4)}</div></main>`);
  const el = document.querySelectorAll('.price')[2];
  const model = K.optimizeModel(K.buildModel(el), el);
  for (const node of model) if (!node.on) assert.ok(node.parts.every((p) => !p.on), node.label);
  const sel = K.compileModel(model);
  assert.equal(document.querySelectorAll(sel).length, 1, sel);
  assert.equal(document.querySelector(sel), el);
  assert.ok(sel.includes('.price'), sel);
});

test('classKind recognises state, hashed and utility classes', () => {
  const { K } = page('');
  assert.equal(K.classKind('active'), 'state');
  assert.equal(K.classKind('is-open'), 'state');
  assert.equal(K.classKind('css-1q2w3e'), 'dynamic');
  assert.equal(K.classKind('Card_title__a1B2c'), 'dynamic');
  assert.equal(K.classKind('kQXRfa'), 'dynamic');
  assert.equal(K.classKind('mt-4'), 'utility');
  assert.equal(K.classKind('md:flex'), 'utility');
  assert.equal(K.classKind('product-card'), 'semantic');
  assert.equal(K.classKind('price'), 'semantic');
});

test('selector model compiles to CSS and to XPath when text is enabled', () => {
  const { K, $, document } = page('<div class="pager"><a class="btn" href="/2">Next</a><a class="btn" href="/1">Prev</a></div>');
  const el = $('a');
  const model = K.optimizeModel(K.buildModel(el), el);
  const css = K.compileModel(model);
  assert.equal(document.querySelectorAll(css)[0], el);
  // Switch to a text based selector, like UiPath's aaname
  model.forEach((n) => { n.on = false; n.parts.forEach((p) => { p.on = false; }); });
  const last = model[model.length - 1];
  last.on = true;
  last.parts.find((p) => p.k === 'tag').on = true;
  last.parts.find((p) => p.k === 'text').on = true;
  const xp = K.compileModel(model);
  assert.equal(xp, "//a[normalize-space(.)='Next']");
  assert.deepEqual([...K.queryAll(xp, document)], [el]);
});

test('xpathFor anchors on stable ids and resolves back to the element', () => {
  const { K, $, document } = page('<div id="app"><ul><li>a</li><li><b>b</b></li></ul></div><svg><g><path d="M0"/><path d="M1"/></g></svg>');
  const b = $('b');
  assert.equal(K.xpathFor(b), "//*[@id='app']/ul/li[2]/b");
  assert.deepEqual([...K.queryAll(K.xpathFor(b), document)], [b]);
  // jsdom's XPath engine lacks local-name(); resolution is covered by the e2e suite in Chromium.
  const path = document.querySelectorAll('path')[1];
  assert.equal(K.xpathFor(path), "/html/body/*[local-name()='svg']/*[local-name()='g']/*[local-name()='path'][2]");
});

test('detectList finds product cards from a click on a title', () => {
  const { K, $, document } = page(productGrid(6));
  const title = document.querySelectorAll('.product-title a')[2];
  const res = K.detectList(title);
  const rows = K.queryAll(res.rowSelector, document);
  assert.equal(rows.length, 6, res.rowSelector);
  assert.ok(rows.every((r) => r.classList.contains('product-card')));
  assert.ok(res.levels.length >= 1);
  assert.ok($('.grid'));
});

test('detectList on a table picks data rows and skips the header row', () => {
  const { K, document } = page(`
    <table><tbody>
      <tr><th>Name</th><th>Age</th><th>City</th></tr>
      <tr><td>Ann</td><td>31</td><td>Bern</td></tr>
      <tr><td>Bob</td><td>42</td><td>Basel</td></tr>
      <tr><td>Cid</td><td>25</td><td>Zug</td></tr>
    </tbody></table>`);
  const cell = document.querySelectorAll('td')[4];
  const res = K.detectList(cell);
  const rows = K.queryAll(res.rowSelector, document);
  assert.equal(rows.length, 3, res.rowSelector);
  const cols = K.detectColumns(rows, { isVisible: null });
  assert.deepEqual([...cols.map((c) => c.name)], ['Name', 'Age', 'City']);
  const data = K.extract({ rowSelector: res.rowSelector, columns: cols }, document);
  assert.deepEqual([...data.rows[1]], ['Bob', '42', 'Basel']);
});

test('detectColumns yields consistent, aligned columns even with missing fields', () => {
  const { K, document } = page(productGrid(6));
  const rows = [...document.querySelectorAll('.product-card')];
  const cols = K.detectColumns(rows, { isVisible: null });
  const names = cols.map((c) => c.name);
  assert.ok(names.includes('Product Title'), names.join());
  assert.ok(names.includes('Price'), names.join());
  assert.ok(names.some((n) => /image|thumb/i.test(n)), names.join());
  const data = K.extract({ rowSelector: '.grid > article', columns: cols }, document);
  assert.equal(data.rows.length, 6);
  const priceIdx = names.indexOf('Price');
  assert.deepEqual([...data.rows.map((r) => r[priceIdx])], ['$10.00', '$20.00', '$30.00', '$40.00', '$50.00', '$60.00']);
  const titleIdx = names.indexOf('Product Title');
  assert.equal(data.rows[3][titleIdx], 'Product 4');
  // The single "Sale" badge is in only 1 of 6 rows: below the fill threshold.
  assert.ok(!names.includes('Badge'));
  // Inline formatting stays in one value.
  const descIdx = names.indexOf('Description');
  assert.ok(descIdx >= 0, names.join());
  assert.equal(data.rows[0][descIdx], 'Description of item 1');
});

test('values: absolute links, lazy images, attributes', () => {
  const { K, $ } = page(`
    <div class="row">
      <a href="/item/1">Item</a>
      <img class="lazy" src="data:image/gif;base64,R0lGOD" data-src="/real.jpg">
      <time datetime="2024-01-02">Jan 2</time>
    </div>`);
  assert.equal(K.getValue($('a'), 'href'), 'https://shop.example/item/1');
  assert.equal(K.getValue($('img'), 'src'), 'https://shop.example/real.jpg');
  assert.equal(K.getValue($('time'), 'attr', 'datetime'), '2024-01-02');
  assert.equal(K.getValue($('.row'), 'href'), 'https://shop.example/item/1');
});

test('detectListFromExamples generalises rows across several containers', () => {
  const section = (s) => `
    <section class="cat">
      <h2>Cat ${s}</h2>
      <div class="items">
        ${[1, 2, 3].map((i) => `<div class="item"><span class="name">S${s}-${i}</span><span class="cost">€${i}</span></div>`).join('')}
      </div>
    </section>`;
  const { K, document } = page(`<main>${section(1)}${section(2)}${section(3)}</main>`);
  const names = document.querySelectorAll('.name');
  // One example: the items of the first container (not the sections).
  const single = K.detectList(names[0]);
  const singleRows = K.queryAll(single.rowSelector, document);
  assert.equal(singleRows.length, 3, single.rowSelector);
  assert.ok(singleRows.every((r) => r.classList.contains('item')));
  // Two examples in different containers: every row on the page.
  const res = K.detectListFromExamples(names[0], names[4]);
  const rows = K.queryAll(res.rowSelector, document);
  assert.equal(rows.length, 9, res.rowSelector);
});

test('relativeSelector is unique within the row and resolves the same node', () => {
  const { K, document } = page(productGrid(3));
  const row = document.querySelectorAll('.product-card')[1];
  for (const el of row.querySelectorAll('*')) {
    const sel = K.relativeSelector(row, el);
    assert.deepEqual([...K.queryIn(row, sel)], [el], `relative selector "${sel}"`);
  }
  assert.equal(K.relativeSelector(row, row), '');
  assert.deepEqual([...K.queryIn(row, '')], [row]);
});

test('columnFor builds a column from a picked element', () => {
  const { K, document } = page(productGrid(3));
  const row = document.querySelectorAll('.product-card')[0];
  const col = K.columnFor(row, row.querySelector('img'), []);
  assert.equal(col.attr, 'src');
  assert.equal(col.sample, 'https://shop.example/img/1.jpg');
  const col2 = K.columnFor(row, row.querySelector('.price'), ['Price']);
  assert.equal(col2.name, 'Price 2');
});

test('findLists ranks the product grid above navigation menus', () => {
  const { K, document } = page(productGrid(8));
  const lists = K.findLists(document, { isVisible: null });
  assert.ok(lists.length >= 1);
  const rows = K.queryAll(lists[0].rowSelector, document);
  assert.equal(rows.length, 8, lists[0].rowSelector);
});

test('resolveTarget finds the next button by selector, then by text on later pages', () => {
  const { K, document } = page(`<ul class="pages"><li><a href="?p=1">1</a></li><li><a href="?p=2">2</a></li><li><a href="?p=2">Next ›</a></li></ul>`);
  const next = document.querySelectorAll('a')[2];
  const target = K.describeTarget(next);
  assert.equal(K.resolveTarget(target, document, { isVisible: null }), next);
  // Page 2: an extra page number shifts the indexes; the text check wins.
  document.body.innerHTML = `<ul class="pages"><li><a href="?p=1">1</a></li><li><a href="?p=2">2</a></li><li><a href="?p=3">3</a></li><li><a href="?p=3">Next ›</a></li></ul>`;
  const next2 = document.querySelectorAll('a')[3];
  assert.equal(K.resolveTarget(target, document, { isVisible: null }), next2);
});

test('isDisabled recognises disabled pagination controls', () => {
  const { K, $ } = page('<li class="disabled"><a href="#">Next</a></li><button disabled>Go</button><a aria-disabled="true">x</a><a class="next">ok</a>');
  assert.ok(K.isDisabled($('li a')));
  assert.ok(K.isDisabled($('button')));
  assert.ok(K.isDisabled($('a[aria-disabled]')));
  assert.ok(!K.isDisabled($('a.next')));
});

test('queryAll reports invalid selectors with a friendly error', () => {
  const { K, document } = page('<p>x</p>');
  assert.throws(() => K.queryAll('div[', document), /Invalid selector/);
  assert.equal(K.queryAll('', document).length, 0);
});
