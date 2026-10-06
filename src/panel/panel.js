/*
 * KoalaScrape side panel.
 *
 *  - Extract: the scraping wizard (rows → columns → pagination → run).
 *  - Explorer: UiPath-style UI Explorer (visual tree, selector editor,
 *    validation, properties).
 *  - Data: stored results and exports.
 *
 * The panel owns the run loop. It talks to the page through the in-page agent
 * (src/content/content.js), which it injects on demand, and re-injects after
 * every full navigation, so pagination through page reloads just works.
 */
import { KEYS, emptyDataset, loadDataset, saveDataset, mergeRows, dedupeKeys, normalizeDataset } from '../shared/store.js';
import { buildExport, downloadBlob, fileStem, toTSV } from '../shared/export.js';

const K = window.KoalaCore;
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const uid = () => Math.random().toString(36).slice(2, 10);
const FIXED_TAB = Number(new URLSearchParams(location.search).get('tabId')) || null;
const SVG_NS = 'http://www.w3.org/2000/svg';

const ATTR_OPTIONS = [
  ['text', 'Text'],
  ['href', 'Link URL'],
  ['src', 'Image URL'],
  ['ownText', 'Own text'],
  ['value', 'Input value'],
  ['html', 'Inner HTML'],
  ['attr', 'Attribute…'],
];
const ATTRS = new Set(ATTR_OPTIONS.map(([v]) => v));
const PAG_TEXT = {
  none: { hint: '' },
  next: { pick: 'Select “Next” button', max: 'Max pages', hint: 'Clicks the button, waits for the next page (full reload or in-page update), and repeats until the last page or the limit.' },
  scroll: { max: 'Max scrolls', hint: 'Scrolls to the end of the list and waits for more rows. Duplicate rows are always skipped.' },
  loadmore: { pick: 'Select “Load more” button', max: 'Max clicks', hint: 'Clicks the button and waits for more rows. Duplicate rows are always skipped.' },
};

const DEFAULT_RECIPE = () => ({
  id: null,
  name: '',
  host: '',
  rowSelector: '',
  columns: [],
  pagination: { type: 'none', target: null, maxPages: 10, delayMs: 800, timeoutMs: 20000 },
  options: { dedupe: true, append: false, pageUrl: false },
});
const freshList = () => ({ handles: [], level: null, levels: [], maxLevel: 0, autoIndex: -1, autoTotal: 0 });

const state = {
  windowId: null,
  tabId: null,
  tab: null,
  restricted: '',
  agentOk: false,
  view: 'extract',
  recipe: DEFAULT_RECIPE(),
  recipes: [],
  list: freshList(),
  preview: { rows: [], rowCount: 0, error: '' },
  picking: null,
  run: null,
  explorer: { info: null, model: null, original: null, selector: '', count: null, error: '' },
  dataset: emptyDataset(),
  ui: { openCols: new Set() },
};

// ===========================================================================
// Small helpers
// ===========================================================================

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') el.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (typeof v === 'boolean') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

function icon(name, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'i' + (cls ? ' ' + cls : ''));
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

function trunc(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function compact(n) {
  return n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
}

function restrictedReason(url) {
  if (!url) return 'No page to work on.';
  if (/^(chrome|edge|brave|opera|vivaldi|about|devtools|view-source|chrome-extension|chrome-search|chrome-untrusted):/i.test(url)) {
    return 'Browser pages cannot be scraped. Open a website in this tab.';
  }
  if (/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url)) return 'The Chrome Web Store cannot be scraped.';
  return '';
}

function friendly(e) {
  const m = (e && e.message) || String(e);
  if (/file:\/\//i.test(m) || /Cannot access contents of url "file/i.test(m)) {
    return 'To scrape local files, enable “Allow access to file URLs” for KoalaScrape in chrome://extensions.';
  }
  if (/Cannot access|cannot be scripted|Missing host permission/i.test(m)) return 'KoalaScrape cannot access this page.';
  if (/Receiving end does not exist|Could not establish connection|message port closed|Frame with ID 0/i.test(m)) {
    return 'The page is not responding yet. Wait for it to finish loading (or reload it) and try again.';
  }
  if (/No tab with id/i.test(m)) return 'The tab was closed.';
  return m;
}

class StopError extends Error {
  constructor() {
    super('Stopped');
    this.name = 'StopError';
  }
}

// ===========================================================================
// Talking to the page
// ===========================================================================

const ports = new Map();

function connectPort(tabId) {
  if (ports.has(tabId)) return;
  try {
    const port = chrome.tabs.connect(tabId, { name: 'koala-panel', frameId: 0 });
    ports.set(tabId, port);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (ports.get(tabId) === port) ports.delete(tabId);
    });
  } catch (e) {
    /* tab gone */
  }
}

function disconnectPort(tabId) {
  const port = ports.get(tabId);
  if (port) {
    ports.delete(tabId);
    try {
      port.disconnect();
    } catch (e) {
      /* ignore */
    }
  }
}

async function ensureAgent(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'ping' }, { frameId: 0 });
    if (res && res.version === K.version) {
      connectPort(tabId);
      return;
    }
  } catch (e) {
    /* not injected yet */
  }
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: ['src/content/core.js', 'src/content/content.js'],
  });
  connectPort(tabId);
}

async function send(tabId, type, payload) {
  if (tabId == null) throw new Error('No page to work on.');
  try {
    await ensureAgent(tabId);
    const res = await chrome.tabs.sendMessage(tabId, Object.assign({ type }, payload || {}), { frameId: 0 });
    if (res && res.error) throw Object.assign(new Error(res.error), { fromPage: true });
    if (tabId === state.tabId && !state.agentOk) {
      state.agentOk = true;
      renderHeader();
    }
    return res;
  } catch (e) {
    if (!e.fromPage && tabId === state.tabId && state.agentOk) {
      state.agentOk = false;
      renderHeader();
    }
    throw e;
  }
}

/** Message the agent only if it is already there (never injects). */
async function sendIfPresent(tabId, type, payload) {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, Object.assign({ type }, payload || {}), { frameId: 0 });
  } catch (e) {
    return null;
  }
}

// ===========================================================================
// Target tab
// ===========================================================================

async function resolveTab() {
  try {
    if (FIXED_TAB) return await chrome.tabs.get(FIXED_TAB);
    if (state.windowId == null) state.windowId = (await chrome.windows.getCurrent()).id;
    const [tab] = await chrome.tabs.query({ active: true, windowId: state.windowId });
    return tab || null;
  } catch (e) {
    return null;
  }
}

async function refreshTarget() {
  const tab = await resolveTab();
  const changed = (tab ? tab.id : null) !== state.tabId;
  if (changed) {
    if (state.tabId != null && !(state.run && state.run.running && state.run.tabId === state.tabId)) disconnectPort(state.tabId);
    state.list = freshList();
    state.preview = { rows: [], rowCount: 0, error: '' };
    state.explorer = { info: null, model: null, original: null, selector: '', count: null, error: '' };
    state.agentOk = false;
    state.picking = null;
  }
  state.tabId = tab ? tab.id : null;
  state.tab = tab;
  state.restricted = restrictedReason(tab && tab.url);
  renderHeader();
  if (changed) {
    renderAll();
    schedulePreview(0);
  }
}

// ===========================================================================
// Feedback: banner, dialogs, picking bar
// ===========================================================================

