// --- VARIABLES ---
const els = {
  statusText: document.getElementById('status-text'),
  statusDot: document.getElementById('status-dot'),
  count: document.getElementById('count'),
  pageCount: document.getElementById('page-count'),
  toggleBtn: document.getElementById('toggle-picker'),
  nextBtn: document.getElementById('set-next-btn'),
  startPagBtn: document.getElementById('start-pagination'),
  clearBtn: document.getElementById('clear-data'),
  pagControls: document.getElementById('pagination-controls'),
  maxPages: document.getElementById('max-pages'),
  openPreviewBtn: document.getElementById('open-preview'),
  exportCsv: document.getElementById('export-csv'),
  exportJson: document.getElementById('export-json'),
  exportXls: document.getElementById('export-xls')
};

// --- INITIALIZE UI ---
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "update_stats") updateStats(msg.data);
  if (msg.action === "status_update") setStatus(msg.status, msg.type);
  if (msg.action === "next_btn_set") {
    showPaginationUI();
    setStatus("Next button set", "success");
  }
});

chrome.storage.local.get(['koalaData', 'koalaNextSelector', 'scrapeStats'], (result) => {
  if (result.scrapeStats) updateStats(result.scrapeStats);
  if (result.koalaNextSelector) showPaginationUI();
});

// --- ACTIONS ---

els.toggleBtn.addEventListener('click', () => {
  const isActive = els.toggleBtn.classList.contains('btn-danger');
  if (isActive) {
    sendMessage('stop_scrape');
    resetToggleBtn();
  } else {
    sendMessage('toggle_mode', { mode: 'select_data' });
    els.toggleBtn.innerHTML = "<span>🛑</span> Stop Selection";
    els.toggleBtn.classList.remove('btn-primary');
    els.toggleBtn.classList.add('btn-danger');
    setStatus("Select an element on the page", "busy");
  }
});

els.nextBtn.addEventListener('click', () => {
  sendMessage('toggle_mode', { mode: 'select_next' });
  els.nextBtn.textContent = "Click 'Next' on page...";
  setStatus("Select the pagination button", "busy");
});

els.startPagBtn.addEventListener('click', () => {
  const max = els.maxPages.value;
  sendMessage('start_auto_scrape', { maxPages: parseInt(max) });
  setStatus("Auto-scraping started...", "busy");
});

els.clearBtn.addEventListener('click', () => {
  chrome.storage.local.clear(() => {
    updateStats({ count: 0, pages: 0 });
    els.pagControls.classList.add('hidden');
    els.nextBtn.innerHTML = "<span>➡️</span> Set Next Button";
    resetToggleBtn();
    setStatus("Data cleared", "success");
    sendMessage('reset_visuals');
  });
});

els.openPreviewBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'preview.html' });
});

// Download directly from Side Panel context
els.exportCsv.addEventListener('click', () => downloadData('csv'));
els.exportJson.addEventListener('click', () => downloadData('json'));
els.exportXls.addEventListener('click', () => downloadData('xls'));


// --- HELPERS ---

function downloadData(format) {
  chrome.storage.local.get(['koalaData'], (res) => {
    const data = res.koalaData || [];
    if (!data.length) {
      setStatus("No data to export", "error");
      return;
    }

    const headers = [...new Set(data.flatMap(Object.keys))];
    let content = "";
    let type = "text/plain";

    if (format === 'xls') {
      type = "application/vnd.ms-excel";
      content = `<html><head><meta charset='UTF-8'></head><body><table border='1'><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>${data.map(r => `<tr>${headers.map(h => `<td>${r[h] || ''}</td>`).join('')}</tr>`).join('')}</table></body></html>`;
    } else if (format === 'json') {
      type = "application/json";
      content = JSON.stringify(data, null, 2);
    } else {
      type = "text/csv";
      content = headers.join(",") + "\n" + data.map(r => headers.map(h => `"${(r[h] || '').replace(/"/g, '""')}"`).join(",")).join("\n");
    }

    // Create download
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = `koala_extract.${format}`;
    document.body.appendChild(a); // Append to ensure click works in some contexts
    a.click();
    document.body.removeChild(a);

    setStatus(`Exported ${format.toUpperCase()}`, "success");
  });
}

function sendMessage(action, data = {}) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { action, data }).catch(() => {
      setStatus("Please refresh the page", "error");
    });
  });
}

function updateStats(stats) {
  if (stats.count !== undefined) els.count.textContent = stats.count;
  if (stats.pages !== undefined) els.pageCount.textContent = stats.pages;

  const hasData = stats.count > 0;
  els.exportCsv.disabled = !hasData;
  els.exportJson.disabled = !hasData;
  els.exportXls.disabled = !hasData;
}

function setStatus(text, type = 'normal') {
  els.statusText.textContent = text;
  els.statusDot.className = 'status-dot';
  if (type === 'success') els.statusDot.classList.add('active');
  if (type === 'error') els.statusDot.classList.add('error');
  if (type === 'busy') els.statusDot.classList.add('busy');
}

function showPaginationUI() {
  els.pagControls.classList.remove('hidden');
  els.nextBtn.innerHTML = "<span>✅</span> Next Button Set";
  els.nextBtn.classList.remove('btn-secondary');
  els.nextBtn.classList.add('btn-success');
}

function resetToggleBtn() {
  els.toggleBtn.innerHTML = "<span>🎯</span> Start Selection";
  els.toggleBtn.classList.remove('btn-danger');
  els.toggleBtn.classList.add('btn-primary');
}