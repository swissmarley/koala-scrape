# 🐨 KoalaScrape

**KoalaScrape** is a point-and-click web scraper for Google Chrome, modelled on UiPath's
*Data Scraping* wizard and *UI Explorer*. Click one item of a list, and KoalaScrape finds
every similar item, proposes the columns, follows the pagination, and exports clean
data to **Excel**, **CSV** or **JSON**. Everything runs locally in your browser.

## ✨ Features

**Extraction wizard (Extract tab)**
- **Smart list detection.** Click one item and KoalaScrape finds the repeating rows.
  This works for cards, results and table rows.
  - **Wider / Narrower** moves the row up or down one level.
  - **Second example** generalises from two clicks, for instance items spread over several sections. This is UiPath's "indicate a second element".
  - **Auto-detect** finds the biggest list without any click. **Next suggestion** cycles through the alternatives.
- **Automatic columns.**
  - Text, links and images are detected with consistent per-row selectors, so columns never misalign when an item lacks a field.
  - Columns get meaningful names (`Title`, `Price`, `Image`…), and table columns are named after the table headers.
  - Rename, reorder or delete columns, choose what to extract (text, link URL, image URL, input value, HTML, any attribute), or edit the selector.
  - **Add column** lets you click any value inside a row.
- **Pagination.**
  - **Next button.** Works with full page reloads and with single-page apps. It stops by itself when the button disappears or becomes disabled, and finds the button again by its text when the pager layout changes.
  - **Infinite scroll** and **Load more**, with page limits and a wait time.
- **Live preview.** Rows are outlined and numbered on the page, columns are colour coded, and the panel shows a live data preview.
- **Recipes.** Save, load, rename, import and export a scraping configuration as JSON to reuse it later or share it.

**UI Explorer (Explorer tab)**
- **Indicate element**, then use ↑ / ↓ to pick the parent or child before clicking.
- **Visual tree** with ancestors, children and siblings. Click any node to inspect it.
- **Selector editor.** Every node of the path lists its tag, id, classes, attributes, index and text, each with a checkbox. Unstable, auto-generated values are flagged. Enabling *text* switches the selector to XPath.
- **Validation.** A match counter shows *unique*, *N matches* or *0*, with live highlighting on the page.
- **Copy** the CSS selector or XPath, and read the element's properties and attributes.
- **Use as**: send the selector to the wizard as the rows, a column or the "Next" button.

**Data (Data tab + viewer)**
- **Exports:**
  - A real **Excel workbook** (`.xlsx`) with a bold, frozen header and filters.
  - **CSV** in UTF-8 with a BOM, protected against formula injection.
  - **JSON**.
  - **Copy** to paste into Excel or Google Sheets.
- **Full-page data viewer** with search, sorting, paging, clickable links and image thumbnails.

## 📥 Installation

1. Clone or download this repository.
2. Open `chrome://extensions/` and enable **Developer mode** (top right).
3. Click **Load unpacked** and select the repository folder (the one containing `manifest.json`).
4. Click the KoalaScrape icon (or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd>) to open the side panel.

Requires Chrome 116 or newer.

## 📖 How to use

1. Open the page you want to scrape and open the KoalaScrape side panel.
2. **Rows.** Click **Select list item**, then click an item on the page, for example a product title. All similar items get outlined and numbered.
   - If the rows are too small or too big, use **Wider** or **Narrower**.
   - If only part of the list is found, for example items in other sections, click **Second example** and click the same field in another item.
3. **Columns.** Check the proposed columns in the preview. Rename or remove them, or click **Add column** and click a value inside a row.
4. **Pagination (optional).** Choose **Next button** (then **Select "Next" button** and click it on the page), **Scroll** or **Load more**, and set a limit.
5. **Run.** Click **Run extraction**. Keep the side panel open while it runs. Results are saved after every page, so you can stop at any time.
6. **Export.** Open the **Data** tab and download Excel, CSV or JSON, or open the full data viewer.

Tip: save the configuration as a **recipe** (💾) to scrape the same site again later with one click.

### Explorer

Open the **Explorer** tab, click **Indicate element** and click anything on the page.

- Walk the DOM with the visual tree.
- Tick or untick attributes in the selector editor and watch the match count update live.
- Copy the selector, or send it to the wizard with **Use as**.

## ⚠️ Limitations

- Content inside `<iframe>`s and closed shadow DOM is not reachable.
- Browser pages (`chrome://…`) and the Chrome Web Store cannot be scraped.
- To scrape local `file://` pages, enable *Allow access to file URLs* for KoalaScrape in `chrome://extensions`.
- A run is driven by the side panel. Closing the panel stops the run (data collected so far is kept).

## 🔒 Privacy

KoalaScrape has no servers and sends nothing anywhere. Its code is only injected into a
page when you use it from the side panel, and its highlights live in an isolated
shadow root, so websites are left untouched. Data and recipes are stored in
`chrome.storage.local` on your computer.

## 🛠️ Development

```
manifest.json
src/
  background.js        service worker: opens the side panel from the toolbar icon
  content/core.js      DOM engine: selectors, list/column detection, extraction (shared with tests)
  content/content.js   in-page agent: picker, shadow-DOM highlights, pagination actions
  panel/               side panel UI (wizard, explorer, data) and the run loop
  viewer/              full-page data viewer
  shared/              storage helpers, exporters (CSV/JSON/XLSX), design tokens
test/
  unit/                jsdom tests for the engine and the exporters
  e2e/                 Playwright tests that load the extension in Chromium against a fixture site
```

There is no build step. The folder is loaded as-is by Chrome.

```bash
npm install                 # jsdom + Playwright (dev only)
npm test                    # unit tests
npx playwright install chromium   # once, if you don't have a Playwright Chromium
npm run test:e2e            # end-to-end tests (headless Chromium with the extension loaded)
```

Set `HEADED=1` to watch the end-to-end tests, or `CHROMIUM_PATH=/path/to/chrome` to use a specific browser.

## 🆕 What's new in 3.0

Version 3 is a rewrite that fixes the issues that made 2.x unusable:

- **Pages no longer break.** The 2.x stylesheet was injected into every website and reset all margins and paddings. Highlights now live in a shadow root.
- **The side panel loads again.** `sidepanel.html` contained three nested HTML documents and never loaded the stylesheet, and a `#k:root` typo disabled every colour variable.
- **Selectors are escaped.** Ids such as `#123-grid` or Tailwind classes such as `w-1/2` used to throw `SyntaxError` and stop scraping.
- **Columns stay aligned.** Fields were numbered per row (`Text_3` in one row, `Text_4` in the next), and the preview only showed the columns of the first row.
- **Pagination is reliable.**
  - Auto-scraping no longer resumes on unrelated tabs.
  - Single-page apps are no longer scraped twice.
  - Index-based "Next" selectors no longer break when the pager layout changes.
  - The page counter now updates.
- **Selection works as expected.**
  - Stopping selection now actually stops it.
  - Clicks that navigate on `mousedown`/`pointerdown` are blocked while picking.
- **Exports are fixed.**
  - CSV no longer crashes on non-text values and is UTF-8 safe.
  - The "Excel" export is now a real `.xlsx` file instead of an HTML table.
- **Dependencies trimmed.** The unused `puppeteer` dependency was removed.

## 📝 License

MIT. See [LICENSE](LICENSE).
