let overlay;
let selectionMode = 'idle';
let observer;
let isScraping = false;

// --- INITIALIZE ---
function init() {
  if (document.getElementById('koala-overlay')) return;
  createOverlay();

  // Check if we need to continue scraping (Pagination)
  chrome.storage.local.get(['isAutoScraping'], (res) => {
    if (res.isAutoScraping) {
      // Small delay to ensure page is interactive
      setTimeout(checkAutoScrape, 1000);
    }
  });
}

function createOverlay() {
  overlay = document.createElement('div');
  overlay.id = 'koala-overlay';
  overlay.style.cssText = `
    position: absolute; border: 2px dashed #6366f1; background: rgba(99, 102, 241, 0.2);
    pointer-events: none; z-index: 2147483647; display: none; border-radius: 4px;
    transition: all 0.1s ease; box-shadow: 0 0 0 9999px rgba(0,0,0,0.3);
  `;
  document.body.appendChild(overlay);
}

// --- PAGINATION & SCRAPING LOGIC ---
async function checkAutoScrape() {
  const store = await chrome.storage.local.get(['isAutoScraping', 'currentPage', 'maxPages', 'koalaCardSelector', 'koalaNextSelector']);

  if (!store.isAutoScraping) return;

  if (store.currentPage < store.maxPages) {
    // 1. Scrape current page
    if (store.koalaCardSelector) {
      await autoScrape(store.koalaCardSelector);
    }

    // 2. Click Next
    const nextElement = document.querySelector(store.koalaNextSelector);

    if (nextElement) {
      chrome.storage.local.set({ currentPage: store.currentPage + 1 });

      // Setup observer to wait for page change
      setupNavigationObserver(store.koalaCardSelector);

      // Click logic
      const clickableBtn = nextElement.closest('button, a') || nextElement;
      if (typeof clickableBtn.click === 'function') {
        clickableBtn.click();
      } else {
        clickableBtn.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
      }

    } else {
      finishScraping("Next button not found.");
    }
  } else {
    finishScraping("Max pages reached.");
  }
}

