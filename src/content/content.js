/*
 * KoalaScrape in-page agent.
 *
 * Injected on demand by the side panel (chrome.scripting.executeScript),
 * right after core.js. Responsibilities:
 *  - element picking (hover highlight, click to indicate, ↑/↓ to move to the
 *    parent/child, Esc to cancel) with every page handler blocked meanwhile;
 *  - highlights drawn inside a closed shadow root, so neither the page's CSS
 *    can break them nor ours can leak into the page;
 *  - executing extraction / pagination requests coming from the panel.
 */
(() => {
  'use strict';

  const VERSION = '3.0.0';
  const Core = globalThis.KoalaCore;
  if (!Core) return;

  // Keep a live agent of the same version; replace older or orphaned ones
  // (an extension reload leaves the previous content script orphaned).
  const existing = window.__koalaScrape;
  if (existing) {
    try {
      if (existing.version === VERSION && existing.alive()) return;
      existing.destroy();
    } catch (e) {
      /* orphaned agent: its DOM is removed below */
    }
  }
  for (const stale of document.querySelectorAll('koala-scrape-ui')) stale.remove();

  const STALE = 'That element is no longer on the page. Please pick it again.';
  const COLORS = { row: '#6366f1', hover: '#f97316', match: '#f59e0b', next: '#16a34a', focus: '#0ea5e9' };
  const HOVER_COLORS = { next: COLORS.next, loadmore: COLORS.next, column: '#e11d48', inspect: COLORS.focus };
  const PICK_TEXT = {
    list: 'Click an item of the list you want to scrape',
    list2: 'Click the same field in another item of the list',
    column: 'Click a value inside one of the highlighted rows',
    next: 'Click the “Next page” button or link',
    loadmore: 'Click the “Load more” button',
    inspect: 'Click any element to inspect it',
  };

  function alive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Element handles (let the panel refer to elements across messages)
  // ---------------------------------------------------------------------------

  let nextHandle = 1;
  const handleToRef = new Map();
  const elToHandle = new WeakMap();

  function handleOf(el) {
    let h = elToHandle.get(el);
    if (!h) {
      if (handleToRef.size > 5000) handleToRef.clear();
      h = nextHandle++;
      elToHandle.set(el, h);
      handleToRef.set(h, new WeakRef(el));
    }
    return h;
  }

  function elOf(h) {
    const ref = handleToRef.get(h);
    const el = ref && ref.deref();
    return el && el.isConnected ? el : null;
  }

  // ---------------------------------------------------------------------------
  // Overlay UI (closed shadow root)
  // ---------------------------------------------------------------------------

  const CSS = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; }
    .box { position: fixed; left: 0; top: 0; box-sizing: border-box; pointer-events: none;
      border: 2px solid var(--c); border-radius: 3px;
      background: color-mix(in srgb, var(--c) 10%, transparent); }
    .box.thin { border-width: 1.5px; background: color-mix(in srgb, var(--c) 18%, transparent); }
    .box.dashed { border-style: dashed; background: transparent; }
    .badge { position: absolute; left: -2px; bottom: 100%; margin-bottom: 1px;
      background: var(--c); color: #fff; font: 600 10px/15px system-ui, -apple-system, sans-serif;
      padding: 0 5px; border-radius: 3px; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }
    .box.inside .badge { bottom: auto; top: 0; margin: 0; border-radius: 0 0 3px 0; }
    .bar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
      display: flex; align-items: center; gap: 12px; padding: 8px 8px 8px 14px;
      background: #111827; color: #f9fafb; border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.35);
      font: 13px/1.4 system-ui, -apple-system, sans-serif; pointer-events: auto; max-width: calc(100vw - 32px); }
    .bar.top { top: 16px; bottom: auto; }
    .bar[hidden] { display: none; }
    .bar .dot { width: 8px; height: 8px; border-radius: 50%; background: #f97316; flex: none; animation: pulse 1.2s infinite; }
    .bar .keys { color: #9ca3af; font-size: 12px; white-space: nowrap; }
    .bar kbd { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; background: #374151; color: #e5e7eb; border-radius: 4px; padding: 1px 5px; }
    .bar button { all: unset; cursor: pointer; background: #374151; color: #f9fafb; padding: 4px 10px; border-radius: 6px; font: 600 12px system-ui, sans-serif; }
    .bar button:hover { background: #4b5563; }
    @keyframes pulse { 50% { opacity: .35; } }
  `;

  const LAYERS = ['matches', 'rows', 'cols', 'focus', 'hover'];

  function makeUI() {
    const host = document.createElement('koala-scrape-ui');
    host.style.cssText = 'all: initial !important; position: fixed !important; inset: 0 !important; ' +
      'pointer-events: none !important; z-index: 2147483647 !important; display: block !important; contain: strict !important;';
    const root = host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch (e) {
      const style = document.createElement('style');
      style.textContent = CSS;
      root.appendChild(style);
    }
    const layers = {};
    for (const name of LAYERS) {
      const el = document.createElement('div');
      el.className = 'layer';
      root.appendChild(el);
      layers[name] = { el, items: [], pool: [] };
    }
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.hidden = true;
    const dot = document.createElement('span');
    dot.className = 'dot';
    const text = document.createElement('span');
    const keys = document.createElement('span');
    keys.className = 'keys';
    for (const [k, label] of [['↑', 'parent '], ['↓', 'child '], ['Esc', 'cancel']]) {
      const kbd = document.createElement('kbd');
      kbd.textContent = k;
      keys.append(kbd, ' ' + label + ' ');
    }
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', (e) => {
      e.stopPropagation();
      endPick({ cancelled: true });
    });
    bar.append(dot, text, keys, cancel);
    root.appendChild(bar);
    return { host, root, layers, bar, barText: text };
  }

  const ui = makeUI();
  document.documentElement.appendChild(ui.host);

  function createBox(container) {
    const box = document.createElement('div');
    box.className = 'box';
    const badge = document.createElement('span');
    badge.className = 'badge';
    box.appendChild(badge);
    container.appendChild(box);
    return box;
  }

  /** items: [{ el, color, label, dashed, thin }] */
  function setLayer(name, items) {
    ui.layers[name].items = items || [];
    scheduleRender();
    ensureTimer();
  }

  function clearLayers(names) {
    for (const name of names || LAYERS) ui.layers[name].items = [];
    scheduleRender();
  }

  let rafId = 0;
  function scheduleRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      render();
    });
  }

  function render() {
    if (!alive()) {
      destroy();
      return;
    }
    if (!ui.host.isConnected) document.documentElement.appendChild(ui.host);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (const name of LAYERS) {
      const layer = ui.layers[name];
      let used = 0;
      for (const it of layer.items) {
        if (used >= 400) break;
        const el = it.el;
        if (!el || !el.isConnected) continue;
        const r = el.getBoundingClientRect();
        if ((r.width === 0 && r.height === 0) || r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue;
        const box = layer.pool[used] || (layer.pool[used] = createBox(layer.el));
        box.style.display = 'block';
        box.style.transform = 'translate(' + r.left + 'px,' + r.top + 'px)';
        box.style.width = r.width + 'px';
        box.style.height = r.height + 'px';
        box.style.setProperty('--c', it.color);
        box.classList.toggle('dashed', !!it.dashed);
        box.classList.toggle('thin', !!it.thin);
        box.classList.toggle('inside', r.top < 18);
        const badge = box.firstChild;
        badge.textContent = it.label || '';
        badge.style.display = it.label ? '' : 'none';
        used++;
      }
      for (let i = used; i < layer.pool.length; i++) layer.pool[i].style.display = 'none';
    }
  }

  // Dynamic pages move things around: refresh while something is highlighted.
  let timer = 0;
  function ensureTimer() {
    const any = LAYERS.some((n) => ui.layers[n].items.length);
    if (any && !timer) timer = setInterval(scheduleRender, 600);
    if (!any && timer) {
      clearInterval(timer);
      timer = 0;
    }
  }

  function showBar(text) {
    ui.barText.textContent = text;
    ui.bar.hidden = false;
  }

  function hideBar() {
    ui.bar.hidden = true;
  }

  // ---------------------------------------------------------------------------
  // Picking
  // ---------------------------------------------------------------------------

  let pick = null; // { purpose, respond, base, el, stack }

  function startPick(msg, respond) {
    endPick({ cancelled: true });
    pick = { purpose: msg.purpose || 'inspect', respond, base: null, el: null, stack: [] };
    showBar(msg.hint || PICK_TEXT[pick.purpose] || 'Click an element');
  }

  function endPick(result) {
    if (!pick) return;
    const p = pick;
    pick = null;
    hideBar();
    setLayer('hover', []);
    try {
      p.respond(result);
    } catch (e) {
      /* panel went away */
    }
  }

  function targetFrom(e) {
    for (const n of e.composedPath()) {
      if (n === ui.host) return null;
      if (n.nodeType === 1 && n.getRootNode() === document && n !== document.documentElement) return n;
    }
    return null;
  }

  function drawHover() {
    const el = pick && pick.el;
    if (!el) return setLayer('hover', []);
    const r = el.getBoundingClientRect();
    const label = Core.describe(el) + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    setLayer('hover', [{ el, color: HOVER_COLORS[pick.purpose] || COLORS.hover, label }]);
  }

  function onMove(e) {
    if (!pick) return;
    ui.bar.classList.toggle('top', e.clientY > window.innerHeight - 110);
    const t = targetFrom(e);
    if (!t || t === pick.base) return;
    pick.base = t;
    pick.el = t;
    pick.stack = [];
    drawHover();
  }

  function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onBlocked(e) {
    if (!pick) return;
    const t = targetFrom(e);
    if (!t && e.composedPath().includes(ui.host)) return; // our own toolbar
    swallow(e);
    if (e.type === 'click' && e.button === 0 && t) {
      const el = pick.base === t && pick.el ? pick.el : t;
      const purpose = pick.purpose;
      endPick(elementInfo(el, purpose));
    }
  }

  /** Keyboard control while picking. Returns true when the key was used. */
  function pickKey(key) {
    if (!pick) return false;
    if (key === 'Escape') {
      endPick({ cancelled: true });
      return true;
    }
    if (!pick.el) return false;
    if (key === 'ArrowUp') {
      const parent = pick.el.parentElement;
      if (!parent || parent === document.documentElement) return false;
      pick.stack.push(pick.el);
      pick.el = parent;
      drawHover();
      return true;
    }
    if (key === 'ArrowDown') {
      const child = pick.stack.pop() || pick.el.firstElementChild;
      if (!child) return false;
      pick.el = child;
      drawHover();
      return true;
    }
    if (key === 'Enter') {
      const purpose = pick.purpose;
      endPick(elementInfo(pick.el, purpose));
      return true;
    }
    return false;
  }

  function onKey(e) {
    if (pick && pickKey(e.key)) swallow(e);
  }

  // ---------------------------------------------------------------------------
  // Element description for the panel (explorer)
  // ---------------------------------------------------------------------------

  function properties(el) {
    const r = el.getBoundingClientRect();
    const attrs = {};
    for (const a of Array.from(el.attributes)) attrs[a.name] = a.value.length > 300 ? a.value.slice(0, 300) + '…' : a.value;
    const props = {
      tag: el.localName,
      text: Core.textOf(el).slice(0, 500),
      'own text': Core.ownText(el).slice(0, 200),
      children: String(el.children.length),
      position: Math.round(r.left + window.scrollX) + ', ' + Math.round(r.top + window.scrollY),
      size: Math.round(r.width) + ' × ' + Math.round(r.height),
      visible: String(Core.defaultVisible(el)),
    };
    if (typeof el.value === 'string' && el.value) props.value = el.value.slice(0, 300);
    if (typeof el.href === 'string' && el.href) props.href = el.href;
    if (el.tagName === 'IMG') props.src = Core.imageUrl(el);
    return { props, attrs };
  }

  function tree(el) {
    const ancestors = [];
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      ancestors.unshift({ handle: handleOf(n), label: Core.describe(n) });
    }
    const kids = Array.from(el.children).filter((c) => c !== ui.host);
    const children = kids.slice(0, 60).map((c) => ({ handle: handleOf(c), label: Core.describe(c), count: c.children.length }));
    const siblings = el.parentElement ? Array.from(el.parentElement.children).filter((c) => c !== ui.host) : [el];
    const idx = siblings.indexOf(el);
    return {
      ancestors,
      children,
      moreChildren: Math.max(0, kids.length - 60),
      prev: idx > 0 ? handleOf(siblings[idx - 1]) : null,
      next: idx >= 0 && idx < siblings.length - 1 ? handleOf(siblings[idx + 1]) : null,
      index: idx + 1,
      siblingCount: siblings.length,
    };
  }

  function elementInfo(el, purpose) {
    const pagination = purpose === 'next' || purpose === 'loadmore';
    if (pagination) el = Core.clickableOf(el);
    const model = Core.optimizeModel(Core.buildModel(el), el);
    return {
      handle: handleOf(el),
      purpose,
      label: Core.describe(el),
      tag: el.localName,
      text: Core.textOf(el).slice(0, 300),
      selector: Core.compileModel(model),
      xpath: Core.xpathFor(el),
      model,
      props: properties(el),
      tree: tree(el),
      target: pagination ? Core.describeTarget(el) : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Requests from the panel
  // ---------------------------------------------------------------------------

  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  }

  function columnItems(recipe, rows) {
    const items = [];
    (recipe.columns || []).forEach((col, ci) => {
      if (!col.selector) return; // the row itself is already outlined
      const color = Core.COLUMN_COLORS[ci % Core.COLUMN_COLORS.length];
      for (const row of rows.slice(0, 60)) {
        let el = null;
        try {
          el = Core.queryIn(row, col.selector)[0];
        } catch (e) {
          return;
        }
        if (el) items.push({ el, color, thin: true });
      }
    });
    return items;
  }

  function targetLabel(el) {
    const text = Core.textOf(el).slice(0, 40);
    return Core.describe(el) + (text ? ' “' + text + '”' : '');
  }

  const handlers = {
    ping: () => ({ ok: true, version: VERSION, url: location.href, title: document.title }),

    cancelPick: () => {
      endPick({ cancelled: true });
      return { ok: true };
    },

    // Keys pressed in the side panel while picking (the panel has the focus).
    pickKey: ({ key }) => ({ handled: pickKey(key) }),

    inspect: ({ handle }) => {
      const el = elOf(handle);
      if (!el) throw new Error(STALE);
      const info = elementInfo(el, 'inspect');
      setLayer('focus', [{ el, color: COLORS.focus, label: info.label }]);
      if (!inViewport(el)) el.scrollIntoView({ block: 'center' });
      return info;
    },

    focus: ({ handle }) => {
      const el = elOf(handle);
      setLayer('focus', el ? [{ el, color: COLORS.focus, label: Core.describe(el) }] : []);
      return { ok: !!el };
    },

    validate: ({ selector, rowSelector, highlight, scroll }) => {
      let els;
      if (rowSelector) {
        els = [];
        for (const row of Core.queryAll(rowSelector, document)) {
          const el = Core.queryIn(row, selector)[0];
          if (el) els.push(el);
        }
      } else {
        els = Core.queryAll(selector, document);
      }
      if (highlight) {
        setLayer('matches', els.map((el, i) => ({ el, color: COLORS.match, label: els.length > 1 ? String(i + 1) : '' })));
        if (scroll && els[0] && !inViewport(els[0])) els[0].scrollIntoView({ block: 'center' });
      }
      return { count: els.length };
    },

    clearHighlights: ({ layers }) => {
      clearLayers(layers);
      ensureTimer();
      return { ok: true };
    },

    detectList: ({ handles, level }) => {
      const els = (handles || []).map(elOf);
      if (!els[0]) throw new Error(STALE);
      const res = Core.detectListFromExamples(els[0], els[1] || null, { level });
      const rows = Core.queryAll(res.rowSelector, document);
      return Object.assign({}, res, { rowCount: rows.length, columns: Core.detectColumns(rows) });
    },

    autoDetect: ({ index }) => {
      const lists = Core.findLists(document);
      if (!lists.length) throw new Error('No repeating list found on this page. Try “Select list item” instead.');
      const i = ((index || 0) % lists.length + lists.length) % lists.length;
      const rows = Core.queryAll(lists[i].rowSelector, document);
      if (rows[0] && !inViewport(rows[0])) rows[0].scrollIntoView({ block: 'center' });
      return { rowSelector: lists[i].rowSelector, rowCount: rows.length, columns: Core.detectColumns(rows), index: i, total: lists.length };
    },

    detectColumns: ({ rowSelector }) => {
      const rows = Core.queryAll(rowSelector, document);
      return { rowCount: rows.length, columns: Core.detectColumns(rows) };
    },

    columnFromHandle: ({ rowSelector, handle, names }) => {
      const el = elOf(handle);
      if (!el) throw new Error(STALE);
      const rows = Core.queryAll(rowSelector, document);
      const row = rows.find((r) => r.contains(el));
      if (!row) throw new Error('That element is not inside one of the highlighted rows. Pick a value inside a row.');
      const column = Core.columnFor(row, el, names);
      const filled = rows.filter((r) => Core.queryIn(r, column.selector).length).length;
      return { column, filled, rowCount: rows.length };
    },

    preview: ({ recipe, limit, highlight }) => {
      const rows = recipe.rowSelector ? Core.queryAll(recipe.rowSelector, document) : [];
      if (highlight !== false) {
        setLayer('rows', rows.map((el, i) => ({ el, color: COLORS.row, label: String(i + 1) })));
        setLayer('cols', columnItems(recipe, rows));
        const target = recipe.pagination && recipe.pagination.type !== 'none' && recipe.pagination.target;
        const tEl = target ? Core.resolveTarget(target, document, { fallback: false }) : null;
        setLayer('focus', tEl ? [{ el: tEl, color: COLORS.next, label: recipe.pagination.type === 'loadmore' ? 'Load more' : 'Next' }] : []);
      }
      if (!rows.length) return { rows: [], rowCount: 0 };
      return Core.extract(recipe, document, { limit: limit || 50 });
    },

    extract: ({ recipe }) => {
      const res = Core.extract(recipe, document);
      return { rows: res.rows, rowCount: res.rowCount, url: location.href, title: document.title };
    },

    signature: ({ rowSelector }) => {
      let rows = [];
      try {
        rows = rowSelector ? Core.queryAll(rowSelector, document) : [];
      } catch (e) {
        rows = [];
      }
      const first = rows[0] ? Core.textOf(rows[0]).slice(0, 300) : '';
      const last = rows.length ? Core.textOf(rows[rows.length - 1]).slice(0, 300) : '';
      return {
        count: rows.length,
        url: location.href,
        ready: document.readyState,
        sig: [location.href, rows.length, Core.hashString(first), Core.hashString(last)].join('|'),
      };
    },

    describeTarget: ({ handle }) => {
      const el = elOf(handle);
      if (!el) throw new Error(STALE);
      return Core.describeTarget(el);
    },

    targetState: ({ target, highlight }) => {
      const el = target ? Core.resolveTarget(target, document) : null;
      if (highlight) setLayer('focus', el ? [{ el, color: COLORS.next, label: targetLabel(el) }] : []);
      return { found: !!el, disabled: el ? Core.isDisabled(el) : false, label: el ? targetLabel(el) : '' };
    },

    clickTarget: ({ target }) => {
      const el = Core.resolveTarget(target, document);
      if (!el) return { clicked: false, reason: 'not-found' };
      if (Core.isDisabled(el)) return { clicked: false, reason: 'disabled', label: targetLabel(el) };
      const label = targetLabel(el);
      el.scrollIntoView({ block: 'center' });
      // Respond first, click a moment later: a full navigation must not
      // swallow the response.
      setTimeout(() => {
        const opts = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
        try {
          el.dispatchEvent(new PointerEvent('pointerdown', opts));
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          el.dispatchEvent(new PointerEvent('pointerup', opts));
          el.dispatchEvent(new MouseEvent('mouseup', opts));
        } catch (e) {
          /* ignore */
        }
        el.click();
      }, 60);
      return { clicked: true, label };
    },

    scrollMore: ({ rowSelector }) => {
      let rows = [];
      try {
        rows = rowSelector ? Core.queryAll(rowSelector, document) : [];
      } catch (e) {
        rows = [];
      }
      const last = rows[rows.length - 1];
      if (last) last.scrollIntoView({ block: 'end' });
      for (let n = last && last.parentElement; n && n !== document.body; n = n.parentElement) {
        if (n.scrollHeight > n.clientHeight + 4) {
          const oy = getComputedStyle(n).overflowY;
          if (oy === 'auto' || oy === 'scroll') n.scrollTop = n.scrollHeight;
        }
      }
      const se = document.scrollingElement || document.documentElement;
      window.scrollTo(0, se.scrollHeight);
      window.dispatchEvent(new Event('scroll'));
      return { ok: true, count: rows.length };
    },
  };

  function onMessage(msg, sender, respond) {
    if (!msg || typeof msg.type !== 'string') return false;
    if (!alive()) {
      destroy();
      return false;
    }
    if (msg.type === 'pick') {
      startPick(msg, respond);
      return true; // respond later, when the user clicks
    }
    const fn = handlers[msg.type];
    if (!fn) return false;
    try {
      const res = fn(msg);
      respond(res === undefined ? { ok: true } : res);
    } catch (e) {
      respond({ error: (e && e.message) || String(e) });
    }
    return false;
  }

  // The panel keeps a port open; when it closes (or targets another tab) the
  // highlights go away and any pending pick is cancelled.
  const ports = new Set();
  function onConnect(port) {
    if (port.name !== 'koala-panel') return;
    ports.add(port);
    port.onDisconnect.addListener(() => {
      ports.delete(port);
      if (!ports.size) {
        endPick({ cancelled: true });
        clearLayers();
        ensureTimer();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  const listeners = [];
  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  }

  on(window, 'mousemove', onMove, { capture: true, passive: true });
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'submit']) {
    on(window, type, onBlocked, { capture: true });
  }
  on(window, 'keydown', onKey, { capture: true });
  on(window, 'scroll', scheduleRender, { capture: true, passive: true });
  on(window, 'resize', scheduleRender, { passive: true });

  chrome.runtime.onMessage.addListener(onMessage);
  chrome.runtime.onConnect.addListener(onConnect);

  function destroy() {
    try {
      endPick({ cancelled: true });
    } catch (e) {
      /* ignore */
    }
    for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
    listeners.length = 0;
    if (timer) clearInterval(timer);
    timer = 0;
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.runtime.onConnect.removeListener(onConnect);
    } catch (e) {
      /* orphaned */
    }
    ui.host.remove();
    if (window.__koalaScrape === api) delete window.__koalaScrape;
  }

  const api = { version: VERSION, alive, destroy };
  window.__koalaScrape = api;
})();
