import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const coreSrc = readFileSync(new URL('../../src/content/core.js', import.meta.url), 'utf8');

/** Build a jsdom page with KoalaCore loaded inside it. */
export function page(html, url = 'https://shop.example/catalog/') {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url, runScripts: 'outside-only' });
  dom.window.eval(coreSrc);
  const { document, KoalaCore } = dom.window;
  return { dom, window: dom.window, document, K: KoalaCore, $: (s) => document.querySelector(s), $$: (s) => [...document.querySelectorAll(s)] };
}

export const productGrid = (n = 6) => `
  <header><nav><ul class="menu"><li><a href="/a">A</a></li><li><a href="/b">B</a></li><li><a href="/c">C</a></li></ul></nav></header>
  <main id="content">
    <h1>Catalog</h1>
    <div class="grid">
      ${Array.from({ length: n }, (_, i) => `
        <article class="product-card${i === 1 ? ' product-card--sale' : ''}">
          <a class="thumb" href="/p/${i + 1}"><img src="/img/${i + 1}.jpg" alt="Item ${i + 1}"></a>
          <div class="body">
            <h3 class="product-title"><a href="/p/${i + 1}">Product ${i + 1}</a></h3>
            ${i === 1 ? '<span class="badge">Sale</span>' : ''}
            <span class="price">$${(i + 1) * 10}.00</span>
            <p class="desc">Description of <b>item</b> ${i + 1}</p>
            <ul class="tags"><li>red</li><li>blue</li></ul>
          </div>
        </article>`).join('')}
    </div>
    <nav class="pagination"><a href="?page=1">1</a><a href="?page=2">2</a><a class="next" rel="next" href="?page=2">Next</a></nav>
  </main>`;
