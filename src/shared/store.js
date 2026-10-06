/*
 * Dataset + recipe persistence (chrome.storage.local).
 *
 * A dataset is { columns: [{ name, attr }], rows: [[...values]], meta }.
 * Rows are arrays aligned with `columns`, so renaming or reordering columns
 * never misaligns values.
 */

export const KEYS = {
  recipe: 'koala.recipe',
  recipes: 'koala.recipes',
  dataset: 'koala.dataset',
};

export function emptyDataset() {
  return { columns: [], rows: [], meta: { pages: 0, source: '', title: '', host: '', updatedAt: 0 } };
}

export function normalizeDataset(ds) {
  const base = emptyDataset();
  if (!ds || !Array.isArray(ds.columns) || !Array.isArray(ds.rows)) return base;
  return {
    columns: ds.columns.map((c) => ({ name: String(c.name), attr: c.attr || 'text' })),
    rows: ds.rows.filter(Array.isArray),
    meta: Object.assign(base.meta, ds.meta || {}),
  };
}

export async function loadDataset() {
  const res = await chrome.storage.local.get(KEYS.dataset);
  return normalizeDataset(res[KEYS.dataset]);
}

export async function saveDataset(ds) {
  await chrome.storage.local.set({ [KEYS.dataset]: ds });
}

/** Map incoming column names onto dataset columns, adding missing ones. */
function columnIndexes(ds, columns) {
  return columns.map((c) => {
    let i = ds.columns.findIndex((d) => d.name === c.name);
    if (i < 0) {
      ds.columns.push({ name: c.name, attr: c.attr || 'text' });
      for (const r of ds.rows) r.push('');
      i = ds.columns.length - 1;
    }
    return i;
  });
}

/** Deduplication key: the values of the first `keyColumns` incoming columns. */
export function dedupeKeys(ds, columns, keyColumns) {
  const seen = new Set();
  const idx = columns.slice(0, keyColumns).map((c) => ds.columns.findIndex((d) => d.name === c.name));
  if (idx.some((i) => i < 0)) return seen;
  for (const r of ds.rows) seen.add(JSON.stringify(idx.map((i) => r[i] ?? '')));
  return seen;
}

/**
 * Merge rows (arrays aligned with `columns`) into the dataset.
 * Returns the number of rows actually added.
 */
export function mergeRows(ds, columns, rows, opts = {}) {
  const idx = columnIndexes(ds, columns);
  const keyColumns = opts.keyColumns || columns.length;
  let added = 0;
  for (const r of rows) {
    if (opts.dedupe) {
      const key = JSON.stringify(r.slice(0, keyColumns).map((v) => v ?? ''));
      if (opts.seen.has(key)) continue;
      opts.seen.add(key);
    }
    const out = new Array(ds.columns.length).fill('');
    idx.forEach((di, si) => {
      out[di] = r[si] ?? '';
    });
    ds.rows.push(out);
    added++;
  }
  return added;
}
