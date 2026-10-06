/*
 * KoalaScrape service worker.
 *
 * The side panel does all the work (it stays alive while open, so long runs
 * are not cut short by the service worker lifecycle). The worker only makes
 * the toolbar icon open the panel.
 */
function openPanelOnClick() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => console.error('KoalaScrape:', e));
}

chrome.runtime.onInstalled.addListener(openPanelOnClick);
chrome.runtime.onStartup.addListener(openPanelOnClick);