let bannerTimer = 0;
function banner(text, kind) {
  kind = kind || 'info';
  const el = $('banner');
  $('banner-text').textContent = text;
  el.className = 'banner ' + kind;
  el.hidden = false;
  clearTimeout(bannerTimer);
  if (kind !== 'error') bannerTimer = setTimeout(() => { el.hidden = true; }, kind === 'ok' ? 3500 : 6000);
}

function dialog(opts) {
  const d = $('dialog');
  const input = $('dialog-input');
  $('dialog-title').textContent = opts.title || '';
  $('dialog-text').textContent = opts.text || '';
  $('dialog-text').hidden = !opts.text;
  input.hidden = opts.input == null;
  input.value = opts.input == null ? '' : opts.input;
  $('dialog-ok').textContent = opts.ok || 'OK';
  $('dialog-ok').className = 'btn ' + (opts.danger ? 'solid-danger' : 'primary');
  d.returnValue = '';
  d.showModal();
  if (opts.input != null) {
    input.focus();
    input.select();
  }
  return new Promise((resolve) => {
    d.addEventListener('close', () => {
      if (d.returnValue !== 'ok') resolve(null);
      else resolve(opts.input != null ? input.value.trim() : true);
    }, { once: true });
  });
}

const PICK_LABEL = {
  list: 'Click an item of the list on the page…',
  list2: 'Click the same field in another item…',
  column: 'Click a value inside one of the highlighted rows…',
  next: 'Click the “Next page” button on the page…',
  loadmore: 'Click the “Load more” button on the page…',
  inspect: 'Click any element on the page…',
};

function renderPicking() {
  $('picking').hidden = !state.picking;
  if (state.picking) $('picking-text').textContent = PICK_LABEL[state.picking] || 'Click an element on the page…';
}

async function pickElement(purpose) {
  if (state.restricted || state.tabId == null) {
    banner(state.restricted || 'No page to work on.', 'error');
    return null;
  }
  if (state.picking) await cancelPick();
  const tabId = state.tabId;
  state.picking = purpose;
  renderPicking();
  try {
    const res = await send(tabId, 'pick', { purpose });
    return res && !res.cancelled && tabId === state.tabId ? res : null;
  } catch (e) {
    if (!/port closed|Receiving end|context invalidated/i.test(e.message)) banner(friendly(e), 'error');
    return null;
  } finally {
    if (state.picking === purpose) state.picking = null;
    renderPicking();
  }
}

async function cancelPick() {
  await sendIfPresent(state.tabId, 'cancelPick');
  state.picking = null;
  renderPicking();
}

// ===========================================================================
// Recipe state
// ===========================================================================

function normalizeTarget(t) {
  if (!t || typeof t !== 'object' || !t.selector) return null;
  return { selector: String(t.selector), text: String(t.text || ''), aria: String(t.aria || ''), rel: String(t.rel || '') };
}

function normalizeRecipe(x) {
  const d = DEFAULT_RECIPE();
  if (!x || typeof x !== 'object') return d;
  const p = Object.assign({}, d.pagination, x.pagination || {});
  return {
    id: typeof x.id === 'string' ? x.id : null,
    name: String(x.name || ''),
    host: String(x.host || ''),
    rowSelector: String(x.rowSelector || ''),
    columns: Array.isArray(x.columns)
      ? x.columns.filter((c) => c && typeof c === 'object').map((c) => ({
          id: typeof c.id === 'string' ? c.id : uid(),
          name: String(c.name || 'Column'),
          selector: String(c.selector || ''),
          attr: ATTRS.has(c.attr) ? c.attr : 'text',
          attrName: String(c.attrName || ''),
        }))
      : [],
    pagination: {
      type: ['none', 'next', 'scroll', 'loadmore'].includes(p.type) ? p.type : 'none',
      target: normalizeTarget(p.target),
      maxPages: Math.max(1, Number(p.maxPages) || d.pagination.maxPages),
      delayMs: Math.max(0, Number(p.delayMs) || 0),
      timeoutMs: Math.max(3000, Number(p.timeoutMs) || d.pagination.timeoutMs),
    },
    options: Object.assign({}, d.options, x.options || {}),
  };
}

let persistTimer = 0;
function persistRecipe() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => chrome.storage.local.set({ [KEYS.recipe]: state.recipe }), 150);
}

function recipeChanged(opts) {
  persistRecipe();
  if (!opts || opts.preview !== false) schedulePreview(opts && opts.delay);
}

let previewTimer = 0;
let previewSeq = 0;
function schedulePreview(delay) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, delay == null ? 250 : delay);
}

async function refreshPreview() {
  if (state.tabId == null || state.restricted || (state.run && state.run.running)) return;
  const seq = ++previewSeq;
  const tabId = state.tabId;
  if (!state.recipe.rowSelector) {
    state.preview = { rows: [], rowCount: 0, error: '' };
    await sendIfPresent(tabId, 'clearHighlights', { layers: ['rows', 'cols', 'focus'] });
  } else {
    try {
      const res = await send(tabId, 'preview', { recipe: state.recipe, limit: 50 });
      if (seq !== previewSeq) return;
      state.preview = { rows: res.rows || [], rowCount: res.rowCount || 0, error: '' };
    } catch (e) {
      if (seq !== previewSeq) return;
      state.preview = { rows: [], rowCount: 0, error: friendly(e) };
    }
  }
  renderRows();
  renderColumnSamples();
  renderRunButton();
  renderPreview();
}

function columnsFrom(list) {
  return (list || []).map((c) => ({ id: uid(), name: c.name, selector: c.selector || '', attr: ATTRS.has(c.attr) ? c.attr : 'text', attrName: c.attrName || '' }));
}

function applyDetection(res, message) {
  state.recipe.rowSelector = res.rowSelector;
  state.recipe.columns = columnsFrom(res.columns);
  state.ui.openCols.clear();
  if (state.tab) state.recipe.host = hostOf(state.tab.url);
  recipeChanged({ delay: 0 });
  renderAll();
  banner(message || 'Found ' + res.rowCount + ' rows and ' + res.columns.length + ' columns.', res.rowCount ? 'ok' : 'warn');
}

// ===========================================================================
// Step 1: rows
// ===========================================================================

async function runDetect(level) {
  try {
    const res = await send(state.tabId, 'detectList', { handles: state.list.handles, level });
    Object.assign(state.list, { level: res.level, levels: res.levels || [], maxLevel: res.maxLevel || 0, autoIndex: -1, autoTotal: 0 });
    applyDetection(res);
  } catch (e) {
    banner(friendly(e), 'error');
  }
}

async function onPickList() {
  const info = await pickElement('list');
  if (!info) return;
  state.list = freshList();
  state.list.handles = [info.handle];
  await runDetect(null);
}

async function onPickList2() {
  if (!state.list.handles.length) return onPickList();
  const info = await pickElement('list2');
  if (!info) return;
  state.list.handles = [state.list.handles[0], info.handle];
  state.list.level = null;
  await runDetect(null);
}

function onLevel(dir) {
  const { level, levels, maxLevel } = state.list;
  if (level == null) return;
  let next;
  if (dir > 0) {
    const higher = levels.filter((l) => l > level);
    next = higher.length ? Math.min(...higher) : Math.min(maxLevel, level + 1);
  } else {
    const lower = levels.filter((l) => l < level);
    next = lower.length ? Math.max(...lower) : Math.max(0, level - 1);
  }
  if (next !== level) runDetect(next);
}

