/*
 * End-to-end tests: load the unpacked extension in Chromium and drive the
 * side panel (opened as a popup window bound to the target tab) exactly like
 * a user would: pick elements on the page, configure pagination, run, export.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './fixtures.js';

const EXT = fileURLToPath(new URL('../../', import.meta.url));
let ctx;
let sw;
let extId;
let site;
let keeper;

before(async () => {
  site = await startServer();
  ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: !process.env.HEADED,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  extId = new URL(sw.url()).host;
  keeper = ctx.pages()[0] || (await ctx.newPage());
});

// Close every tab and panel a test opened, even when it failed half-way.
afterEach(async () => {
  for (const p of ctx.pages()) if (p !== keeper) await p.close().catch(() => {});
});

after(async () => {
  await ctx?.close();
  site?.server.close();
});

async function openSite(path) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // A unique query string per page: the panel is bound to the tab by URL.
  await page.goto(site.base + path + (path.includes('?') ? '&' : '?') + 'run=' + Math.random().toString(36).slice(2));
  page.errors = errors;
  return page;
}

async function openPanel(page) {
  const url = page.url();
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
  assert.ok(tabId, 'tab id for ' + url);
  const [panel] = await Promise.all([
    ctx.waitForEvent('page'),
    sw.evaluate(({ id, tabId }) => chrome.windows.create({ url: `chrome-extension://${id}/src/panel/panel.html?tabId=${tabId}`, type: 'popup', width: 440, height: 1000 }), { id: extId, tabId }),
  ]);
  const errors = [];
  panel.on('pageerror', (e) => errors.push(e.message));
  panel.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  panel.errors = errors;
  await panel.waitForLoadState();
  await panel.evaluate(() => chrome.storage.local.clear());
  await panel.reload();
  await panel.waitForSelector('#pick-list');
  return panel;
}

async function pick(panel, page, button, target) {
  await panel.click(button);
  await panel.locator('#picking').waitFor({ state: 'visible' });
  await page.hover(target);
  await page.click(target);
  await panel.locator('#picking').waitFor({ state: 'hidden' });
}


async function waitForText(panel, sel, re, timeout = 15000) {
  await panel.waitForFunction(({ sel, src }) => new RegExp(src).test(document.querySelector(sel)?.textContent || ''), { sel, src: re.source }, { timeout });
}

async function columnNames(panel) {
  return panel.$$eval('#columns .col-name', (els) => els.map((e) => e.value));
}

async function dataset(panel) {
  return panel.evaluate(async () => (await chrome.storage.local.get('koala.dataset'))['koala.dataset']);
}

async function runAndWait(panel, timeout = 90000) {
  await panel.click('#run');
  await waitForText(panel, '#progress-text', /^Done/, timeout);
  return panel.locator('#progress-text').innerText();
}

test('multi-page shop: full page navigations, shifting pager, disabled last page', async () => {
  const page = await openSite('/shop/page/1');
  const panel = await openPanel(page);

  await pick(panel, page, '#pick-list', '.col:nth-child(3) h2 a');
  await waitForText(panel, '#row-badge', /^8 rows$/);
  const names = await columnNames(panel);
  assert.ok(names.includes('Title'), names.join());
  assert.ok(names.includes('Price'), names.join());
  assert.ok(names.some((n) => /URL/.test(n)), names.join());

  // The page keeps its own styles: the agent's CSS lives in a shadow root.
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).margin), '8px');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('h1')).marginTop), '21.44px');

  await panel.click('#pag-type [data-type="next"]');
  await pick(panel, page, '#pick-target', '.pagination li:last-child a');
  await waitForText(panel, '#target-label', /Next/);
  await panel.fill('#max-pages', '10');

  const status = await runAndWait(panel);
  assert.match(status, /disabled/i, status);
  const ds = await dataset(panel);
  assert.equal(ds.rows.length, 24);
  const title = ds.columns.findIndex((c) => c.name === 'Title');
  const price = ds.columns.findIndex((c) => c.name === 'Price');
  assert.deepEqual(ds.rows.map((r) => r[title]), Array.from({ length: 24 }, (_, i) => 'Product ' + (i + 1)));
  assert.equal(ds.rows[23][price], 'CHF 24.00');
  assert.equal(ds.meta.pages, 3);
  assert.match(page.url(), /\/shop\/page\/3$/);
  assert.deepEqual(panel.errors, []);
  await panel.close();
  await page.close();
});

test('single-page app: in-page re-render with loading state and a disabled button', async () => {
  const page = await openSite('/spa');
  const panel = await openPanel(page);
  await pick(panel, page, '#pick-list', '.result:nth-child(2) .name');
  await waitForText(panel, '#row-badge', /^5 rows$/);
  await panel.click('#pag-type [data-type="next"]');
  await pick(panel, page, '#pick-target', '.pager-next');
  await panel.check('#opt-url');
  const status = await runAndWait(panel);
  const ds = await dataset(panel);
  assert.equal(ds.rows.length, 15, status);
  assert.equal(ds.columns.at(-1).name, 'Page URL');
  assert.match(ds.rows[14].at(-1), /\?page=3$/);
  assert.match(status, /disabled/i);
  await panel.close();
  await page.close();
});

test('infinite scroll collects everything once', async () => {
  const page = await openSite('/infinite');
  const panel = await openPanel(page);
  await pick(panel, page, '#pick-list', '.post:nth-child(2) .post-title');
  await waitForText(panel, '#row-badge', /^10 rows$/);
  await panel.click('#pag-type [data-type="scroll"]');
  await panel.fill('#max-pages', '20');
  await panel.fill('#delay-ms', '0');
  const status = await runAndWait(panel);
  const ds = await dataset(panel);
  assert.equal(ds.rows.length, 40, status);
  assert.equal(new Set(ds.rows.map((r) => r[0])).size, 40);
  assert.match(status, /end of the list/);
  await panel.close();
  await page.close();
});

test('load-more button until it disappears', async () => {
  const page = await openSite('/loadmore');
  const panel = await openPanel(page);
  await pick(panel, page, '#pick-list', '.entry:nth-child(3) .entry-name');
  await waitForText(panel, '#row-badge', /^6 rows$/);
  await panel.click('#pag-type [data-type="loadmore"]');
  await pick(panel, page, '#pick-target', '.load-more');
  const status = await runAndWait(panel);
  const ds = await dataset(panel);
  assert.equal(ds.rows.length, 18, status);
  assert.match(status, /No load more button/);
  await panel.close();
  await page.close();
});

test('auto-detect finds the table and names columns from headers; exports work', async () => {
  const page = await openSite('/table');
  const panel = await openPanel(page);
  await panel.click('#auto-detect');
  await waitForText(panel, '#row-badge', /^6 rows$/);
  assert.deepEqual(await columnNames(panel), ['Name', 'Email', 'City']);
  await runAndWait(panel);
  const ds = await dataset(panel);
  assert.deepEqual(ds.rows[1], ['Bob', 'bob@example.org', 'City 2']);

  // Exports through chrome.downloads
  await panel.click('#tab-btn-data');
  await waitForText(panel, '#d-rows', /^6$/);
  for (const format of ['xlsx', 'csv', 'json']) await panel.click(`[data-export="${format}"]`);
  await panel.waitForFunction(async () => {
    const items = await chrome.downloads.search({});
    return items.length >= 3 && items.every((d) => d.state === 'complete');
  }, null, { timeout: 15000 });
  const items = await panel.evaluate(() => chrome.downloads.search({}));
  // Playwright saves downloads under random names: identify them by MIME type.
  const kind = (d) => (/sheet/.test(d.mime) ? 'xlsx' : /csv/.test(d.mime) ? 'csv' : /json/.test(d.mime) ? 'json' : d.mime);
  const byExt = Object.fromEntries(items.map((d) => [kind(d), d]));
  for (const ext of ['xlsx', 'csv', 'json']) {
    assert.ok(byExt[ext], 'download ' + ext + ' in ' + items.map((d) => d.mime).join());
    assert.ok(existsSync(byExt[ext].filename), byExt[ext].filename);
  }
  const csv = readFileSync(byExt.csv.filename, 'utf8');
  assert.ok(csv.startsWith('\uFEFFName,Email,City\r\nAnn,ann@example.org,City 1'), csv.slice(0, 80));
  assert.deepEqual(JSON.parse(readFileSync(byExt.json.filename, 'utf8'))[0], { Name: 'Ann', Email: 'ann@example.org', City: 'City 1' });
  // openpyxl insists on the .xlsx extension.
  const xlsx = join(mkdtempSync(join(tmpdir(), 'koala-e2e-')), 'export.xlsx');
  copyFileSync(byExt.xlsx.filename, xlsx);
  const cells = execFileSync('python3', ['-I', '-c', 'import sys,openpyxl;ws=openpyxl.load_workbook(sys.argv[1]).active;print([[c.value for c in r] for r in ws.iter_rows(max_row=3)])', xlsx], { encoding: 'utf8' });
  assert.match(cells, /\['Name', 'Email', 'City'\], \['Ann', 'ann@example.org', 'City 1'\]/);
  await panel.close();
  await page.close();
});

test('explorer: indicate, navigate the tree, edit the selector, use as next button', async () => {
  const page = await openSite('/shop/page/1');
  const panel = await openPanel(page);
  await panel.click('#tab-btn-explorer');
  await pick(panel, page, '#ex-pick', '.col:nth-child(2) .price');
  await waitForText(panel, '#ex-count', /^unique$/);
  assert.match(await panel.inputValue('#ex-selector'), /price/);
  // Untick everything but the class "price" on the target: all prices match.
  const lastNode = panel.locator('#ex-model .model-node').last();
  const checked = panel.locator('#ex-model input:checked');
  while (await checked.count()) await checked.first().uncheck();
  await lastNode.locator('label', { hasText: '.price' }).locator('input').check();
  await waitForText(panel, '#ex-count', /^8 matches$/);
  assert.equal(await panel.inputValue('#ex-selector'), '.price');
  // Visual tree: go to the parent card.
  await panel.locator('#ex-tree li', { hasText: 'article.card.product' }).locator('button').click();
  await waitForText(panel, '#ex-tree .current', /article\.card/);
  // Keyboard from the panel: hover the price, ↑ selects its parent, Enter picks it.
  await panel.click('#ex-pick');
  await panel.locator('#picking').waitFor({ state: 'visible' });
  await page.hover('.col:nth-child(4) .price');
  await panel.keyboard.press('ArrowUp');
  await panel.keyboard.press('Enter');
  await panel.locator('#picking').waitFor({ state: 'hidden' });
  await waitForText(panel, '#ex-tree .current', /article\.card/);
  await waitForText(panel, '#ex-sibpos', /^1 \/ 1$/);
  // Text based selector → XPath
  await pick(panel, page, '#ex-pick', '.pagination li:last-child a');
  await panel.locator('#ex-model .model-node').last().locator('label.k-text input').check();
  await panel.waitForFunction(() => document.getElementById('ex-selector').value.startsWith('//'));
  await waitForText(panel, '#ex-count', /^unique$|^\d+ matches$/);
  await panel.click('#ex-use-next');
  await waitForText(panel, '#target-label', /Next/);
  assert.deepEqual(panel.errors, []);
  await panel.close();
  await page.close();
});

test('second example generalises across containers; picking ignores page handlers', async () => {
  const page = await openSite('/shop/page/1');
  await page.evaluate(() => {
    // Split the grid in two sections, and make clicks navigate away.
    const grid = document.querySelector('.grid');
    const second = grid.cloneNode(false);
    [...grid.children].slice(4).forEach((c) => second.append(c));
    const wrap = document.createElement('section');
    wrap.className = 'more';
    wrap.append(second);
    grid.after(wrap);
    document.addEventListener('click', () => { window.__navigated = true; });
  });
  const panel = await openPanel(page);
  await pick(panel, page, '#pick-list', '.grid .col:nth-child(1) .price');
  await waitForText(panel, '#row-badge', /^4 rows$/);
  await pick(panel, page, '#pick-list2', '.more .col:nth-child(2) .price');
  await waitForText(panel, '#row-badge', /^8 rows$/);
  assert.equal(await page.evaluate(() => window.__navigated || false), false);
  assert.match(page.url(), /\/shop\/page\/1\?run=/);
  await panel.close();
  await page.close();
});

test('core: XPath for SVG and escaped selectors resolve in Chromium', async () => {
  const page = await openSite('/svg');
  await page.addScriptTag({ path: fileURLToPath(new URL('../../src/content/core.js', import.meta.url)) });
  const res = await page.evaluate(() => {
    const K = window.KoalaCore;
    const path = document.querySelectorAll('path')[1];
    const xp = K.xpathFor(path);
    const div = document.createElement('div');
    div.id = '123:weird.id';
    document.body.append(div);
    return { xp, ok: K.queryAll(xp, document)[0] === path, css: K.uniqueSelector(div), cssOk: document.querySelector(K.uniqueSelector(div)) === div };
  });
  assert.ok(res.ok, res.xp);
  assert.ok(res.cssOk, res.css);
  await page.close();
});
