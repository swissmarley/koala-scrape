import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toCSV, toTSV, toJSON, toXLSX, columnLetter, crc32 } from '../../src/shared/export.js';
import { emptyDataset, mergeRows, dedupeKeys } from '../../src/shared/store.js';

const columns = [{ name: 'Name' }, { name: 'Price' }, { name: 'Note' }];

test('CSV quotes, escapes, adds a BOM and neutralises formulas', () => {
  const csv = toCSV(columns, [
    ['Widget, large', '12.50', 'He said "hi"'],
    ['=HYPERLINK("x")', '-5', 'line1\nline2'],
    ['+1 (555)', '', '@cmd'],
  ]);
  assert.ok(csv.startsWith('\uFEFF'));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], 'Name,Price,Note');
  assert.equal(lines[1], '"Widget, large",12.50,"He said ""hi"""');
  assert.equal(lines[2], `"'=HYPERLINK(""x"")",-5,"line1\nline2"`);
  assert.ok(csv.includes(`'+1 (555)`));
  assert.ok(csv.includes(`'@cmd`));
});

test('TSV neutralises formulas like CSV does', () => {
  const tsv = toTSV([{ name: '=Name' }, { name: 'Price' }, { name: 'Note' }], [
    ['=HYPERLINK("x")', '-5', '@cmd'],
    ['+1 (555)', '+42', '-SUM(A1)'],
    ['plain', '12.50', 'a=b'],
  ]);
  const lines = tsv.split('\n');
  assert.equal(lines[0], "'=Name\tPrice\tNote");
  assert.equal(lines[1], `'=HYPERLINK("x")\t-5\t'@cmd`);
  assert.equal(lines[2], "'+1 (555)\t+42\t'-SUM(A1)");
  assert.equal(lines[3], 'plain\t12.50\ta=b');
});

test('TSV flattens tabs and newlines; JSON maps names', () => {
  assert.equal(toTSV([{ name: 'a' }, { name: 'b' }], [['x\ty', 'p\nq']]), 'a\tb\nx y\tp q');
  assert.deepEqual(toJSON([{ name: 'a' }, { name: 'b' }], [['1'], ['2', '3']]), [{ a: '1', b: '' }, { a: '2', b: '3' }]);
});

test('column letters and crc32', () => {
  assert.equal(columnLetter(0), 'A');
  assert.equal(columnLetter(25), 'Z');
  assert.equal(columnLetter(26), 'AA');
  assert.equal(columnLetter(701), 'ZZ');
  assert.equal(columnLetter(702), 'AAA');
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('XLSX is a valid workbook that spreadsheet software can read', async () => {
  const rows = [
    ['Café “quoted” <b>', '42', 'ok'],
    ['bad\u0001control', '007', ' padded '],
    ['emoji 🐨', '3.14', ''],
  ];
  for (const compress of [true, false]) {
    const bytes = await toXLSX(columns, rows, { compress });
    const dir = mkdtempSync(join(tmpdir(), 'koala-xlsx-'));
    const file = join(dir, 'out.xlsx');
    writeFileSync(file, bytes);
    const script = `
import sys, zipfile, xml.dom.minidom, json
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
for n in z.namelist():
    xml.dom.minidom.parseString(z.read(n))
out = {"names": sorted(z.namelist())}
try:
    import openpyxl
    ws = openpyxl.load_workbook(sys.argv[1]).active
    out["cells"] = [[c.value for c in row] for row in ws.iter_rows()]
    out["frozen"] = ws.freeze_panes
except ImportError:
    pass
print(json.dumps(out))`;
    const result = JSON.parse(execFileSync('python3', ['-I', '-c', script, file], { encoding: 'utf8' }));
    assert.ok(result.names.includes('xl/worksheets/sheet1.xml'));
    if (result.cells) {
      assert.deepEqual(result.cells[0], ['Name', 'Price', 'Note']);
      assert.deepEqual(result.cells[1], ['Café “quoted” <b>', 42, 'ok']);
      assert.deepEqual(result.cells[2], ['badcontrol', '007', ' padded ']);
      assert.equal(result.cells[3][0], 'emoji 🐨');
      assert.equal(result.cells[3][1], 3.14);
      assert.equal(result.frozen, 'A2');
    }
  }
});

test('mergeRows aligns by column name, adds new columns and dedupes', () => {
  const ds = emptyDataset();
  const seen = new Set();
  const cols1 = [{ name: 'A' }, { name: 'B' }];
  assert.equal(mergeRows(ds, cols1, [['1', '2'], ['1', '2'], ['3', '4']], { dedupe: true, seen }), 2);
  const cols2 = [{ name: 'B' }, { name: 'C' }];
  assert.equal(mergeRows(ds, cols2, [['x', 'y']], { dedupe: false }), 1);
  assert.deepEqual(ds.columns.map((c) => c.name), ['A', 'B', 'C']);
  assert.deepEqual(ds.rows, [['1', '2', ''], ['3', '4', ''], ['', 'x', 'y']]);
  // Keys rebuilt from stored data when appending to an existing dataset.
  const keys = dedupeKeys(ds, cols1, 2);
  assert.ok(keys.has(JSON.stringify(['1', '2'])));
});