async function onAutoDetect(nextSuggestion) {
  if (state.restricted || state.tabId == null) return banner(state.restricted || 'No page to work on.', 'error');
  const index = nextSuggestion ? state.list.autoIndex + 1 : 0;
  try {
    const res = await send(state.tabId, 'autoDetect', { index });
    state.list = freshList();
    state.list.autoIndex = res.index;
    state.list.autoTotal = res.total;
    applyDetection(res, 'Suggestion ' + (res.index + 1) + ' of ' + res.total + ': ' + res.rowCount + ' rows, ' + res.columns.length + ' columns.');
  } catch (e) {
    banner(friendly(e), 'error');
  }
}

async function onRowSelectorInput() {
  state.recipe.rowSelector = $('row-selector').value.trim();
  state.list = freshList();
  recipeChanged({ delay: 400 });
}

async function onDetectColumns() {
  if (!state.recipe.rowSelector) return banner('Select the rows first.', 'warn');
  try {
    const res = await send(state.tabId, 'detectColumns', { rowSelector: state.recipe.rowSelector });
    state.recipe.columns = columnsFrom(res.columns);
    state.ui.openCols.clear();
    recipeChanged({ delay: 0 });
    renderColumns();
    banner('Detected ' + res.columns.length + ' columns in ' + res.rowCount + ' rows.', 'ok');
  } catch (e) {
    banner(friendly(e), 'error');
  }
}

async function onPickColumn() {
  if (!state.recipe.rowSelector) return banner('Select the rows first, then add columns from inside a row.', 'warn');
  const info = await pickElement('column');
  if (!info) return;
  await addColumnFromHandle(info.handle);
}

async function addColumnFromHandle(handle) {
  try {
    const res = await send(state.tabId, 'columnFromHandle', {
      rowSelector: state.recipe.rowSelector,
      handle,
      names: state.recipe.columns.map((c) => c.name),
    });
    const col = columnsFrom([res.column])[0];
    state.recipe.columns.push(col);
    recipeChanged({ delay: 0 });
    renderColumns();
    banner('Added “' + col.name + '” (found in ' + res.filled + ' of ' + res.rowCount + ' rows).', 'ok');
  } catch (e) {
    banner(friendly(e), 'error');
  }
}

// ===========================================================================
// Step 3: pagination
// ===========================================================================

async function onPickTarget() {
  const type = state.recipe.pagination.type;
  const info = await pickElement(type === 'loadmore' ? 'loadmore' : 'next');
  if (!info || !info.target) return;
  state.recipe.pagination.target = info.target;
  recipeChanged();
  renderPagination();
  checkTarget();
}

async function checkTarget() {
  const p = state.recipe.pagination;
  const label = $('target-label');
  if (!(p.type === 'next' || p.type === 'loadmore') || !p.target) return;
  try {
    const res = await send(state.tabId, 'targetState', { target: p.target, highlight: true });
    if (!res.found) {
      label.textContent = 'Not found on this page';
      label.className = 'target-label warn';
    } else {
      label.textContent = (res.disabled ? 'Disabled: ' : '') + res.label;
      label.className = 'target-label ' + (res.disabled ? 'warn' : 'ok');
    }
  } catch (e) {
    /* page not ready */
  }
}

// ===========================================================================
// Step 4: run
// ===========================================================================

function checkStop() {
  if (!state.run || state.run.stop) throw new StopError();
}

async function sleepStoppable(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    checkStop();
    await sleep(Math.min(200, end - Date.now()));
  }
}

async function signatureOf(tabId, rowSelector) {
  try {
    return await send(tabId, 'signature', { rowSelector });
  } catch (e) {
    if (/No tab with id/i.test(e.message)) throw e;
    return null; // navigating
  }
}

async function waitForRows(tabId, rowSelector, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    checkStop();
    const s = await signatureOf(tabId, rowSelector);
    if (s && s.count > 0) return true;
    await sleep(400);
  }
  return false;
}

/** Wait until the rows differ from `before` and stay stable for one poll. */
async function waitForChange(tabId, rowSelector, before, timeout) {
  const end = Date.now() + timeout;
  let last = null;
  while (Date.now() < end) {
    checkStop();
    await sleep(500);
    const s = await signatureOf(tabId, rowSelector);
    if (!s || !s.count || s.sig === before) {
      last = null;
      continue;
    }
    if (s.sig === last) return true;
    last = s.sig;
  }
  return false;
}

function setRunStatus(text) {
  if (!state.run) return;
  state.run.status = text;
  renderRun();
}

function ensureUniqueColumnNames() {
  const seen = new Set();
  let renamed = false;
  state.recipe.columns.forEach((c, i) => {
    let name = c.name.trim() || 'Column ' + (i + 1);
    if (seen.has(name)) {
      let n = 2;
      while (seen.has(name + ' ' + n)) n++;
      name = name + ' ' + n;
    }
    if (name !== c.name) {
      c.name = name;
      renamed = true;
    }
    seen.add(name);
  });
  return renamed;
}

async function startRun() {
  if (state.run && state.run.running) return;
  if (state.restricted || state.tabId == null) return banner(state.restricted || 'No page to work on.', 'error');
  if (!state.recipe.rowSelector || !state.recipe.columns.length) return banner('Select the rows and at least one column first.', 'warn');
  const p = state.recipe.pagination;
  if ((p.type === 'next' || p.type === 'loadmore') && !p.target) {
    return banner('Select the ' + (p.type === 'next' ? '“Next”' : '“Load more”') + ' button first (step 3), or set pagination to None.', 'warn');
  }
  if (ensureUniqueColumnNames()) {
    persistRecipe();
    renderColumns();
  }
  if (state.picking) await cancelPick();

  const recipe = structuredClone(state.recipe);
  const tabId = state.tabId;
  let ds = await loadDataset();
  if (!recipe.options.append && ds.rows.length) {
    const ok = await dialog({
      title: 'Replace stored data?',
      text: 'You have ' + ds.rows.length + ' rows stored. Running will replace them.\nTick “Append to existing data” to keep them instead.',
      ok: 'Replace',
      danger: true,
    });
    if (!ok) return;
  }
  if (!recipe.options.append) ds = emptyDataset();

  const cumulative = p.type === 'scroll' || p.type === 'loadmore';
  const dedupe = recipe.options.dedupe || cumulative;
  const cols = recipe.columns.map((c) => ({ name: c.name, attr: c.attr }));
  if (recipe.options.pageUrl) cols.push({ name: 'Page URL', attr: 'href' });
  const keyColumns = recipe.columns.length;
  const seen = dedupe ? dedupeKeys(ds, cols, keyColumns) : null;
  const maxPages = p.type === 'none' ? 1 : Math.max(1, Math.floor(p.maxPages) || 1);

  const run = { running: true, stop: false, tabId, page: 0, maxPages, added: 0, status: 'Starting…', ended: '' };
  state.run = run;
  renderRun();
  renderHeader();
  await sendIfPresent(tabId, 'clearHighlights');

  let reason = '';
  try {
    for (let page = 1; page <= maxPages; page++) {
      run.page = page;
      const label = (cumulative ? 'Load ' : 'Page ') + page + (maxPages > 1 ? ' of ' + maxPages : '');
      setRunStatus(label + ': waiting for rows…');
      if (!(await waitForRows(tabId, recipe.rowSelector, p.timeoutMs))) {
        reason = page === 1 ? 'No rows matched the row selector on this page.' : 'No rows found after loading the next page.';
        break;
      }
      if (page > 1 && p.delayMs) await sleepStoppable(p.delayMs);
      checkStop();
      const res = await send(tabId, 'extract', { recipe });
      let rows = res.rows || [];
      if (recipe.options.pageUrl) rows = rows.map((r) => r.concat(res.url));
      const added = mergeRows(ds, cols, rows, { dedupe, seen, keyColumns });
      run.added += added;
      ds.meta = {
        pages: (ds.meta.pages || 0) + 1,
        source: ds.meta.source || res.url,
        title: ds.meta.title || res.title,
        host: hostOf(res.url),
        updatedAt: Date.now(),
      };
      await saveDataset(ds);
      setRunStatus(label + ': ' + rows.length + ' rows (' + added + ' new) · ' + ds.rows.length + ' total');

      if (page >= maxPages) {
        if (maxPages > 1) reason = 'Reached the limit of ' + maxPages + (cumulative ? ' loads.' : ' pages.');
        break;
      }
      const before = await signatureOf(tabId, recipe.rowSelector);
      if (p.type === 'next' || p.type === 'loadmore') {
        const click = await send(tabId, 'clickTarget', { target: p.target });
        if (!click.clicked) {
          reason = click.reason === 'disabled'
            ? 'The ' + (p.type === 'next' ? 'next' : 'load more') + ' button is disabled: everything was collected.'
            : 'No ' + (p.type === 'next' ? 'next' : 'load more') + ' button on this page: everything was collected.';
          break;
        }
      } else if (p.type === 'scroll') {
        await send(tabId, 'scrollMore', { rowSelector: recipe.rowSelector });
      }
      setRunStatus(label + ': loading more…');
      const timeout = p.type === 'scroll' ? Math.min(p.timeoutMs, 10000) : p.timeoutMs;
      if (!(await waitForChange(tabId, recipe.rowSelector, before && before.sig, timeout))) {
        reason = p.type === 'scroll'
          ? 'No more rows appeared after scrolling: end of the list.'
          : 'The page did not change after clicking: last page reached.';
        break;
      }
    }
  } catch (e) {
    reason = e instanceof StopError ? 'Stopped by you.' : 'Error: ' + friendly(e);
  } finally {
    run.running = false;
    run.ended = reason;
    run.status = 'Done: ' + run.added + ' new rows from ' + run.page + (cumulative ? ' load(s). ' : ' page(s). ') + reason;
    try {
      await saveDataset(ds);
    } catch (e) {
      /* storage error is reported below */
    }
    state.dataset = ds;
    renderRun();
    renderHeader();
    renderData();
    banner(run.status, /^Error/.test(reason) ? 'error' : 'ok');
    if (tabId === state.tabId) schedulePreview(300);
  }
}

