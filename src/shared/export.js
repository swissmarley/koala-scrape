/*
 * Exporters: CSV, TSV (clipboard), JSON and a real .xlsx workbook.
 *
 * The XLSX writer builds the Office Open XML parts by hand and zips them
 * (deflate via CompressionStream when available, stored otherwise), so no
 * third-party library is needed.
 */

// ---------------------------------------------------------------------------
// CSV / TSV / JSON
// ---------------------------------------------------------------------------

/**
 * Spreadsheet apps execute cells starting with = + - @ as formulas. Scraped
 * text is untrusted, so prefix such cells with an apostrophe (OWASP advice).
 * Plain numbers like "-12.5" are left alone.
 */
function neutralizeFormula(s) {
  if (/^[=@\t\r]/.test(s)) return "'" + s;
  if (/^[+-]/.test(s) && !/^[+-][\d\s.,]*$/.test(s)) return "'" + s;
  return s;
}

function csvCell(value, delimiter) {
  let s = neutralizeFormula(value == null ? '' : String(value));
  if (s.includes('"') || s.includes(delimiter) || /[\r\n]/.test(s) || /^\s|\s$/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function toCSV(columns, rows, opts = {}) {
  const delimiter = opts.delimiter || ',';
  const lines = [columns.map((c) => csvCell(c.name, delimiter)).join(delimiter)];
  for (const r of rows) lines.push(columns.map((_, i) => csvCell(r[i], delimiter)).join(delimiter));
  return (opts.bom === false ? '' : '\uFEFF') + lines.join('\r\n') + '\r\n';
}

/**
 * Tab separated, for pasting into Excel / Google Sheets. Tabs and newlines
 * are flattened first, then the formula guard runs on what actually gets
 * pasted.
 */
export function toTSV(columns, rows) {
  const cell = (v) => neutralizeFormula(String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' '));
  return [columns.map((c) => cell(c.name)).join('\t')]
    .concat(rows.map((r) => columns.map((_, i) => cell(r[i])).join('\t')))
    .join('\n');
}

/** Array of objects keyed by column name. */
export function toJSON(columns, rows) {
  return rows.map((r) => {
    const o = {};
    columns.forEach((c, i) => {
      o[c.name] = r[i] == null ? '' : r[i];
    });
    return o;
  });
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (e) {
    return null;
  }
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Build a ZIP archive from [{ name, data: Uint8Array }]. */
export async function zip(files, opts = {}) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(opts.date || new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const deflated = opts.compress === false ? null : await deflateRaw(f.data);
    const useDeflate = deflated && deflated.length < f.data.length;
    const body = useDeflate ? deflated : f.data;
    const method = useDeflate ? 8 : 0;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    locals.push(new Uint8Array(local.buffer), name, body);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, method, true);
    central.setUint16(12, time, true);
    central.setUint16(14, date, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, body.length, true);
    central.setUint32(24, f.data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, 0, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), name);

    offset += 30 + name.length + body.length;
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const parts = locals.concat(centrals, [new Uint8Array(end.buffer)]);
  const out = new Uint8Array(parts.reduce((s, b) => s + b.length, 0));
  let p = 0;
  for (const b of parts) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function xmlEscape(s) {
  return String(s)
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function columnLetter(index) {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const NUMERIC = /^-?(?:0|[1-9]\d{0,14})(?:\.\d+)?$/;

function cellXml(ref, value, style) {
  const s = value == null ? '' : String(value);
  if (s === '') return '';
  const st = style ? ' s="' + style + '"' : '';
  if (!style && NUMERIC.test(s)) return '<c r="' + ref + '"><v>' + s + '</v></c>';
  const text = s.length > 32767 ? s.slice(0, 32767) : s;
  const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return '<c r="' + ref + '" t="inlineStr"' + st + '><is><t' + space + '>' + xmlEscape(text) + '</t></is></c>';
}

/** Build an .xlsx workbook (Uint8Array) with one "Data" sheet. */
export async function toXLSX(columns, rows, opts = {}) {
  const enc = new TextEncoder();
  const ncols = Math.max(1, columns.length);
  const lastRef = columnLetter(ncols - 1) + (rows.length + 1);

  const widths = columns.map((c, i) => {
    let w = String(c.name).length;
    for (let r = 0; r < Math.min(rows.length, 200); r++) w = Math.max(w, String(rows[r][i] == null ? '' : rows[r][i]).length);
    return Math.min(60, Math.max(8, w + 2));
  });

  const sheetRows = [];
  sheetRows.push('<row r="1">' + columns.map((c, i) => cellXml(columnLetter(i) + '1', c.name, 1)).join('') + '</row>');
  rows.forEach((r, ri) => {
    const n = ri + 2;
    sheetRows.push('<row r="' + n + '">' + columns.map((_, i) => cellXml(columnLetter(i) + n, r[i], 0)).join('') + '</row>');
  });

  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<dimension ref="A1:' + lastRef + '"/>' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    (columns.length ? '<cols>' + widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>' : '') +
    '<sheetData>' + sheetRows.join('') + '</sheetData>' +
    (columns.length ? '<autoFilter ref="A1:' + lastRef + '"/>' : '') +
    '</worksheet>';

  const sheetName = xmlEscape((opts.sheetName || 'Data').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="' + sheetName + '" sheetId="1" r:id="rId1"/></sheets>' +
    (columns.length ? '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">\'' + sheetName + '\'!$A$1:$' + columnLetter(ncols - 1) + '$' + (rows.length + 1) + '</definedName></definedNames>' : '') +
    '</workbook>';

  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  return zip(
    [
      { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
      { name: '_rels/.rels', data: enc.encode(rootRels) },
      { name: 'xl/workbook.xml', data: enc.encode(workbook) },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRels) },
      { name: 'xl/styles.xml', data: enc.encode(styles) },
      { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheet) },
    ],
    opts,
  );
}

// ---------------------------------------------------------------------------
// Download helpers (extension pages)
// ---------------------------------------------------------------------------

export function fileStem(meta = {}) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
  const host = String(meta.host || '').replace(/^www\./, '').replace(/[^a-z0-9.-]+/gi, '-');
  return ['koala', host, stamp].filter(Boolean).join('-');
}

export async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    if (typeof chrome !== 'undefined' && chrome.downloads && chrome.downloads.download) {
      await chrome.downloads.download({ url, filename: filename.replace(/[\\/:*?"<>|]+/g, '-'), saveAs: false });
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

export const MIME = {
  csv: 'text/csv;charset=utf-8',
  json: 'application/json;charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Build the blob for a format. */
export async function buildExport(format, ds) {
  if (format === 'csv') return new Blob([toCSV(ds.columns, ds.rows)], { type: MIME.csv });
  if (format === 'json') return new Blob([JSON.stringify(toJSON(ds.columns, ds.rows), null, 2)], { type: MIME.json });
  if (format === 'xlsx') return new Blob([await toXLSX(ds.columns, ds.rows)], { type: MIME.xlsx });
  throw new Error('Unknown format: ' + format);
}
