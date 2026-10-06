/* Full-page data viewer: search, sort, paging, export. */
import { KEYS, emptyDataset, loadDataset, saveDataset, normalizeDataset } from '../shared/store.js';
import { buildExport, downloadBlob, fileStem, toTSV } from '../shared/export.js';

const $ = (id) => document.getElementById(id);
const state = { ds: emptyDataset(), query: '', sort: { col: -1, dir: 1 }, page: 0, perPage: 100, view: [] };

function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid instanceof Node ? kid : String(kid));
  return node;
}

function isUrl(v) {
  return /^https?:\/\/\S+$/i.test(v);
}

/** Filter + sort the dataset into state.view (array of row indexes). */
function computeView() {
  const { rows } = state.ds;
  const q = state.query.trim().toLowerCase();
  let idx = rows.map((_, i) => i);
  if (q) idx = idx.filter((i) => rows[i].some((v) => String(v == null ? '' : v).toLowerCase().includes(q)));
  const { col, dir } = state.sort;
  if (col >= 0) {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    idx.sort((a, b) => dir * collator.compare(String(rows[a][col] ?? ''), String(rows[b][col] ?? '')));
  }
  state.view = idx;
  const pages = Math.max(1, Math.ceil(idx.length / state.perPage));
  state.page = Math.min(state.page, pages - 1);
}

function highlight(text) {
  const q = state.query.trim();
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return [text.slice(0, i), el('mark', {}, text.slice(i, i + q.length)), text.slice(i + q.length)];
}

function cell(value, column) {
  const v = value == null ? '' : String(value);
  const shown = v.length > 300 ? v.slice(0, 299) + '…' : v;
  if (column.attr === 'src' && isUrl(v)) {
    return el('td', { class: 'thumb', title: v }, el('img', { src: v, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }));
  }
  if (isUrl(v)) {
    return el('td', { title: v }, el('a', { href: v, target: '_blank', rel: 'noopener noreferrer' }, highlight(shown)));
  }
  return el('td', { title: v }, highlight(shown));
}

function render() {
  computeView();
  const { columns, rows, meta } = state.ds;
  const table = $('table');
  table.textContent = '';
  $('empty').hidden = rows.length > 0;
  $('meta').textContent = rows.length
    ? rows.length.toLocaleString() + ' rows · ' + columns.length + ' columns · ' + (meta.host || meta.source || '') +
      (meta.updatedAt ? ' · ' + new Date(meta.updatedAt).toLocaleString() : '')
    : 'No data';
  for (const b of document.querySelectorAll('[data-export], #copy, #clear')) b.disabled = !rows.length;
  if (!rows.length) {
    $('status').textContent = '';
    $('page-info').textContent = '';
    return;
  }
  const head = el('tr', {}, el('th', { class: 'num' }, '#'));
  columns.forEach((c, i) => {
    const th = el('th', { 'data-col': String(i), title: 'Sort by ' + c.name }, c.name,
      state.sort.col === i ? el('span', { class: 'arrow' }, state.sort.dir > 0 ? '▲' : '▼') : null);
    head.append(th);
  });
  table.append(el('thead', {}, head));
  const start = state.page * state.perPage;
  const slice = state.view.slice(start, start + state.perPage);
  const body = el('tbody');
  for (const ri of slice) {
    const r = rows[ri];
    body.append(el('tr', {}, el('td', { class: 'num' }, ri + 1), columns.map((c, i) => cell(r[i], c))));
  }
  table.append(body);
  const pages = Math.max(1, Math.ceil(state.view.length / state.perPage));
  $('page-info').textContent = 'Page ' + (state.page + 1) + ' of ' + pages;
  $('status').textContent = state.query
    ? state.view.length.toLocaleString() + ' of ' + rows.length.toLocaleString() + ' rows match'
    : rows.length.toLocaleString() + ' rows';
  $('first').disabled = $('prev').disabled = state.page === 0;
  $('last').disabled = $('next').disabled = state.page >= pages - 1;
}

/** The rows currently visible after filtering and sorting (all pages). */
function visibleDataset() {
  return { columns: state.ds.columns, rows: state.view.map((i) => state.ds.rows[i]), meta: state.ds.meta };
}

async function exportAs(format) {
  const ds = state.query || state.sort.col >= 0 ? visibleDataset() : state.ds;
  const blob = await buildExport(format, ds);
  await downloadBlob(blob, fileStem(ds.meta) + '.' + format);
}

function wire() {
  let t = 0;
  $('search').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.query = e.target.value;
      state.page = 0;
      render();
    }, 150);
  });
  $('table').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-col]');
    if (!th) return;
    const col = Number(th.dataset.col);
    if (state.sort.col !== col) state.sort = { col, dir: 1 };
    else if (state.sort.dir === 1) state.sort.dir = -1;
    else state.sort = { col: -1, dir: 1 };
    render();
  });
  $('per-page').addEventListener('change', (e) => {
    state.perPage = Number(e.target.value);
    state.page = 0;
    render();
  });
  $('first').addEventListener('click', () => { state.page = 0; render(); });
  $('prev').addEventListener('click', () => { state.page = Math.max(0, state.page - 1); render(); });
  $('next').addEventListener('click', () => { state.page += 1; render(); });
  $('last').addEventListener('click', () => { state.page = Number.MAX_SAFE_INTEGER; render(); });
  for (const b of document.querySelectorAll('[data-export]')) b.addEventListener('click', () => exportAs(b.dataset.export));
  $('copy').addEventListener('click', async () => {
    const ds = visibleDataset();
    await navigator.clipboard.writeText(toTSV(ds.columns, ds.rows));
    $('status').textContent = 'Copied ' + ds.rows.length.toLocaleString() + ' rows to the clipboard';
  });
  $('clear').addEventListener('click', () => {
    const d = $('dialog');
    $('dialog-text').textContent = 'The ' + state.ds.rows.length.toLocaleString() + ' stored rows will be deleted.';
    d.returnValue = '';
    d.showModal();
    d.addEventListener('close', async () => {
      if (d.returnValue === 'ok') await saveDataset(emptyDataset());
    }, { once: true });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEYS.dataset]) {
      state.ds = normalizeDataset(changes[KEYS.dataset].newValue);
      render();
    }
  });
}

wire();
loadDataset().then((ds) => {
  state.ds = ds;
  render();
});