function stopRun() {
  if (state.run && state.run.running) {
    state.run.stop = true;
    setRunStatus('Stopping…');
  }
}

// ===========================================================================
// Recipes
// ===========================================================================

async function loadRecipes() {
  const res = await chrome.storage.local.get([KEYS.recipe, KEYS.recipes]);
  state.recipes = Array.isArray(res[KEYS.recipes]) ? res[KEYS.recipes].map(normalizeRecipe).filter((r) => r.id) : [];
  if (res[KEYS.recipe]) state.recipe = normalizeRecipe(res[KEYS.recipe]);
}

async function saveRecipes() {
  await chrome.storage.local.set({ [KEYS.recipes]: state.recipes });
}

function useRecipe(rec) {
  state.recipe = normalizeRecipe(structuredClone(rec));
  state.list = freshList();
  state.ui.openCols.clear();
  recipeChanged({ delay: 0 });
  renderAll();
}

async function saveRecipeAs() {
  const host = hostOf(state.tab && state.tab.url) || state.recipe.host;
  const name = await dialog({ title: 'Save recipe', text: 'Give this recipe a name so you can reuse it later.', input: state.recipe.name || (host ? host + ' list' : 'My recipe'), ok: 'Save' });
  if (!name) return;
  const rec = Object.assign(structuredClone(state.recipe), { id: uid(), name, host: state.recipe.host || host, savedAt: Date.now() });
  state.recipes.push(rec);
  Object.assign(state.recipe, { id: rec.id, name: rec.name, host: rec.host });
  await saveRecipes();
  persistRecipe();
  renderRecipeBar();
  banner('Recipe “' + name + '” saved.', 'ok');
}

async function saveRecipe() {
  const i = state.recipes.findIndex((r) => r.id === state.recipe.id);
  if (i < 0) return saveRecipeAs();
  state.recipes[i] = Object.assign(structuredClone(state.recipe), { savedAt: Date.now() });
  await saveRecipes();
  renderRecipeBar();
  banner('Recipe “' + state.recipe.name + '” saved.', 'ok');
}

async function onRecipeMenu(action) {
  $('recipe-menu').hidden = true;
  const current = state.recipes.find((r) => r.id === state.recipe.id);
  if (action === 'new') {
    if (state.recipe.columns.length && !(await dialog({ title: 'Start a new recipe?', text: 'The current rows, columns and pagination settings will be cleared.', ok: 'New recipe' }))) return;
    useRecipe(DEFAULT_RECIPE());
  } else if (action === 'saveas') {
    await saveRecipeAs();
  } else if (action === 'rename') {
    if (!current) return saveRecipeAs();
    const name = await dialog({ title: 'Rename recipe', input: current.name, ok: 'Rename' });
    if (!name) return;
    current.name = name;
    state.recipe.name = name;
    await saveRecipes();
    persistRecipe();
    renderRecipeBar();
  } else if (action === 'delete') {
    if (!current) return banner('This recipe is not saved.', 'warn');
    if (!(await dialog({ title: 'Delete recipe?', text: '“' + current.name + '” will be removed from your saved recipes.', ok: 'Delete', danger: true }))) return;
    state.recipes = state.recipes.filter((r) => r.id !== current.id);
    state.recipe.id = null;
    await saveRecipes();
    persistRecipe();
    renderRecipeBar();
  } else if (action === 'import') {
    $('recipe-file').value = '';
    $('recipe-file').click();
  } else if (action === 'export') {
    const rec = structuredClone(state.recipe);
    delete rec.id;
    rec.columns.forEach((c) => delete c.id);
    const blob = new Blob([JSON.stringify({ koalaScrape: 3, recipe: rec }, null, 2)], { type: 'application/json' });
    const slug = (rec.name || rec.host || 'recipe').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    await downloadBlob(blob, 'koala-recipe-' + (slug || 'recipe') + '.json');
  }
}

async function onImportFile(file) {
  try {
    const json = JSON.parse(await file.text());
    const list = Array.isArray(json) ? json : json.recipes || [json.recipe || json];
    const recs = list.map(normalizeRecipe).filter((r) => r.rowSelector || r.columns.length);
    if (!recs.length) throw new Error('No recipe found in this file.');
    for (const r of recs) {
      r.id = uid();
      r.name = r.name || r.host || 'Imported recipe';
      state.recipes.push(r);
    }
    await saveRecipes();
    useRecipe(recs[0]);
    banner('Imported ' + recs.length + ' recipe' + (recs.length > 1 ? 's' : '') + '.', 'ok');
  } catch (e) {
    banner('Import failed: ' + e.message, 'error');
  }
}

// ===========================================================================
// Explorer
// ===========================================================================

function setExplorer(info) {
  state.explorer = {
    info,
    model: info.model,
    original: structuredClone(info.model),
    selector: info.selector,
    count: null,
    error: '',
  };
  renderExplorer();
  validateExplorer(true, false);
}

async function inspectHandle(handle) {
  if (!handle) return;
  try {
    setExplorer(await send(state.tabId, 'inspect', { handle }));
  } catch (e) {
    banner(friendly(e), 'error');
  }
}

