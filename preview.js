// Load data on start
chrome.storage.local.get(['koalaData'], (result) => {
    const data = result.koalaData || [];
    renderTable(data);
});

// Listen for updates
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.koalaData) {
        renderTable(changes.koalaData.newValue || []);
    }
});

function renderTable(data) {
    const head = document.getElementById('table-head');
    const body = document.getElementById('table-body');
    const empty = document.getElementById('empty-state');
    const count = document.getElementById('total-rows');

    count.textContent = data.length;

    if (data.length === 0) {
        head.innerHTML = '';
        body.innerHTML = '';
        empty.style.display = 'block';
        return;
    }

    empty.style.display = 'none';
    const headers = Object.keys(data[0]);

    head.innerHTML = `<tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>`;

    // Virtualization is better for huge sets, but for <5000 rows this is fine
    // We limit render to 1000 for safety in this demo
    const renderData = data.slice(0, 1000);

    body.innerHTML = renderData.map(row => `
    <tr>${headers.map(h => `<td>${escapeHtml(row[h] || '')}</td>`).join('')}</tr>
  `).join('');
}

function escapeHtml(text) {
    if (typeof text !== 'string') return text;
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Export Logic (Reused)
document.getElementById('export-csv').addEventListener('click', () => download('csv'));
document.getElementById('export-json').addEventListener('click', () => download('json'));
document.getElementById('export-xls').addEventListener('click', () => download('xls'));

function download(format) {
    chrome.storage.local.get(['koalaData'], (res) => {
        const data = res.koalaData || [];
        if (!data.length) return alert("No data!");

        // Send message to background to handle download if needed, 
        // OR just do it here since we are in a tab context (unlike sidepanel sometimes)
        // We'll reuse the logic here for simplicity

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

        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([content], { type }));
        a.download = `koala_data.${format}`;
        a.click();
    });
}
