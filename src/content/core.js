/*
 * KoalaScrape core engine.
 *
 * Pure DOM logic shared by the in-page agent (content script), the side panel
 * (selector compilation only) and the unit tests (jsdom). No chrome.* APIs here.
 *
 * Main concepts
 *  - Selector model: an element's ancestor chain where every node lists the
 *    attributes that could identify it (tag, id, classes, attributes, index,
 *    text). Each attribute can be toggled on/off, exactly like the selector
 *    editor in UiPath's UI Explorer. A model compiles to CSS, or to XPath when
 *    a text condition is enabled (CSS cannot match on text).
 *  - List detection: from one (or two) example elements, find the repeating
 *    "row" element and a selector that matches every row.
 *  - Columns: per-row relative selectors, so every row is extracted with the
 *    same rules and columns stay aligned.
 */
(function (global) {
  'use strict';

  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const ORDERED_SNAPSHOT = 7; // XPathResult.ORDERED_NODE_SNAPSHOT_TYPE

  // ---------------------------------------------------------------------------
  // Escaping
  // ---------------------------------------------------------------------------

  /** CSS.escape() polyfill (jsdom lacks it). Follows the CSSOM spec. */
  function cssEscape(value) {
    const string = String(value);
    const length = string.length;
    const first = string.charCodeAt(0);
    let result = '';
    if (length === 1 && first === 0x2d) return '\\' + string;
    for (let i = 0; i < length; i++) {
      const code = string.charCodeAt(i);
      if (code === 0) {
        result += '\uFFFD';
      } else if (
        (code >= 0x1 && code <= 0x1f) || code === 0x7f ||
        (i === 0 && code >= 0x30 && code <= 0x39) ||
        (i === 1 && code >= 0x30 && code <= 0x39 && first === 0x2d)
      ) {
        result += '\\' + code.toString(16) + ' ';
      } else if (
        code >= 0x80 || code === 0x2d || code === 0x5f ||
        (code >= 0x30 && code <= 0x39) ||
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a)
      ) {
        result += string.charAt(i);
      } else {
        result += '\\' + string.charAt(i);
      }
    }
    return result;
  }

  /** Quoted CSS string for attribute selectors. */
  function cssString(value) {
    return '"' + String(value).replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a ') + '"';
  }

  /** Quoted XPath string literal (XPath 1.0 has no escape sequences). */
  function xpathString(value) {
    const v = String(value);
    if (!v.includes("'")) return "'" + v + "'";
    if (!v.includes('"')) return '"' + v + '"';
    return 'concat(' + v.split("'").map((s) => "'" + s + "'").join(", \"'\", ") + ')';
  }

  // ---------------------------------------------------------------------------
  // Classification of ids, classes and attributes
  // ---------------------------------------------------------------------------

  const STATE_CLASS_RE = /^(?:is-|has-|ng-|v-enter|v-leave|js-is-)|^(?:active|selected|current|hover|hovered|focus|focused|focus-visible|open|opened|closed|expanded|collapsed|show|showing|shown|visible|invisible|hidden|disabled|enabled|checked|loading|loaded|odd|even|first|last|in|fade|animated|clearfix|cf|lazyload|lazyloaded|lazyloading)$/i;
  const DYNAMIC_CLASS_RE = /^(?:css|sc|jsx|svelte|emotion|styled|tss|makeStyles|jss)[-_]|\d{3,}|__[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*$|^_[A-Za-z0-9]{5,}$/;
  const UTILITY_CLASS_RE = /[:/[\]!%@.]|^-?(?:[mp][trblxyse]?|gap|space-[xy]|w|h|min-w|min-h|max-w|max-h|inset|top|left|right|bottom|z|order|col|col-span|row-span|basis|grow|shrink|leading|tracking|indent|opacity|rounded|border|ring|shadow|blur|text|font|bg|from|via|to|fill|stroke|decoration|outline|divide|place|items|justify|content|self|overflow|object|cursor|select|transition|duration|delay|ease|animate|scale|rotate|translate|skew|origin|aspect|columns|break|line-clamp|d|align|float|g|gx|gy|offset|fs|fw|lh|ms|me|ps|pe)-|^(?:flex|grid|block|inline|inline-block|inline-flex|contents|relative|absolute|fixed|sticky|static|container|container-fluid|truncate|underline|uppercase|lowercase|capitalize|italic|grow|shrink|sr-only|row|col|pull-left|pull-right)$/;

  function looksRandom(token) {
    if (/^(?=.*\d)(?=.*[a-zA-Z])[a-zA-Z0-9]{5,12}$/.test(token) && !/^[a-zA-Z]+\d{1,2}$/.test(token)) return true;
    if (/^[a-zA-Z]{5,8}$/.test(token) && /[a-z][A-Z]/.test(token) && /[A-Z][a-z]?[A-Z]/.test(token)) return true;
    return false;
  }

  /** 'state' | 'dynamic' | 'utility' | 'semantic' */
  function classKind(cls) {
    if (STATE_CLASS_RE.test(cls)) return 'state';
    if (DYNAMIC_CLASS_RE.test(cls) || looksRandom(cls)) return 'dynamic';
    if (UTILITY_CLASS_RE.test(cls)) return 'utility';
    return 'semantic';
  }

  function classList(el) {
    return el.classList ? Array.from(el.classList).filter(Boolean) : [];
  }

  function semanticClasses(el) {
    return classList(el).filter((c) => classKind(c) === 'semantic');
  }

  /** Classes that are reasonably stable (semantic or utility). */
  function groupClasses(el) {
    return classList(el).filter((c) => {
      const kind = classKind(c);
      return kind === 'semantic' || kind === 'utility';
    });
  }

  function isStableId(id) {
    if (!id || id.length > 64) return false;
    if (/^\d+$/.test(id) || /\d{4,}/.test(id)) return false;
    if (/[0-9a-f]{8}-?[0-9a-f]{4}/i.test(id)) return false;
    if (/^(?::|ember\d|react-|mui-|radix-|headlessui-|yui_|ext-gen|ui-id-|__BVID__|gwt-|j_id|vaadin-|rc_|rc-|downshift-|aria-|tippy-|popover-|tooltip-|select2-|chakra-|_)/i.test(id)) return false;
    return !looksRandom(id);
  }

  const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-automation-id', 'data-automation'];
  const NAME_ATTRS = ['name', 'itemprop', 'aria-label', 'title', 'alt', 'placeholder', 'for', 'data-field', 'data-role'];
  const WEAK_ATTRS = ['role', 'type', 'rel', 'href', 'src', 'value', 'aria-labelledby'];
  const MODEL_ATTR_RE = /^(?:data-[\w-]+|aria-label|role|name|type|title|alt|placeholder|itemprop|itemtype|rel|href|src|for|value|lang|dir|target|method|action)$/;

  // ---------------------------------------------------------------------------
  // Small DOM helpers
  // ---------------------------------------------------------------------------

  function tagOf(el) {
    return el.localName || el.tagName.toLowerCase();
  }

  function isHtml(el) {
    return !el.namespaceURI || el.namespaceURI === HTML_NS;
  }

  function nthOfType(el) {
    const parent = el.parentElement;
    if (!parent) return { index: 1, count: 1 };
    let index = 0;
    let count = 0;
    for (const sib of parent.children) {
      if (sib.localName === el.localName && sib.namespaceURI === el.namespaceURI) {
        count++;
        if (sib === el) index = count;
      }
    }
    return { index, count };
  }

  function cleanText(s) {
    return String(s == null ? '' : s).replace(/[\s\u00a0\u200b\u200c\u200d\ufeff]+/g, ' ').trim();
  }

  function textOf(el) {
    const raw = typeof el.innerText === 'string' ? el.innerText : el.textContent;
    return cleanText(raw);
  }

  function ownText(el) {
    let s = '';
    for (const n of el.childNodes) if (n.nodeType === 3) s += n.nodeValue + ' ';
    return cleanText(s);
  }

  /** Whitespace normalised exactly like XPath normalize-space(.). */
  function xpathText(el) {
    return String(el.textContent || '').replace(/[ \t\r\n]+/g, ' ').trim();
  }

  function absUrl(url, el) {
    if (!url) return '';
    try {
      const doc = el && el.ownerDocument;
      return new URL(url, doc ? doc.baseURI : undefined).href;
    } catch (e) {
      return url;
    }
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return '';
    let s = tagOf(el);
    if (el.id) s += '#' + el.id;
    const cls = classList(el).slice(0, 2);
    if (cls.length) s += '.' + cls.join('.');
    if (classList(el).length > 2) s += '…';
    return s;
  }

  function defaultVisible(el) {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });
    }
    return true;
  }

  function commonAncestor(a, b) {
    const seen = new Set();
    for (let n = a; n; n = n.parentElement) seen.add(n);
    for (let n = b; n; n = n.parentElement) if (seen.has(n)) return n;
    return null;
  }

  function uniq(list) {
    return Array.from(new Set(list));
  }

  // ---------------------------------------------------------------------------
  // Querying (CSS or XPath)
  // ---------------------------------------------------------------------------

  function isXPath(sel) {
    return /^\s*(?:\.{0,2}\/|\()/.test(sel || '');
  }

  /** Query the document (or a subtree) with a CSS selector or an XPath. */
  function queryAll(sel, root) {
    sel = (sel || '').trim();
    if (!sel) return [];
    const ctx = root || global.document;
    const doc = ctx.ownerDocument || ctx;
    try {
      if (isXPath(sel)) {
        const res = doc.evaluate(sel, ctx, null, ORDERED_SNAPSHOT, null);
        const out = [];
        for (let i = 0; i < res.snapshotLength; i++) {
          const n = res.snapshotItem(i);
          if (n && n.nodeType === 1) out.push(n);
        }
        return out;
      }
      return Array.from(ctx.querySelectorAll(sel)).filter((n) => n.localName !== 'koala-scrape-ui');
    } catch (e) {
      throw new Error('Invalid selector: ' + sel);
    }
  }

  /**
   * Query relative to a row. CSS is evaluated with :scope so a selector like
   * "> h3" or "div > span" never matches ancestors outside the row. An empty
   * selector (or ":scope") means the row itself.
   */
  function queryIn(row, sel) {
    sel = (sel || '').trim();
    if (!sel || sel === ':scope') return [row];
    if (isXPath(sel)) {
      if (sel.startsWith('/')) sel = '.' + sel;
      return queryAll(sel, row);
    }
    if (sel.includes(',')) {
      return queryAll(sel, row);
    }
    if (!sel.startsWith(':scope')) sel = ':scope ' + sel;
    return queryAll(sel, row);
  }

  // ---------------------------------------------------------------------------
  // Selector model (UI Explorer)
  // ---------------------------------------------------------------------------

  function nodeModel(el) {
    const tag = tagOf(el);
    const parts = [{ k: 'tag', v: tag, on: false }];
    if (el.id) parts.push({ k: 'id', v: el.id, on: false, stable: isStableId(el.id) });
    for (const c of classList(el)) parts.push({ k: 'class', v: c, on: false, kind: classKind(c) });
    for (const attr of Array.from(el.attributes || [])) {
      const name = attr.name;
      if (!MODEL_ATTR_RE.test(name)) continue;
      if (!attr.value || attr.value.length > 120) continue;
      parts.push({ k: 'attr', n: name, v: attr.value, on: false });
    }
    const nth = nthOfType(el);
    if (nth.count > 1) parts.push({ k: 'nth', v: nth.index, on: false });
    const text = xpathText(el);
    if (text && text.length <= 60) parts.push({ k: 'text', v: text, on: false });
    return { tag, svg: !isHtml(el), label: describe(el), parts, on: false };
  }

  /** Ancestor chain (body … el) as editable nodes, everything switched off. */
  function buildModel(el) {
    const chain = [];
    for (let n = el; n && n.nodeType === 1 && n.localName !== 'html'; n = n.parentElement) chain.unshift(n);
    return chain.map(nodeModel);
  }

  function nodeCss(node) {
    const on = node.parts.filter((p) => p.on);
    const nth = on.find((p) => p.k === 'nth');
    let s = on.some((p) => p.k === 'tag') || nth ? cssEscape(node.tag) : '';
    for (const p of on) {
      if (p.k === 'id') s += '#' + cssEscape(p.v);
      else if (p.k === 'class') s += '.' + cssEscape(p.v);
      else if (p.k === 'attr') s += '[' + cssEscape(p.n) + '=' + cssString(p.v) + ']';
    }
    if (nth) s += ':nth-of-type(' + nth.v + ')';
    return s || '*';
  }

  function nodeXPath(node) {
    const on = node.parts.filter((p) => p.on);
    const nth = on.find((p) => p.k === 'nth');
    const named = on.some((p) => p.k === 'tag') || nth;
    let s;
    if (!named) s = '*';
    else if (node.svg) s = "*[local-name()='" + node.tag + "']";
    else s = node.tag;
    if (nth) s += '[' + nth.v + ']';
    for (const p of on) {
      if (p.k === 'id') s += '[@id=' + xpathString(p.v) + ']';
      else if (p.k === 'class') s += "[contains(concat(' ', normalize-space(@class), ' '), " + xpathString(' ' + p.v + ' ') + ')]';
      else if (p.k === 'attr') s += '[@' + p.n + '=' + xpathString(p.v) + ']';
      else if (p.k === 'text') s += '[normalize-space(.)=' + xpathString(p.v) + ']';
    }
    return s;
  }

  /** Compile a model to CSS (or XPath when a text condition is enabled). */
  function compileModel(model) {
    const useXPath = model.some((n) => n.on && n.parts.some((p) => p.on && p.k === 'text'));
    let out = '';
    let prev = -2;
    model.forEach((node, i) => {
      if (!node.on) return;
      if (useXPath) {
        out += (out && prev === i - 1 ? '/' : '//') + nodeXPath(node);
      } else {
        out += (out ? (prev === i - 1 ? ' > ' : ' ') : '') + nodeCss(node);
      }
      prev = i;
    });
    return out;
  }

  function candidatesFor(node) {
    const P = node.parts;
    const tagI = P.findIndex((p) => p.k === 'tag');
    const out = [];
    const add = (idxs, strong) => out.push({ idxs: [tagI].concat(idxs), strong });
    P.forEach((p, i) => { if (p.k === 'id' && p.stable) add([i], true); });
    P.forEach((p, i) => { if (p.k === 'attr' && TEST_ATTRS.includes(p.n)) add([i], true); });
    P.forEach((p, i) => { if (p.k === 'attr' && NAME_ATTRS.includes(p.n)) add([i], true); });
    const sem = [];
    P.forEach((p, i) => { if (p.k === 'class' && p.kind === 'semantic') sem.push(i); });
    sem.forEach((i) => add([i], true));
    if (sem.length > 1) add(sem.slice(0, 3), true);
    P.forEach((p, i) => { if (p.k === 'attr' && WEAK_ATTRS.includes(p.n)) add([i], false); });
    const util = [];
    P.forEach((p, i) => { if (p.k === 'class' && p.kind === 'utility') util.push(i); });
    if (util.length) add(util.slice(0, 4), false);
    add([], false);
    return out;
  }

  function clearNode(node) {
    node.on = false;
    node.parts.forEach((p) => { p.on = false; });
  }

  function applyCandidate(node, cand) {
    node.parts.forEach((p) => { p.on = false; });
    cand.idxs.forEach((i) => { if (node.parts[i]) node.parts[i].on = true; });
    node.on = true;
  }

  /**
   * Switch on the attributes that give a short, robust, unique selector for
   * the last node of the model. Strategy: target alone → one strong ancestor
   * + target → full indexed path, then prune everything not needed.
   */
  function optimizeModel(model, el) {
    if (!model.length) return model;
    optimizeInto(model, el);
    // Nodes left out of the selector show no ticked attributes in the editor.
    model.forEach((n) => { if (!n.on) n.parts.forEach((p) => { p.on = false; }); });
    return model;
  }

  function optimizeInto(model, el) {
    const doc = el.ownerDocument;
    const T = model.length - 1;
    model.forEach(clearNode);

    const isUnique = () => {
      const sel = compileModel(model);
      try {
        const m = queryAll(sel, doc);
        return m.length === 1 && m[0] === el;
      } catch (e) {
        return false;
      }
    };
    const countOf = () => {
      try { return queryAll(compileModel(model), doc).length; } catch (e) { return Infinity; }
    };

    // Phase 1: the target alone.
    const targetCands = candidatesFor(model[T]);
    for (const cand of targetCands) {
      applyCandidate(model[T], cand);
      if (isUnique()) return model;
    }

    // Phase 2: one strong ancestor + the target's most specific candidate.
    let best = targetCands[targetCands.length - 1];
    let bestCount = Infinity;
    for (const cand of targetCands) {
      applyCandidate(model[T], cand);
      const c = countOf();
      if (c >= 1 && c < bestCount) { bestCount = c; best = cand; }
    }
    applyCandidate(model[T], best);
    for (let i = T - 1; i >= 0; i--) {
      for (const cand of candidatesFor(model[i]).filter((c) => c.strong)) {
        applyCandidate(model[i], cand);
        if (isUnique()) return model;
      }
      clearNode(model[i]);
    }

    // Phase 3: indexed path from the closest uniquely identified ancestor.
    let anchor = 0;
    for (let i = T - 1; i >= 0; i--) {
      const idPart = model[i].parts.find((p) => p.k === 'id' && p.stable);
      if (idPart && queryAll('#' + cssEscape(idPart.v), doc).length === 1) { anchor = i; break; }
    }
    for (let i = anchor; i <= T; i++) {
      const node = model[i];
      node.on = true;
      node.parts.forEach((p) => {
        if (p.k === 'tag') p.on = true;
        if (i === anchor && p.k === 'id' && p.stable) p.on = true;
        if (p.k === 'nth') p.on = true;
      });
      if (i !== anchor) {
        node.parts.filter((p) => p.k === 'class' && p.kind === 'semantic').slice(0, 2).forEach((p) => { p.on = true; });
      }
    }
    if (!isUnique()) return model; // best effort (should not happen)

    // Prune ancestors that are not needed, then positional indexes. Semantic
    // classes stay: "div.col:nth-of-type(2) span.price" survives page changes
    // far better than "div:nth-of-type(2) span".
    for (let i = 0; i < T; i++) {
      if (!model[i].on) continue;
      model[i].on = false;
      if (!isUnique()) model[i].on = true;
    }
    for (let i = 0; i <= T; i++) {
      if (!model[i].on) continue;
      const nth = model[i].parts.find((p) => p.k === 'nth' && p.on);
      if (nth) {
        nth.on = false;
        if (!isUnique()) nth.on = true;
      }
    }
    return model;
  }

  /** Short unique selector for an element. */
  function uniqueSelector(el) {
    const doc = el.ownerDocument;
    if (el === doc.documentElement) return 'html';
    if (el === doc.body) return 'body';
    return compileModel(optimizeModel(buildModel(el), el));
  }

  function xpathName(el) {
    return isHtml(el) ? tagOf(el) : "*[local-name()='" + tagOf(el) + "']";
  }

  /** XPath anchored on the closest stable unique id, else absolute. */
  function xpathFor(el) {
    const doc = el.ownerDocument;
    const steps = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.id && isStableId(n.id) && doc.querySelectorAll('#' + cssEscape(n.id)).length === 1) {
        return '//*[@id=' + xpathString(n.id) + ']' + (steps.length ? '/' + steps.join('/') : '');
      }
      const { index, count } = nthOfType(n);
      steps.unshift(count > 1 ? xpathName(n) + '[' + index + ']' : xpathName(n));
    }
    return '/' + steps.join('/');
  }

  // ---------------------------------------------------------------------------
  // Data nodes & values
  // ---------------------------------------------------------------------------

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'CANVAS', 'HEAD', 'META', 'LINK', 'svg', 'SVG']);
  const INLINE_FORMAT = new Set(['B', 'I', 'EM', 'STRONG', 'SMALL', 'SUP', 'SUB', 'BR', 'MARK', 'U', 'S', 'DEL', 'INS', 'CODE', 'ABBR', 'CITE', 'Q', 'WBR', 'SPAN', 'FONT', 'BDI', 'BDO', 'DFN', 'KBD', 'SAMP', 'VAR']);

  function isSkipped(el) {
    return SKIP_TAGS.has(el.tagName) || el.localName === 'svg' || el.localName === 'koala-scrape-ui';
  }

  function isFormatting(el) {
    if (!INLINE_FORMAT.has(el.tagName) || el.classList.length || el.id) return false;
    for (const c of el.children) if (!isFormatting(c)) return false;
    return true;
  }

  /** Element whose whole text is one value (only inline formatting inside). */
  function isTextContainer(el) {
    for (const c of el.children) if (!isFormatting(c)) return false;
    return xpathText(el) !== '';
  }

  function usableHref(a) {
    const href = a.getAttribute('href');
    return !!href && !/^\s*(?:#|javascript:)/i.test(href);
  }

  function imageUrl(el) {
    const img = el.tagName === 'IMG' ? el : el.querySelector && el.querySelector('img');
    if (img) {
      const raw = img.getAttribute('src') || '';
      const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') ||
        img.getAttribute('data-original') || img.getAttribute('data-lazy');
      if (lazy && (!raw || raw.startsWith('data:'))) return absUrl(lazy, img);
      if (img.currentSrc) return img.currentSrc;
      if (raw) return absUrl(raw, img);
      const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
      if (srcset) return absUrl(srcset.split(',')[0].trim().split(/\s+/)[0], img);
      return '';
    }
    const style = el.getAttribute && el.getAttribute('style');
    const m = style && /background(?:-image)?\s*:[^;]*url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(style);
    return m ? absUrl(m[1], el) : '';
  }

  const URL_ATTRS = /^(?:href|src|action|poster|data-src|data-href|data-url|data-original)$/i;

  /** Read a value from an element. attr: text|ownText|href|src|value|html|outerHtml|attr */
  function getValue(el, attr, attrName) {
    switch (attr) {
      case 'ownText':
        return ownText(el);
      case 'href': {
        const a = (el.closest && el.closest('a[href]')) || (el.querySelector && el.querySelector('a[href]'));
        if (!a) return '';
        return typeof a.href === 'string' && a.href ? a.href : absUrl(a.getAttribute('href'), a);
      }
      case 'src':
        return imageUrl(el);
      case 'value':
        return 'value' in el && el.value != null ? String(el.value) : el.getAttribute('value') || '';
      case 'html':
        return (el.innerHTML || '').trim();
      case 'outerHtml':
        return el.outerHTML || '';
      case 'attr': {
        if (!attrName) return '';
        const v = el.getAttribute(attrName);
        if (v == null) return '';
        return URL_ATTRS.test(attrName) ? absUrl(v.trim(), el) : v.trim();
      }
      case 'text':
      default:
        return textOf(el);
    }
  }

  /** Value-bearing descendants of a row, in document order. */
  function dataNodes(row, isVisible) {
    const out = [];
    const visit = (el) => {
      if (isSkipped(el)) return;
      if (el !== row && isVisible && !isVisible(el)) return;
      const tag = el.tagName;
      if (tag === 'IMG') {
        if (imageUrl(el)) out.push({ el, attr: 'src' });
        return;
      }
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
        if (el.type !== 'hidden' && el.value) out.push({ el, attr: 'value' });
        return;
      }
      if (tag === 'A' && usableHref(el)) out.push({ el, attr: 'href' });
      if (isTextContainer(el)) {
        out.push({ el, attr: 'text' });
        return;
      }
      if (ownText(el)) out.push({ el, attr: 'ownText' });
      for (const c of el.children) visit(c);
    };
    visit(row);
    return out;
  }

  /** Cheap count of value-bearing nodes (stops at cap). */
  function countLeaves(root, cap) {
    let n = 0;
    const visit = (el) => {
      if (n >= cap || isSkipped(el)) return;
      if (el.tagName === 'IMG' || (el.tagName === 'A' && usableHref(el))) n++;
      for (const c of el.childNodes) {
        if (c.nodeType === 3 && c.nodeValue.trim()) { n++; break; }
      }
      for (const c of el.children) visit(c);
    };
    visit(root);
    return Math.min(n, cap);
  }

  // ---------------------------------------------------------------------------
  // Relative (row → field) selectors
  // ---------------------------------------------------------------------------

  function simpleCandidates(el) {
    const tag = cssEscape(tagOf(el));
    const out = [];
    for (const a of TEST_ATTRS.concat(['itemprop', 'name', 'data-field', 'data-role'])) {
      const v = el.getAttribute(a);
      if (v && v.length < 60 && !/\d{3,}/.test(v)) out.push('[' + a + '=' + cssString(v) + ']');
    }
    const sem = semanticClasses(el);
    for (const c of sem) out.push('.' + cssEscape(c));
    if (sem.length > 1) out.push('.' + sem.slice(0, 3).map(cssEscape).join('.'));
    for (const c of sem) out.push(tag + '.' + cssEscape(c));
    out.push(tag);
    return out;
  }

  function pathStep(el) {
    let s = cssEscape(tagOf(el));
    const sem = semanticClasses(el).slice(0, 2);
    s += sem.map((c) => '.' + cssEscape(c)).join('');
    const { index, count } = nthOfType(el);
    if (count > 1) s += ':nth-of-type(' + index + ')';
    return s;
  }

  function uniqueIn(row, sel, el) {
    try {
      const m = queryIn(row, sel);
      return m.length === 1 && m[0] === el;
    } catch (e) {
      return false;
    }
  }

  /**
   * Selector for `el` relative to `row`: the simplest selector (classes and
   * semantic attributes first) that is unique inside the row, optionally
   * prefixed by an anchored ancestor, else a full child path.
   */
  function relativeSelector(row, el) {
    if (el === row) return '';
    const tail = [];
    for (let n = el; n && n !== row; n = n.parentElement) {
      const suffix = tail.length ? ' > ' + tail.join(' > ') : '';
      for (const c of simpleCandidates(n)) {
        const sel = c + suffix;
        if (uniqueIn(row, sel, el)) return sel;
      }
      tail.unshift(pathStep(n));
    }
    return '> ' + tail.join(' > ');
  }

  // ---------------------------------------------------------------------------
  // Column naming
  // ---------------------------------------------------------------------------

  const GENERIC_WORDS = /^(?:wrapper|wrap|container|inner|outer|content|contents|body|box|block|section|row|col|column|cell|item|items|el|element|component|module|text|label|value|info|detail|details|data|main|left|right|top|bottom|link|links|media|figure|card|list|grid|flex|holder|area|group|meta|js|c|ui|field|line|part|unit|entry|tile|cont|txt)$/i;
  const ABBREVIATIONS = { desc: 'Description', descr: 'Description', img: 'Image', pic: 'Picture', qty: 'Quantity', addr: 'Address', tel: 'Phone', num: 'Number', no: 'Number', pos: 'Position', cat: 'Category', loc: 'Location', btn: 'Button', amt: 'Amount', dt: 'Date', ts: 'Timestamp', usr: 'User' };
  const PRICE_RE = /(?:[$€£¥₹₩₽₺]|\b(?:CHF|USD|EUR|GBP|JPY|CAD|AUD|SEK|NOK|DKK|PLN)\b)\s?\d|\d\s?(?:[$€£¥₹₩₽₺]|\b(?:CHF|USD|EUR|GBP|kr|zł|Fr)\b)/i;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function humanize(token) {
    let t = String(token);
    if (t.includes('__')) t = t.split('__').pop();
    t = t.replace(/--.*$/, '');
    const words = t
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[-_\s]+/)
      .filter((w) => w && !/^\d+$/.test(w) && !/^js$/i.test(w));
    if (!words.length) return '';
    if (words.every((w) => GENERIC_WORDS.test(w))) return '';
    return words
      .slice(-3)
      .map((w) => ABBREVIATIONS[w.toLowerCase()] || w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  function hintFrom(el, row) {
    let n = el;
    for (let depth = 0; n && n !== row && depth < 3; depth++, n = n.parentElement) {
      const itemprop = n.getAttribute('itemprop');
      if (itemprop) { const h = humanize(itemprop); if (h) return h; }
      for (const a of TEST_ATTRS) {
        const v = n.getAttribute(a);
        if (v) { const h = humanize(v); if (h) return h; }
      }
      for (const c of semanticClasses(n)) {
        const h = humanize(c);
        if (h) return h;
      }
    }
    return '';
  }

  function tableHeaderName(row, el) {
    if (row.tagName !== 'TR') return '';
    const cell = el.closest('td,th');
    if (!cell || !row.contains(cell)) return '';
    const table = row.closest('table');
    if (!table) return '';
    let header = table.tHead && table.tHead.rows[0];
    if (!header) {
      header = Array.from(table.rows).find((r) => r !== row && r.querySelector(':scope > th'));
    }
    if (!header || header === row) return '';
    const h = header.cells[cell.cellIndex];
    return h ? cleanText(h.textContent).slice(0, 40) : '';
  }

  function guessName(col) {
    const { el, row, attr } = col;
    let base = tableHeaderName(row, el) || hintFrom(el, row);
    if (!base) {
      const tag = el.tagName;
      const sample = (col.values || []).find(Boolean) || '';
      if (/^H[1-6]$/.test(tag)) base = 'Title';
      else if (tag === 'IMG') base = 'Image';
      else if (tag === 'A') base = attr === 'href' ? 'Link' : 'Link Text';
      else if (tag === 'TIME') base = 'Date';
      else if (tag === 'BUTTON') base = 'Button';
      else if (PRICE_RE.test(sample)) base = 'Price';
      else if (EMAIL_RE.test(sample)) base = 'Email';
      else if (/^\+?[\d\s().-]{7,}$/.test(sample) && /\d{3}/.test(sample)) base = 'Phone';
      else if (/^[\d.,]+\s*(?:\/\s*5|stars?|out of 5)/i.test(sample)) base = 'Rating';
      else if (/^-?[\d.,]+%?$/.test(sample)) base = 'Number';
      else base = 'Text';
    }
    if (attr === 'href' && !/link|url/i.test(base)) base += ' URL';
    else if (attr === 'src' && !/image|img|photo|picture|thumb|logo|avatar|icon/i.test(base)) base += ' Image';
    return base;
  }

  function dedupeNames(names) {
    const used = new Map();
    return names.map((name) => {
      const n = (used.get(name) || 0) + 1;
      used.set(name, n);
      return n === 1 ? name : name + ' ' + n;
    });
  }

  // ---------------------------------------------------------------------------
  // Column detection
  // ---------------------------------------------------------------------------

  /**
   * Propose columns for a set of rows. Each data node is keyed by its
   * relative selector + attribute; keys found in enough rows become columns,
   * ordered by their average position inside the row.
   */
  function detectColumns(rows, opts) {
    opts = opts || {};
    const isVisible = opts.isVisible === undefined ? defaultVisible : opts.isVisible;
    const sample = rows.slice(0, opts.sample || 40);
    const stats = new Map();
    sample.forEach((row) => {
      const nodes = dataNodes(row, isVisible);
      const seen = new Set();
      nodes.forEach((d, i) => {
        const selector = relativeSelector(row, d.el);
        const key = selector + '\u0000' + d.attr;
        if (seen.has(key)) return;
        seen.add(key);
        let s = stats.get(key);
        if (!s) {
          s = { selector, attr: d.attr, count: 0, pos: 0, el: d.el, row, values: [] };
          stats.set(key, s);
        }
        s.count++;
        s.pos += nodes.length > 1 ? i / (nodes.length - 1) : 0;
        if (s.values.length < 5) s.values.push(getValue(d.el, d.attr));
      });
    });
    const minCount = sample.length <= 2 ? 1 : Math.max(2, Math.ceil(sample.length * (opts.minFill == null ? 0.2 : opts.minFill)));
    let cols = Array.from(stats.values()).filter((s) => s.count >= minCount);
    cols.sort((a, b) => a.pos / a.count - b.pos / b.count);
    cols = cols.slice(0, opts.maxColumns || 40);
    const names = dedupeNames(cols.map(guessName));
    return cols.map((c, i) => ({
      name: names[i],
      selector: c.selector,
      attr: c.attr === 'ownText' ? 'ownText' : c.attr,
      fill: Math.round((c.count / Math.max(1, sample.length)) * 100),
      sample: c.values.find(Boolean) || '',
    }));
  }

  /** Column for a single element picked inside a row. */
  function columnFor(row, el, existingNames) {
    let attr = 'text';
    if (el.tagName === 'IMG') attr = 'src';
    else if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') attr = 'value';
    else if (!textOf(el)) {
      if (el.querySelector('img')) attr = 'src';
      else if (el.closest('a[href]')) attr = 'href';
    }
    const selector = relativeSelector(row, el);
    const value = getValue(el, attr);
    let name = guessName({ el, row, attr, values: [value] });
    const taken = new Set(existingNames || []);
    if (taken.has(name)) {
      let i = 2;
      while (taken.has(name + ' ' + i)) i++;
      name = name + ' ' + i;
    }
    return { name, selector, attr, sample: value };
  }

  // ---------------------------------------------------------------------------
  // List (row) detection
  // ---------------------------------------------------------------------------

  function structSignature(el) {
    const sig = new Set();
    for (const c of el.children) {
      const t = tagOf(c);
      sig.add(t);
      for (const g of c.children) sig.add(t + '>' + tagOf(g));
    }
    return sig;
  }

  function jaccard(a, b) {
    if (!a.size && !b.size) return 1;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  }

  /** Are two elements instances of the same repeating template? */
  function similar(a, b) {
    if (a === b) return true;
    if (a.localName !== b.localName) return false;
    const ca = groupClasses(a);
    const cb = groupClasses(b);
    if (ca.length || cb.length) {
      if (!ca.some((c) => cb.includes(c))) return false;
    }
    const sa = structSignature(a);
    const sb = structSignature(b);
    if (!sa.size || !sb.size) return sa.size === sb.size || ca.length > 0;
    return jaccard(sa, sb) >= 0.34;
  }

  function similarSiblings(el) {
    const parent = el.parentElement;
    if (!parent) return [el];
    return Array.from(parent.children).filter((s) => s === el || (!isSkipped(s) && similar(el, s)));
  }

  function commonClasses(row, group) {
    let common = semanticClasses(row).filter((c) => group.every((g) => g.classList.contains(c)));
    if (!common.length) common = groupClasses(row).filter((c) => group.every((g) => g.classList.contains(c)));
    return common.slice(0, 3);
  }

  function rowPart(row, group) {
    return cssEscape(tagOf(row)) + commonClasses(row, group).map((c) => '.' + cssEscape(c)).join('');
  }

  function containerSelector(el) {
    const doc = el.ownerDocument;
    if (el === doc.body) return 'body';
    if (el === doc.documentElement) return 'html';
    return uniqueSelector(el);
  }

  /** Selector matching every element of `group` (siblings of `row`). */
  function rowSelectorFor(group, row) {
    const doc = row.ownerDocument;
    const common = commonClasses(row, group);
    const sel = containerSelector(row.parentElement) + ' > ' + rowPart(row, group);
    if (common.length) return sel;
    // Class-less rows (tr, li…): exclude dissimilar siblings such as a header
    // row by requiring a child tag every row has and no extra has.
    let matched;
    try { matched = queryAll(sel, doc); } catch (e) { return sel; }
    const inGroup = new Set(group);
    const extras = matched.filter((m) => !inGroup.has(m));
    if (!extras.length) return sel;
    const hasChild = (el, t) => Array.from(el.children).some((c) => tagOf(c) === t);
    for (const t of uniq(Array.from(row.children).map(tagOf))) {
      if (group.every((g) => hasChild(g, t)) && extras.every((x) => !hasChild(x, t))) {
        const refined = sel + ':has(> ' + cssEscape(t) + ')';
        try { queryAll(refined, doc); return refined; } catch (e) { return sel; }
      }
    }
    return sel;
  }

  /**
   * Find the repeating row around `target`.
   * Every ancestor with similar siblings is a candidate. Groups whose members
   * hold a single value (table cells, tags, plain spans) are "cells" and only
   * win when nothing else repeats. Walking up from the click, a larger
   * ancestor replaces the current choice only if it repeats more often:
   * product cards beat the variants inside a card, while three sections of
   * three items each resolve to the items, not the sections.
   */
  function detectList(target, opts) {
    opts = opts || {};
    const doc = target.ownerDocument;
    const chain = [];
    for (let a = target; a && a.parentElement && a !== doc.body && a !== doc.documentElement; a = a.parentElement) {
      chain.push(a);
    }
    if (!chain.length) return null;
    const cands = [];
    chain.forEach((a, level) => {
      const group = similarSiblings(a);
      if (group.length >= 2) {
        const sample = group.slice(0, 5);
        const leaves = sample.reduce((s, g) => s + countLeaves(g, 25), 0) / sample.length;
        cands.push({ level, size: group.length, cell: leaves <= 1.2 });
      }
    });
    let level = opts.level;
    if (level == null || level < 0 || level >= chain.length) {
      const rowsLike = cands.filter((c) => !c.cell);
      const pool = rowsLike.length ? rowsLike : cands;
      let best = pool[0];
      for (const c of pool) if (c.size > best.size) best = c;
      level = best ? best.level : 0;
    }
    const row = chain[level];
    const group = similarSiblings(row);
    return {
      level,
      levels: cands.map((c) => c.level),
      maxLevel: chain.length - 1,
      rowSelector: rowSelectorFor(group, row),
    };
  }

  function pathBetween(ancestor, el) {
    const path = [];
    for (let n = el; n && n !== ancestor; n = n.parentElement) path.unshift(n);
    return path;
  }

  function mergedPathSelector(lca, r1, r2) {
    const p1 = pathBetween(lca, r1);
    const p2 = pathBetween(lca, r2);
    const rowGroup = uniq(similarSiblings(r1).concat(similarSiblings(r2)));
    const lcaSel = containerSelector(lca);
    if (p1.length === p2.length && p1.every((n, i) => n.localName === p2[i].localName)) {
      const parts = p1.map((n, i) => {
        const isRow = i === p1.length - 1;
        if (isRow) return rowPart(n, rowGroup);
        const m = p2[i];
        const cls = commonClasses(n, [n, m]);
        let s = cssEscape(tagOf(n)) + cls.map((c) => '.' + cssEscape(c)).join('');
        const a = nthOfType(n);
        const b = nthOfType(m);
        if (!cls.length && a.count > 1 && a.index === b.index) s += ':nth-of-type(' + a.index + ')';
        return s;
      });
      return lcaSel + ' > ' + parts.join(' > ');
    }
    return lcaSel + ' ' + rowPart(r1, rowGroup);
  }

  /**
   * Generalise from two examples (UiPath's "indicate a second element"): the
   * rows are the ancestors of both examples at the same level, and the row
   * selector keeps only what both paths have in common.
   */
  function detectListFromExamples(el1, el2, opts) {
    opts = opts || {};
    if (!el2 || el1 === el2 || el1.contains(el2) || el2.contains(el1)) return detectList(el1, opts);
    const lca = commonAncestor(el1, el2);
    if (!lca) return detectList(el1, opts);
    const chain1 = pathBetween(lca, el1).reverse(); // [el1, …, child of lca]
    const chain2 = pathBetween(lca, el2).reverse();
    const maxLevel = chain1.length - 1;
    let level = opts.level;
    if (level == null) {
      const single = detectList(el1);
      level = single ? single.level : maxLevel;
    }
    level = Math.max(0, Math.min(level, maxLevel));
    const r1 = chain1[level];
    let r2 = chain2[level] && similar(r1, chain2[level]) ? chain2[level] : chain2.find((a) => similar(r1, a));
    if (!r2) r2 = chain2.find((a) => a.localName === r1.localName);
    const levels = [];
    for (let i = 0; i <= maxLevel; i++) levels.push(i);
    if (!r2) return Object.assign(detectList(el1, { level }), { levels, maxLevel });

    let rowSelector;
    if (r1.parentElement === r2.parentElement) {
      rowSelector = rowSelectorFor(uniq(similarSiblings(r1).concat(similarSiblings(r2), [r1, r2])), r1);
    } else {
      rowSelector = mergedPathSelector(lca, r1, r2);
    }
    let rows = [];
    try { rows = queryAll(rowSelector, el1.ownerDocument); } catch (e) { rows = []; }
    if (!rows.includes(r1) || !rows.includes(r2)) {
      rowSelector = containerSelector(lca) + ' ' + rowPart(r1, [r1, r2]);
    }
    return { level, levels, maxLevel, rowSelector };
  }

  /**
   * Scan the whole page for repeating structures (no click needed), best
   * first. Used by the "Auto-detect" button.
   */
  function findLists(doc, opts) {
    opts = opts || {};
    const isVisible = opts.isVisible === undefined ? defaultVisible : opts.isVisible;
    const found = [];
    if (!doc.body) return found;
    const all = doc.body.getElementsByTagName('*');
    const max = Math.min(all.length, opts.maxElements || 40000);
    for (let i = 0; i < max; i++) {
      const p = all[i];
      if (p.children.length < 3 || isSkipped(p) || p.tagName === 'SELECT' || p.tagName === 'OPTGROUP') continue;
      const buckets = new Map();
      for (const c of p.children) {
        if (isSkipped(c)) continue;
        const key = tagOf(c) + '|' + (semanticClasses(c)[0] || groupClasses(c).slice(0, 2).join('.'));
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(c);
      }
      for (const group of buckets.values()) {
        if (group.length < 3) continue;
        if (isVisible && !isVisible(p)) break;
        const sample = group.slice(0, 6);
        const leaves = sample.reduce((s, g) => s + countLeaves(g, 30), 0) / sample.length;
        if (leaves < 2) continue;
        let score = group.length * Math.min(leaves, 20);
        if (p.closest('nav, header, footer, [role=navigation], [role=menu], [role=menubar]')) score *= 0.25;
        found.push({ group, score });
      }
    }
    found.sort((a, b) => b.score - a.score);
    const out = [];
    const seen = new Set();
    for (const f of found) {
      if (out.length >= (opts.limit || 8)) break;
      let rowSelector;
      try { rowSelector = rowSelectorFor(f.group, f.group[0]); } catch (e) { continue; }
      if (seen.has(rowSelector)) continue;
      seen.add(rowSelector);
      out.push({ rowSelector, rowCount: f.group.length, score: Math.round(f.score) });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Extraction
  // ---------------------------------------------------------------------------

  /**
   * Run a recipe against the page. Returns rows as arrays aligned with
   * recipe.columns. Rows where every column is empty are dropped.
   */
  function extract(recipe, root, opts) {
    opts = opts || {};
    const doc = root || global.document;
    const rows = queryAll(recipe.rowSelector, doc);
    const cols = recipe.columns || [];
    cols.forEach((c) => {
      if (c.selector && rows[0]) queryIn(rows[0], c.selector); // throws early on bad selectors
    });
    const limit = opts.limit || Infinity;
    const out = [];
    for (const row of rows) {
      if (out.length >= limit) break;
      const values = cols.map((c) => {
        const el = queryIn(row, c.selector)[0];
        return el ? getValue(el, c.attr, c.attrName) : '';
      });
      if (values.some((v) => v !== '')) out.push(values);
    }
    return { rows: out, rowCount: rows.length };
  }

  function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  // ---------------------------------------------------------------------------
  // Pagination helpers
  // ---------------------------------------------------------------------------

  const CLICKABLE = 'a, button, [role=button], [role=link], input[type=submit], input[type=button], [onclick], [tabindex]';
  const NEXT_WORDS = /^(?:next|next page|more|load more|show more|›|»|>|→|weiter|nächste|suivant|siguiente|avanti|próxima|volgende|następna|далее|次へ|下一页)$/i;

  function clickableOf(el) {
    return (el.closest && el.closest(CLICKABLE)) || el;
  }

  /** Describe a pagination target so it can be found again on later pages. */
  function describeTarget(el) {
    const target = clickableOf(el);
    const text = xpathText(target);
    return {
      selector: uniqueSelector(target),
      text: text.length <= 40 ? text : '',
      aria: target.getAttribute('aria-label') || '',
      rel: target.getAttribute('rel') || '',
    };
  }

  function isDisabled(el) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return true;
    for (let n = el, i = 0; n && i < 3; n = n.parentElement, i++) {
      if (/(?:^|\s|-|_)disabled(?:$|\s)/i.test(typeof n.className === 'string' ? n.className : '')) return true;
    }
    return false;
  }

  function sameText(el, target) {
    const t = xpathText(el).toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    return (target.text && t === target.text.toLowerCase()) || (target.aria && aria === target.aria.toLowerCase());
  }

  /** Locate the "next" / "load more" element on the current page. */
  function resolveTarget(target, doc, opts) {
    opts = opts || {};
    doc = doc || global.document;
    const isVisible = opts.isVisible === undefined ? defaultVisible : opts.isVisible;
    const visible = (el) => !isVisible || isVisible(el);
    let bySelector = null;
    try {
      bySelector = queryAll(target.selector, doc).map(clickableOf).find(visible) || null;
    } catch (e) {
      bySelector = null;
    }
    if (bySelector && (!(target.text || target.aria) || sameText(bySelector, target))) return bySelector;
    if (target.text || target.aria) {
      const byText = Array.from(doc.querySelectorAll(CLICKABLE)).find((el) => visible(el) && sameText(el, target));
      if (byText) return byText;
    }
    if (bySelector) return bySelector;
    if (target.rel) {
      const byRel = Array.from(doc.querySelectorAll('[rel~="' + target.rel.replace(/"/g, '') + '"]')).find(visible);
      if (byRel) return byRel;
    }
    if (opts.fallback !== false) {
      const relNext = Array.from(doc.querySelectorAll('a[rel~=next], link[rel~=next]')).find((el) => el.tagName === 'A' && visible(el));
      if (relNext) return relNext;
      return Array.from(doc.querySelectorAll('a, button')).find((el) => visible(el) && NEXT_WORDS.test(xpathText(el) || el.getAttribute('aria-label') || '')) || null;
    }
    return null;
  }

  /** Column colours, shared by the page highlights and the side panel. */
  const COLUMN_COLORS = ['#e11d48', '#0891b2', '#65a30d', '#c026d3', '#ea580c', '#2563eb', '#ca8a04', '#059669', '#db2777', '#7c3aed'];

  global.KoalaCore = {
    version: '3.0.0',
    COLUMN_COLORS,
    // escaping
    cssEscape, cssString, xpathString,
    // classification
    classKind, isStableId, semanticClasses, groupClasses,
    // dom helpers
    describe, textOf, ownText, cleanText, nthOfType, defaultVisible, hashString,
    // querying
    isXPath, queryAll, queryIn,
    // selector model
    buildModel, optimizeModel, compileModel, uniqueSelector, xpathFor,
    // values
    getValue, imageUrl, dataNodes,
    // rows & columns
    relativeSelector, detectColumns, columnFor, similar, similarSiblings,
    detectList, detectListFromExamples, findLists, rowSelectorFor,
    // extraction
    extract,
    // pagination
    clickableOf, describeTarget, resolveTarget, isDisabled,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