let explorerTimer = 0;
function scheduleExplorerValidate() {
  clearTimeout(explorerTimer);
  explorerTimer = setTimeout(() => validateExplorer(true, false), 200);
}

async function validateExplorer(highlight, scroll) {
  const ex = state.explorer;
  const selector = ex.selector.trim();
  if (!selector) {
    ex.count = 0;
    ex.error = '';
    renderExplorerCount();
    await sendIfPresent(state.tabId, 'clearHighlights', { layers: ['matches'] });
    return;
  }
  try {
    const res = await send(state.tabId, 'validate', { selector, highlight, scroll });
    ex.count = res.count;
    ex.error = '';
  } catch (e) {
    ex.count = null;
    ex.error = friendly(e);
  }
  renderExplorerCount();
}

function onModelChange(e) {
  const input = e.target;
  const nodeEl = input.closest('.model-node');
  if (!nodeEl) return;
  const node = state.explorer.model[Number(nodeEl.dataset.n)];
  if (input.classList.contains('node-on')) {
    node.on = input.checked;
    if (node.on && !node.parts.some((p) => p.on)) node.parts[0].on = true;
  } else {
    const part = node.parts[Number(input.dataset.p)];
    part.on = input.checked;
    if (part.on) node.on = true;
  }
  state.explorer.selector = K.compileModel(state.explorer.model);
  $('ex-selector').value = state.explorer.selector;
  syncModelDom();
  scheduleExplorerValidate();
}

/** Reflect the model's on/off state in the existing editor DOM (keeps focus). */
function syncModelDom() {
  const model = state.explorer.model;
  for (const row of $('ex-model').querySelectorAll('.model-node')) {
    const node = model[Number(row.dataset.n)];
    row.classList.toggle('on', !!node.on);
    const nodeBox = row.querySelector('.node-on');
    nodeBox.checked = !!node.on;
    nodeBox.title = node.on ? 'Skip this node' : 'Use this node';
    row.querySelectorAll('.chip').forEach((chip, j) => {
      chip.classList.toggle('on', !!node.parts[j].on);
      chip.querySelector('input').checked = !!node.parts[j].on;
    });
  }
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    banner((what || 'Text') + ' copied to the clipboard.', 'ok');
  } catch (e) {
    banner('Could not copy: ' + e.message, 'error');
  }
}

async function useExplorerAsRows() {
  const selector = state.explorer.selector.trim();
  if (!selector) return;
  try {
    const res = await send(state.tabId, 'detectColumns', { rowSelector: selector });
    state.list = freshList();
    applyDetection({ rowSelector: selector, rowCount: res.rowCount, columns: res.columns });
    showTab('extract');
  } catch (e) {
    banner(friendly(e), 'error');
  }
}

async function useExplorerAsColumn() {
  if (!state.recipe.rowSelector) return banner('Select the rows in the Extract tab first.', 'warn');
  await addColumnFromHandle(state.explorer.info.handle);
  showTab('extract');
}

async function useExplorerAsNext() {
  const info = state.explorer.info;
  try {
    const target = await send(state.tabId, 'describeTarget', { handle: info.handle });
    target.selector = state.explorer.selector.trim() || target.selector;
    const p = state.recipe.pagination;
    if (p.type !== 'next' && p.type !== 'loadmore') p.type = 'next';
    p.target = normalizeTarget(target);
    recipeChanged();
    renderPagination();
    showTab('extract');
    checkTarget();
    banner('Pagination button set.', 'ok');
  } catch (e) {
    banner(friendly(e), 'error');
  }
}

// ===========================================================================
// Data
// ===========================================================================

async function exportData(format) {
  const ds = await loadDataset();
  if (!ds.rows.length) return banner('No data to export yet. Run an extraction first.', 'warn');
  try {
    const blob = await buildExport(format, ds);
    await downloadBlob(blob, fileStem(ds.meta) + '.' + format);
    banner('Exported ' + ds.rows.length + ' rows as ' + format.toUpperCase() + '.', 'ok');
  } catch (e) {
    banner('Export failed: ' + e.message, 'error');
  }
}

async function copyData() {
  const ds = await loadDataset();
  if (!ds.rows.length) return banner('No data to copy yet.', 'warn');
  await copyText(toTSV(ds.columns, ds.rows), ds.rows.length + ' rows');
}

async function clearData() {
  if (!state.dataset.rows.length) return;
  if (!(await dialog({ title: 'Clear all data?', text: 'The ' + state.dataset.rows.length + ' stored rows will be deleted.', ok: 'Clear', danger: true }))) return;
  await saveDataset(emptyDataset());
  banner('Data cleared.', 'ok');
}

// ===========================================================================
// Rendering
// ===========================================================================

function showTab(name) {
  state.view = name;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const s of ['extract', 'explorer', 'data']) $('tab-' + s).hidden = s !== name;
}

function renderHeader() {
  const t = state.tab;
  $('target-text').textContent = t ? hostOf(t.url) || t.title || 'This page' : 'No page';
  $('target').title = t ? (t.title || '') + '\n' + (t.url || '') : '';
  const img = $('target-icon');
  if (t && t.favIconUrl && /^(https?|data):/.test(t.favIconUrl)) {
    if (img.getAttribute('src') !== t.favIconUrl) img.src = t.favIconUrl;
    img.hidden = false;
  } else {
    img.hidden = true;
  }
  const dot = $('target-dot');
  dot.className = 'status-dot' + (state.run && state.run.running ? ' busy' : state.restricted ? ' error' : state.agentOk ? ' ok' : '');
  dot.title = state.restricted || (state.agentOk ? 'Connected to the page' : 'Not connected yet');
}

function renderRecipeBar() {
  const sel = $('recipe-select');
  sel.textContent = '';
  const host = hostOf(state.tab && state.tab.url);
  const saved = state.recipes.some((r) => r.id === state.recipe.id);
  sel.append(new Option(saved ? 'Unsaved recipe' : 'Unsaved recipe' + (state.recipe.columns.length ? ' (current)' : ''), ''));
  const sorted = state.recipes.slice().sort((a, b) => (b.host === host) - (a.host === host) || a.name.localeCompare(b.name));
  for (const r of sorted) {
    sel.append(new Option((r.host === host && host ? '● ' : '') + r.name + (r.host ? ' · ' + r.host : ''), r.id));
  }
  sel.value = saved ? state.recipe.id : '';
}

function renderRows() {
  const r = state.recipe;
  const has = !!r.rowSelector;
  $('list-details').hidden = !has;
  const input = $('row-selector');
  if (document.activeElement !== input) input.value = r.rowSelector;
  const badge = $('row-badge');
  if (!has) badge.textContent = '';
  else if (state.preview.error) {
    badge.textContent = 'error';
    badge.className = 'count-badge error';
    badge.title = state.preview.error;
  } else {
    const n = state.preview.rowCount;
    badge.textContent = n + (n === 1 ? ' row' : ' rows');
    badge.className = 'count-badge ' + (n > 1 ? 'ok' : n === 1 ? 'warn' : 'error');
    badge.title = '';
  }
  $('row-meta').textContent = has && state.preview.rowCount ? state.preview.rowCount + ' rows' : '';
  const { handles, level, maxLevel } = state.list;
  $('level-up').disabled = !handles.length || level == null || level >= maxLevel;
  $('level-down').disabled = !handles.length || level == null || level <= 0;
  $('pick-list2').disabled = !handles.length;
  $('auto-next').hidden = !(state.list.autoTotal > 1);
  $('rows-hint').hidden = has;
  $('step-rows').classList.toggle('done', has && state.preview.rowCount > 0);
}

