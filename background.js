chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// --- DATA HANDLING ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "process_data") {
    handleNewData(msg.data);
  }
});

async function handleNewData(newData) {
  const res = await chrome.storage.local.get(['koalaData', 'scrapeStats']);
  let currentData = res.koalaData || [];
  let stats = res.scrapeStats || { count: 0, pages: 0 };

  // Deduplication using a Set of stringified objects for O(1) lookup
  // Note: For very large datasets, we might want to use a hash of the content
  const existingSet = new Set(currentData.map(item => JSON.stringify(item)));
  let addedCount = 0;

  newData.forEach(item => {
    const str = JSON.stringify(item);
    if (!existingSet.has(str)) {
      existingSet.add(str);
      currentData.push(item);
      addedCount++;
    }
  });

  if (addedCount > 0) {
    stats.count = currentData.length;
    // We assume pages incremented in content script, but we can track updates here too

    await chrome.storage.local.set({
      koalaData: currentData,
      scrapeStats: stats
    });

    // Notify UI
    chrome.runtime.sendMessage({
      action: "update_preview",
      data: currentData
    });

    chrome.runtime.sendMessage({
      action: "update_stats",
      data: stats
    });
  }
}