function setupNavigationObserver(cardSelector) {
  // Disconnect old observer if any
  if (observer) observer.disconnect();

  let hasNavigated = false;

  // Watch for DOM changes (new items added)
  observer = new MutationObserver((mutations) => {
    if (hasNavigated) return;

    for (const mutation of mutations) {
      if (mutation.addedNodes.length) {
        // Check if new "cards" are added
        const newCards = document.querySelectorAll(cardSelector);
        if (newCards.length > 0) {
          // Debounce slightly to let render finish
          hasNavigated = true;
          observer.disconnect();
          setTimeout(checkAutoScrape, 1500); // Wait for stability
          return;
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Fallback: If no mutation after 10s, try anyway or stop
  setTimeout(() => {
    if (!hasNavigated) {
      observer.disconnect();
      checkAutoScrape(); // Try to scrape whatever is there
    }
  }, 10000);
}

function finishScraping(msg) {
  chrome.storage.local.set({ isAutoScraping: false });
  chrome.runtime.sendMessage({ action: "status_update", status: msg, type: 'success' });
}

// --- INTERACTIONS ---
document.addEventListener('mousemove', (e) => {
  if (selectionMode === 'idle' || !overlay) return;
  const target = e.target;
  if (target === overlay || target === document.body) return;

  const rect = target.getBoundingClientRect();
  overlay.style.display = 'block';
  overlay.style.top = (window.scrollY + rect.top) + 'px';
  overlay.style.left = (window.scrollX + rect.left) + 'px';
  overlay.style.width = rect.width + 'px';
  overlay.style.height = rect.height + 'px';

  if (selectionMode === 'select_next') {
    overlay.style.borderColor = '#10b981'; // Green
    overlay.style.background = 'rgba(16, 185, 129, 0.2)';
  } else {
    overlay.style.borderColor = '#6366f1'; // Indigo
    overlay.style.background = 'rgba(99, 102, 241, 0.2)';
  }
});

document.addEventListener('click', (e) => {
  if (selectionMode === 'idle') return;
  e.preventDefault();
  e.stopPropagation();

  if (selectionMode === 'select_next') {
    const selector = getUniqueSelector(e.target);
    chrome.storage.local.set({ koalaNextSelector: selector });
    chrome.runtime.sendMessage({ action: "next_btn_set" });
    setMode('idle');
  }
  else if (selectionMode === 'select_data') {
    const card = findRepeatingParent(e.target);
    const selector = getCardSelector(card);

    chrome.storage.local.set({ koalaCardSelector: selector });

    // Visual feedback
    document.querySelectorAll(selector).forEach(el => {
      el.style.outline = "2px solid #6366f1";
      el.style.transition = "outline 0.3s";
      setTimeout(() => el.style.outline = "none", 1000);
    });

    autoScrape(selector);
    setMode('idle');
  }
}, true);


// --- CORE LOGIC ---
async function autoScrape(selector) {
  const cards = document.querySelectorAll(selector);
  if (!cards.length) return;

  const newData = Array.from(cards).map(c => extractData(c)).filter(row => Object.keys(row).length > 0);

  // Send to background for processing/storage to keep content script light
  chrome.runtime.sendMessage({ action: "process_data", data: newData });
}

function extractData(card) {
  const row = {};
  // Strategy: Flatten text nodes but try to keep structure
  // We'll use a recursive walker or simple querySelectorAll('*')

  const els = card.querySelectorAll('*');
  let idx = 1;

  // Helper to add field
  const addField = (key, val) => {
    if (!val) return;
    if (row[key]) {
      row[`${key}_${++idx}`] = val;
    } else {
      row[key] = val;
    }
  };

  // 1. Direct text
  if (card.childNodes.length) {
    card.childNodes.forEach(node => {
      if (node.nodeType === 3 && node.textContent.trim()) {
        addField("Text", node.textContent.trim());
      }
    });
  }

  // 2. Children text
  els.forEach(el => {
    // Ignore hidden elements
    if (el.offsetParent === null) return;

    // Get text from leaf nodes or specific elements
    if (el.children.length === 0 && el.textContent?.trim()) {
      let label = "Text";
      const txt = el.textContent.trim();

      // Heuristics
      if (txt.includes('$') || txt.includes('€') || txt.includes('CHF')) label = "Price";
      else if (txt.includes('@')) label = "Email";
      else if (el.tagName === 'H1' || el.tagName === 'H2' || el.tagName === 'H3') label = "Title";
      else if (el.tagName === 'A') {
        label = "Link";
        addField("Link_Url", el.href);
      }
      else if (el.tagName === 'IMG' && el.src) {
        label = "Image";
        addField("Image_Url", el.src);
        return; // Don't add text for images
      }

      addField(label, txt);
    }
  });

  return row;
}

// --- SELECTOR HELPERS ---
function findRepeatingParent(el) {
  let curr = el;
  // Look up to 6 levels
  for (let i = 0; i < 6; i++) {
    if (!curr.parentElement || curr.tagName === 'BODY') break;
    const p = curr.parentElement;

    // Check siblings with same class/tag
    const sibs = Array.from(p.children).filter(c =>
      c !== curr &&
      c.tagName === curr.tagName &&
      c.className === curr.className &&
      c.className !== "" // Avoid generic divs
    );

    if (sibs.length >= 2) return curr; // Found a list!
    curr = p;
  }
  return el;
}

function getCardSelector(el) {
  if (el.className && typeof el.className === 'string' && el.className.trim()) {
    const classes = el.className.trim().split(/\s+/);
    // Filter out common utility classes if possible (hard without list)
    // Use the most specific class combo
    const cls = classes.join('.');
    const sel = `${el.tagName}.${cls}`;
    if (document.querySelectorAll(sel).length > 1) return sel;
  }
  // Fallback to nth-child path if needed, but simple tag is better if unique enough
  return el.tagName;
}

function getUniqueSelector(el) {
  // Optimized for buttons
  if (el.id) return `#${el.id}`;
  let sel = el.tagName.toLowerCase();
  if (el.className && typeof el.className === 'string' && el.className.trim()) {
    sel += `.${el.className.trim().split(/\s+/)[0]}`;
  }
  // Add attributes if needed
  if (el.getAttribute('aria-label')) sel += `[aria-label="${el.getAttribute('aria-label')}"]`;
  return sel;
}

function setMode(mode) {
  selectionMode = mode;
  if (mode === 'idle') overlay.style.display = 'none';
}

// --- MESSAGING ---
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "toggle_mode") setMode(msg.data.mode);
  if (msg.action === "start_auto_scrape") {
    chrome.storage.local.set({ isAutoScraping: true, maxPages: msg.data.maxPages, currentPage: 0 });
    checkAutoScrape();
  }
  if (msg.action === "stop_scrape") {
    chrome.storage.local.set({ isAutoScraping: false });
    isScraping = false;
  }
  if (msg.action === "reset_visuals") {
    location.reload();
  }
});

init();