function sampleFor(i) {
  for (const row of state.preview.rows) if (row[i]) return row[i];
  return '';
}

function columnItem(col, i, total) {
  const color = K.COLUMN_COLORS[i % K.COLUMN_COLORS.length];
  const open = state.ui.openCols.has(col.id);
  const attr = h('select', { class: 'col-attr', title: 'What to extract', 'aria-label': 'Value type' },
    ATTR_OPTIONS.map(([v, l]) => h('option', { value: v }, l)));
  attr.value = col.attr;
  const sample = sampleFor(i);
  return h('li', { class: 'col' + (open ? ' open' : ''), dataset: { id: col.id } },
    h('div', { class: 'col-main' },
      h('span', { class: 'swatch', style: '--c:' + color }),
      h('input', { class: 'col-name', value: col.name, 'aria-label': 'Column name', spellcheck: 'false', autocomplete: 'off' }),
      attr,
      h('button', { class: 'icon-btn sm col-more', title: 'Edit selector' }, icon('sliders')),
      h('button', { class: 'icon-btn sm col-del', title: 'Remove column' }, icon('x'))),
    h('div', { class: 'col-sample', title: sample }, sample ? trunc(sample, 120) : '—'),
    open
      ? h('div', { class: 'col-edit' },
          h('label', {}, 'Selector inside the row (empty = the row itself)',
            h('input', { class: 'col-sel mono', value: col.selector, spellcheck: 'false', autocomplete: 'off' })),
          col.attr === 'attr'
            ? h('label', {}, 'Attribute name', h('input', { class: 'col-attrname mono', value: col.attrName || '', placeholder: 'e.g. data-id', spellcheck: 'false' }))
            : null,
          h('div', { class: 'btn-row wrap' },
            h('button', { class: 'btn sm col-up', disabled: i === 0 }, icon('up'), 'Up'),
            h('button', { class: 'btn sm col-down', disabled: i === total - 1 }, icon('down'), 'Down'),
            h('button', { class: 'btn sm col-test' }, icon('eye'), 'Highlight')))
      : null);
}

function renderColumns() {
  const list = $('columns');
  list.textContent = '';
  const cols = state.recipe.columns;
  cols.forEach((c, i) => list.append(columnItem(c, i, cols.length)));
  $('columns-empty').hidden = cols.length > 0;
  $('col-meta').textContent = cols.length ? cols.length + (cols.length === 1 ? ' column' : ' columns') : '';
  $('pick-column').disabled = !state.recipe.rowSelector;
  $('detect-columns').disabled = !state.recipe.rowSelector;
  $('step-columns').classList.toggle('done', cols.length > 0);
  renderPreview();
  renderRunButton();
}

function renderColumnSamples() {
  for (const li of $('columns').children) {
    const i = state.recipe.columns.findIndex((c) => c.id === li.dataset.id);
    const el = li.querySelector('.col-sample');
    if (i < 0 || !el) continue;
    const sample = sampleFor(i);
    el.textContent = sample ? trunc(sample, 120) : '—';
    el.title = sample;
  }
}

function renderPagination() {
  const p = state.recipe.pagination;
  for (const b of $('pag-type').children) b.setAttribute('aria-checked', String(b.dataset.type === p.type));
  $('pag-body').hidden = p.type === 'none';
  const needsTarget = p.type === 'next' || p.type === 'loadmore';
  $('pag-target-row').hidden = !needsTarget;
  $('pick-target-text').textContent = PAG_TEXT[p.type].pick || '';
  const label = $('target-label');
  if (needsTarget) {
    if (p.target) {
      label.textContent = p.target.text || p.target.aria || p.target.selector;
      label.className = 'target-label';
      label.title = p.target.selector;
    } else {
      label.textContent = 'Not set';
      label.className = 'target-label warn';
      label.title = '';
    }
  }
  $('max-pages-label').textContent = PAG_TEXT[p.type].max || 'Max pages';
  if (document.activeElement !== $('max-pages')) $('max-pages').value = p.maxPages;
  if (document.activeElement !== $('delay-ms')) $('delay-ms').value = p.delayMs;
  $('pag-hint').textContent = PAG_TEXT[p.type].hint;
}

function renderRunButton() {
  const r = state.recipe;
  $('run').disabled = !r.rowSelector || !r.columns.length || !!state.restricted;
}

function renderRun() {
  const run = state.run;
  const running = !!(run && run.running);
  $('run').hidden = running;
  $('stop').hidden = !running;
  renderRunButton();
  $('opt-dedupe').checked = !!state.recipe.options.dedupe;
  $('opt-append').checked = !!state.recipe.options.append;
  $('opt-url').checked = !!state.recipe.options.pageUrl;
  for (const id of ['step-rows', 'step-columns', 'step-pagination']) $(id).classList.toggle('disabled', running);
  for (const id of ['opt-dedupe', 'opt-append', 'opt-url', 'recipe-select', 'recipe-save', 'recipe-menu-btn']) $(id).disabled = running;
  $('progress').hidden = !run;
  if (run) {
    $('progress-text').textContent = run.status;
    const pct = running ? Math.max(4, Math.min(100, ((run.page - 1) / run.maxPages) * 100)) : 100;
    $('progress-fill').style.width = pct + '%';
  }
}

function buildTable(columns, rows, opts) {
  opts = opts || {};
  const table = h('table', { class: 'data' });
  table.append(h('thead', {}, h('tr', {},
    h('th', { class: 'num' }, '#'),
    columns.map((c, i) => h('th', { title: c.name },
      opts.colors ? h('span', { class: 'swatch', style: '--c:' + K.COLUMN_COLORS[i % K.COLUMN_COLORS.length] }) : null,
      c.name)))));
  const body = h('tbody');
  rows.forEach((r, ri) => {
    body.append(h('tr', {},
      h('td', { class: 'num' }, ri + 1),
      columns.map((c, i) => {
        const v = r[i] == null ? '' : String(r[i]);
        return h('td', { title: v }, trunc(v, 200));
      })));
  });
  table.append(body);
  return table;
}

function renderPreview() {
  const wrap = $('preview');
  wrap.textContent = '';
  const cols = state.recipe.columns;
  const rows = state.preview.rows;
  $('preview-meta').textContent = state.preview.rowCount ? Math.min(rows.length, 50) + ' of ' + state.preview.rowCount + ' rows' : '';
  if (state.preview.error) return wrap.append(h('div', { class: 'empty' }, state.preview.error));
  if (!state.recipe.rowSelector) return wrap.append(h('div', { class: 'empty' }, state.restricted || 'Select the rows to see a live preview of the data.'));
  if (!cols.length) return wrap.append(h('div', { class: 'empty' }, 'Add at least one column.'));
  if (!rows.length) return wrap.append(h('div', { class: 'empty' }, 'The matched rows contain no data for these columns.'));
  wrap.append(buildTable(cols, rows, { colors: true }));
}

function renderExplorerCount() {
  const b = $('ex-count');
  const ex = state.explorer;
  if (ex.error) {
    b.textContent = 'invalid';
    b.className = 'count-badge error';
    b.title = ex.error;
  } else if (ex.count == null) {
    b.textContent = '';
  } else {
    b.textContent = ex.count === 1 ? 'unique' : ex.count + ' matches';
    b.className = 'count-badge ' + (ex.count === 1 ? 'ok' : ex.count === 0 ? 'error' : 'warn');
    b.title = ex.count === 1 ? 'The selector matches exactly one element' : ex.count === 0 ? 'Nothing matches' : 'Several elements match';
  }
}

function chipText(p) {
  if (p.k === 'tag') return p.v;
  if (p.k === 'id') return '#' + p.v;
  if (p.k === 'class') return '.' + p.v;
  if (p.k === 'attr') return '[' + p.n + '="' + trunc(p.v, 28) + '"]';
  if (p.k === 'nth') return ':nth-of-type(' + p.v + ')';
  if (p.k === 'text') return 'text="' + trunc(p.v, 24) + '"';
  return '';
}

function chipTitle(p) {
  if (p.k === 'class' && p.kind === 'dynamic') return 'Looks auto-generated: may change between visits';
  if (p.k === 'class' && p.kind === 'state') return 'State class (active, selected…): changes with interaction';
  if (p.k === 'class' && p.kind === 'utility') return 'Styling utility class';
  if (p.k === 'id' && !p.stable) return 'Looks auto-generated: may change between visits';
  if (p.k === 'nth') return 'Position among siblings of the same tag: fragile if the page changes';
  if (p.k === 'text') return 'Exact text (switches the selector to XPath)';
  return p.k === 'attr' ? p.n + '=' + p.v : '';
}

function renderModel() {
  const box = $('ex-model');
  box.textContent = '';
  const model = state.explorer.model;
  if (!model) return;
  const showAll = $('ex-all-nodes').checked;
  const firstOn = model.findIndex((n) => n.on);
  let from = showAll ? 0 : Math.max(0, model.length - 6);
  if (!showAll && firstOn >= 0) from = Math.min(from, firstOn);
  if (from > 0) {
    box.append(h('button', {
      class: 'model-more',
      onclick: () => {
        $('ex-all-nodes').checked = true;
        renderModel();
      },
    }, 'Show ' + from + ' more ancestor' + (from > 1 ? 's' : '') + '…'));
  }
  for (let i = from; i < model.length; i++) {
    const node = model[i];
    const weak = (p) => (p.k === 'class' && (p.kind === 'dynamic' || p.kind === 'state')) || (p.k === 'id' && !p.stable);
    box.append(h('div', { class: 'model-node' + (node.on ? ' on' : ''), dataset: { n: i } },
      h('input', { type: 'checkbox', class: 'node-on', checked: !!node.on, title: node.on ? 'Skip this node' : 'Use this node' }),
      h('div', { class: 'chips' },
        node.parts.map((p, j) => h('label', { class: 'chip k-' + p.k + (p.on ? ' on' : '') + (weak(p) ? ' weak' : ''), title: chipTitle(p) },
          h('input', { type: 'checkbox', checked: !!p.on, dataset: { p: j } }),
          h('span', {}, chipText(p)))))));
  }
}

function fillProps(table, obj) {
  table.textContent = '';
  const entries = Object.entries(obj || {});
  if (!entries.length) return table.append(h('tr', {}, h('td', { colspan: '2' }, '—')));
  for (const [k, v] of entries) table.append(h('tr', {}, h('td', {}, k), h('td', {}, v === '' ? '—' : v)));
}

function renderExplorer() {
  const ex = state.explorer;
  const info = ex.info;
  $('ex-empty').hidden = !!info;
  $('ex-body').hidden = !info;
  if (!info) return;
  const tree = $('ex-tree');
  tree.textContent = '';
  const ancestors = info.tree.ancestors;
  const pad = (d) => 'padding-left:' + Math.min(d, 14) * 9 + 'px';
  ancestors.forEach((a, d) => tree.append(h('li', { style: pad(d) }, h('button', { dataset: { handle: a.handle }, title: a.label }, a.label))));
  const depth = ancestors.length;
  tree.append(h('li', { class: 'current', style: pad(depth) }, h('button', { dataset: { handle: info.handle }, title: info.label }, info.label)));
  for (const c of info.tree.children) {
    tree.append(h('li', { class: 'child', style: pad(depth + 1) },
      h('button', { dataset: { handle: c.handle }, title: c.label }, c.label + (c.count ? '  (' + c.count + ')' : ''))));
  }
  if (info.tree.moreChildren) tree.append(h('li', { class: 'more', style: pad(depth + 1) }, '… ' + info.tree.moreChildren + ' more'));
  const current = tree.querySelector('.current');
  if (current) current.scrollIntoView({ block: 'nearest' });
  $('ex-sibpos').textContent = info.tree.index + ' / ' + info.tree.siblingCount;
  $('ex-prev').disabled = !info.tree.prev;
  $('ex-next').disabled = !info.tree.next;
  if (document.activeElement !== $('ex-selector')) $('ex-selector').value = ex.selector;
  $('ex-xpath').textContent = info.xpath;
  $('ex-xpath').title = info.xpath;
  $('ex-use-column').disabled = !state.recipe.rowSelector;
  renderExplorerCount();
  renderModel();
  fillProps($('ex-props'), info.props.props);
  fillProps($('ex-attrs'), info.props.attrs);
}

function renderData() {
  const ds = state.dataset;
  $('d-rows').textContent = ds.rows.length.toLocaleString();
  $('d-cols').textContent = ds.columns.length;
  $('d-pages').textContent = ds.meta.pages || 0;
  $('data-count').textContent = compact(ds.rows.length);
  $('d-meta').textContent = ds.rows.length
    ? 'From ' + (ds.meta.host || ds.meta.source || 'unknown') + ' · updated ' + new Date(ds.meta.updatedAt || Date.now()).toLocaleString()
    : 'No data yet. Run an extraction from the Extract tab.';
  for (const b of document.querySelectorAll('[data-export], #d-copy, #d-clear')) b.disabled = !ds.rows.length;
  const wrap = $('d-table');
  wrap.textContent = '';
  if (!ds.rows.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  wrap.append(buildTable(ds.columns, ds.rows.slice(0, 100)));
  if (ds.rows.length > 100) wrap.append(h('div', { class: 'empty' }, 'Showing 100 of ' + ds.rows.length.toLocaleString() + ' rows. Open the data viewer to see everything.'));
}

function renderAll() {
  renderHeader();
  renderRecipeBar();
  renderRows();
  renderColumns();
  renderPagination();
  renderRun();
  renderPreview();
  renderPicking();
  renderExplorer();
  renderData();
}

// ===========================================================================
// Events
// ===========================================================================

function wire() {
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
  $('banner-close').addEventListener('click', () => { $('banner').hidden = true; });
  $('picking-cancel').addEventListener('click', cancelPick);
  // While picking, the panel usually has the keyboard focus: forward the
  // picker keys (↑ parent, ↓ child, Enter select, Esc cancel) to the page.
  document.addEventListener('keydown', (e) => {
    if (!state.picking || !['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(e.key)) return;
    e.preventDefault();
    sendIfPresent(state.tabId, 'pickKey', { key: e.key });
  });

  // Recipes
  $('recipe-select').addEventListener('change', (e) => {
    const rec = state.recipes.find((r) => r.id === e.target.value);
    if (rec) useRecipe(rec);
    else {
      state.recipe.id = null;
      persistRecipe();
    }
  });
  $('recipe-save').addEventListener('click', saveRecipe);
  $('recipe-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('recipe-menu').hidden = !$('recipe-menu').hidden;
  });
  $('recipe-menu').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (b) onRecipeMenu(b.dataset.action);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-wrap')) $('recipe-menu').hidden = true;
  });
  $('recipe-file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) onImportFile(f);
  });

  // Step 1
  $('pick-list').addEventListener('click', onPickList);
  $('pick-list2').addEventListener('click', onPickList2);
  $('auto-detect').addEventListener('click', () => onAutoDetect(false));
  $('auto-next').addEventListener('click', () => onAutoDetect(true));
  $('level-up').addEventListener('click', () => onLevel(1));
  $('level-down').addEventListener('click', () => onLevel(-1));
  $('row-selector').addEventListener('input', onRowSelectorInput);

  // Step 2
  $('pick-column').addEventListener('click', onPickColumn);
  $('detect-columns').addEventListener('click', onDetectColumns);
  const colsEl = $('columns');
  const colOf = (el) => {
    const li = el.closest('.col');
    return li ? state.recipe.columns.find((c) => c.id === li.dataset.id) : null;
  };
  colsEl.addEventListener('input', (e) => {
    const col = colOf(e.target);
    if (!col) return;
    if (e.target.classList.contains('col-name')) {
      col.name = e.target.value;
      recipeChanged({ preview: false });
      renderPreview();
    } else if (e.target.classList.contains('col-sel')) {
      col.selector = e.target.value.trim();
      recipeChanged({ delay: 400 });
    } else if (e.target.classList.contains('col-attrname')) {
      col.attrName = e.target.value.trim();
      recipeChanged({ delay: 400 });
    }
  });
  colsEl.addEventListener('change', (e) => {
    const col = colOf(e.target);
    if (col && e.target.classList.contains('col-attr')) {
      col.attr = e.target.value;
      if (col.attr === 'attr') state.ui.openCols.add(col.id);
      recipeChanged({ delay: 0 });
      renderColumns();
    }
  });
  colsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    const col = btn && colOf(btn);
    if (!col) return;
    const cols = state.recipe.columns;
    const i = cols.indexOf(col);
    if (btn.classList.contains('col-more')) {
      if (state.ui.openCols.has(col.id)) state.ui.openCols.delete(col.id);
      else state.ui.openCols.add(col.id);
      renderColumns();
    } else if (btn.classList.contains('col-del')) {
      cols.splice(i, 1);
      recipeChanged({ delay: 0 });
      renderColumns();
    } else if (btn.classList.contains('col-up') && i > 0) {
      [cols[i - 1], cols[i]] = [cols[i], cols[i - 1]];
      recipeChanged({ delay: 0 });
      renderColumns();
    } else if (btn.classList.contains('col-down') && i < cols.length - 1) {
      [cols[i + 1], cols[i]] = [cols[i], cols[i + 1]];
      recipeChanged({ delay: 0 });
      renderColumns();
    } else if (btn.classList.contains('col-test')) {
      send(state.tabId, 'validate', { selector: col.selector, rowSelector: state.recipe.rowSelector, highlight: true, scroll: true })
        .then((r) => banner('“' + col.name + '” found in ' + r.count + ' of ' + state.preview.rowCount + ' rows.', 'info'))
        .catch((err) => banner(friendly(err), 'error'));
    }
  });

  // Step 3
  $('pag-type').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-type]');
    if (!b) return;
    state.recipe.pagination.type = b.dataset.type;
    recipeChanged();
    renderPagination();
    checkTarget();
  });
  $('pick-target').addEventListener('click', onPickTarget);
  $('max-pages').addEventListener('input', (e) => {
    state.recipe.pagination.maxPages = Math.max(1, Math.floor(Number(e.target.value)) || 1);
    recipeChanged({ preview: false });
  });
  $('delay-ms').addEventListener('input', (e) => {
    state.recipe.pagination.delayMs = Math.max(0, Number(e.target.value) || 0);
    recipeChanged({ preview: false });
  });

  // Step 4
  $('opt-dedupe').addEventListener('change', (e) => { state.recipe.options.dedupe = e.target.checked; persistRecipe(); });
  $('opt-append').addEventListener('change', (e) => { state.recipe.options.append = e.target.checked; persistRecipe(); });
  $('opt-url').addEventListener('change', (e) => { state.recipe.options.pageUrl = e.target.checked; persistRecipe(); });
  $('run').addEventListener('click', startRun);
  $('stop').addEventListener('click', stopRun);

  // Explorer
  $('ex-pick').addEventListener('click', async () => {
    const info = await pickElement('inspect');
    if (info) {
      setExplorer(info);
      sendIfPresent(state.tabId, 'focus', { handle: info.handle });
    }
  });
  $('ex-clear').addEventListener('click', () => sendIfPresent(state.tabId, 'clearHighlights', { layers: ['matches', 'focus'] }));
  $('ex-tree').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-handle]');
    if (b) inspectHandle(Number(b.dataset.handle));
  });
  $('ex-prev').addEventListener('click', () => inspectHandle(state.explorer.info && state.explorer.info.tree.prev));
  $('ex-next').addEventListener('click', () => inspectHandle(state.explorer.info && state.explorer.info.tree.next));
  $('ex-selector').addEventListener('input', (e) => {
    state.explorer.selector = e.target.value;
    scheduleExplorerValidate();
  });
  $('ex-highlight').addEventListener('click', () => validateExplorer(true, true));
  $('ex-copy').addEventListener('click', () => copyText(state.explorer.selector, 'Selector'));
  $('ex-copy-xpath').addEventListener('click', () => copyText(state.explorer.info ? state.explorer.info.xpath : '', 'XPath'));
  $('ex-reset').addEventListener('click', () => {
    const ex = state.explorer;
    if (!ex.original) return;
    ex.model = structuredClone(ex.original);
    ex.selector = K.compileModel(ex.model);
    $('ex-selector').value = ex.selector;
    renderModel();
    validateExplorer(true, false);
  });
  $('ex-all-nodes').addEventListener('change', renderModel);
  $('ex-model').addEventListener('change', onModelChange);
  $('ex-use-rows').addEventListener('click', useExplorerAsRows);
  $('ex-use-column').addEventListener('click', useExplorerAsColumn);
  $('ex-use-next').addEventListener('click', useExplorerAsNext);

  // Data
  for (const b of document.querySelectorAll('[data-export]')) b.addEventListener('click', () => exportData(b.dataset.export));
  $('d-copy').addEventListener('click', copyData);
  $('d-clear').addEventListener('click', clearData);
  $('d-open').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('src/viewer/viewer.html') }));

  // Browser events
  chrome.tabs.onActivated.addListener((info) => {
    if (!FIXED_TAB && info.windowId === state.windowId) refreshTarget();
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (tabId !== state.tabId) return;
    if (change.url || change.title || change.favIconUrl || change.status) {
      state.tab = Object.assign({}, state.tab, change);
      state.restricted = restrictedReason(state.tab.url);
      if (change.status === 'loading') state.agentOk = false;
      renderHeader();
    }
    if (change.status === 'complete' && !(state.run && state.run.running)) {
      state.list = freshList();
      if (state.explorer.info) {
        state.explorer = { info: null, model: null, original: null, selector: '', count: null, error: '' };
        renderExplorer();
      }
      renderRows();
      schedulePreview(300);
      checkTarget();
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEYS.dataset]) return;
    state.dataset = normalizeDataset(changes[KEYS.dataset].newValue);
    renderData();
  });
}

async function init() {
  wire();
  await loadRecipes();
  state.dataset = await loadDataset();
  await refreshTarget();
  renderAll();
  schedulePreview(0);
  checkTarget();
}

init();
