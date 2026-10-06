/* Tiny fixture web site exercising the scraping scenarios. */
import http from 'node:http';

const layout = (title, body, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: sans-serif; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .card { border: 1px solid #ddd; padding: 8px; }
  .pagination { display: flex; gap: 6px; list-style: none; padding: 0; }
  .page-item.disabled a { color: #aaa; pointer-events: none; }
  .post { height: 140px; border-bottom: 1px solid #ccc; }
</style>${extra}</head><body>${body}</body></html>`;

function shopPage(n, total = 3) {
  const products = Array.from({ length: 8 }, (_, i) => {
    const id = (n - 1) * 8 + i + 1;
    return `<div class="col"><article class="card product">
      <img class="thumb" src="/img/${id}.png" alt="Product ${id}">
      <h2 class="title"><a href="/item/${id}">Product ${id}</a></h2>
      ${id % 3 === 0 ? '<span class="badge">Sale</span>' : ''}
      <span class="price">CHF ${id}.00</span>
      <div class="rating">${(id % 5) + 1} / 5</div>
    </article></div>`;
  }).join('');
  // The pager changes shape between pages (a "Prev" link appears, the last
  // "Next" is disabled), so index-based selectors break: the text fallback
  // must find the button again.
  const items = [];
  if (n > 1) items.push(`<li class="page-item"><a class="page-link" href="/shop/page/${n - 1}">‹ Prev</a></li>`);
  for (let i = 1; i <= total; i++) items.push(`<li class="page-item${i === n ? ' active' : ''}"><a class="page-link" href="/shop/page/${i}">${i}</a></li>`);
  items.push(n < total
    ? `<li class="page-item"><a class="page-link" href="/shop/page/${n + 1}">Next ›</a></li>`
    : `<li class="page-item disabled"><a class="page-link" href="#">Next ›</a></li>`);
  return layout(`Shop page ${n}`, `
    <header><nav><ul class="menu"><li><a href="/">Home</a></li><li><a href="/shop/page/1">Shop</a></li><li><a href="/about">About</a></li></ul></nav></header>
    <main id="main"><h1>Shop</h1><div class="grid">${products}</div>
    <nav aria-label="pages"><ul class="pagination">${items.join('')}</ul></nav></main>`);
}

const spa = layout('SPA', `
  <div id="app"><h1>Results</h1><ul class="results"></ul><button class="pager-next" type="button">Next page</button></div>
  <script>
    const all = Array.from({ length: 15 }, (_, i) => ({ name: 'Item ' + (i + 1), cat: ['Books', 'Games', 'Music'][i % 3] }));
    let page = 0;
    const ul = document.querySelector('.results');
    const btn = document.querySelector('.pager-next');
    function render() {
      ul.innerHTML = all.slice(page * 5, page * 5 + 5)
        .map((x) => '<li class="result"><span class="name">' + x.name + '</span> <em class="cat">' + x.cat + '</em></li>').join('');
      btn.disabled = page >= 2;
    }
    btn.addEventListener('click', () => {
      ul.innerHTML = '<li class="loading">Loading…</li>';
      setTimeout(() => { page++; render(); history.pushState({}, '', '?page=' + (page + 1)); }, 300);
    });
    render();
  </script>`);

const infinite = layout('Feed', `
  <h1>Feed</h1><div class="feed"></div><div id="sentinel">Loading more…</div>
  <script>
    let n = 0; const max = 40; let loading = false;
    const feed = document.querySelector('.feed');
    function add(k) {
      for (let i = 0; i < k && n < max; i++) {
        n++;
        feed.insertAdjacentHTML('beforeend', '<div class="post"><h3 class="post-title">Post ' + n + '</h3><p class="excerpt">Excerpt ' + n + '</p></div>');
      }
      if (n >= max) document.getElementById('sentinel').textContent = 'The end';
    }
    add(10);
    window.addEventListener('scroll', () => {
      if (loading || n >= max) return;
      if (innerHeight + scrollY >= document.body.scrollHeight - 200) {
        loading = true;
        setTimeout(() => { add(10); loading = false; }, 300);
      }
    });
  </script>`);

const loadmore = layout('Load more', `
  <h1>Entries</h1><div class="list"></div><button class="load-more" type="button">Load more</button>
  <script>
    let n = 0;
    const list = document.querySelector('.list');
    function add() {
      for (let i = 0; i < 6; i++) {
        n++;
        list.insertAdjacentHTML('beforeend', '<div class="entry"><strong class="entry-name">Entry ' + n + '</strong> <a href="/e/' + n + '">open</a></div>');
      }
      if (n >= 18) document.querySelector('.load-more').remove();
    }
    add();
    document.querySelector('.load-more').addEventListener('click', () => setTimeout(add, 200));
  </script>`);

const table = layout('People', `
  <nav><ul><li><a href="/a">Alpha</a></li><li><a href="/b">Beta</a></li><li><a href="/c">Gamma</a></li><li><a href="/d">Delta</a></li></ul></nav>
  <table id="people"><thead><tr><th>Name</th><th>Email</th><th>City</th></tr></thead><tbody>
  ${['Ann', 'Bob', 'Cid', 'Dee', 'Eve', 'Fay'].map((p, i) => `<tr><td>${p}</td><td>${p.toLowerCase()}@example.org</td><td>City ${i + 1}</td></tr>`).join('')}
  </tbody></table>`);

const svg = layout('SVG', `<div id="art"><svg width="50" height="50"><g><circle r="5"/><path d="M0 0L5 5"/><path d="M5 5L9 9"/></g></svg></div>`);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

export function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (body, type = 'text/html; charset=utf-8') => {
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    };
    const m = /^\/shop\/page\/(\d+)$/.exec(url.pathname);
    if (m) return send(shopPage(Number(m[1])));
    if (url.pathname === '/spa') return send(spa);
    if (url.pathname === '/infinite') return send(infinite);
    if (url.pathname === '/loadmore') return send(loadmore);
    if (url.pathname === '/table') return send(table);
    if (url.pathname === '/svg') return send(svg);
    if (url.pathname.startsWith('/img/')) return send(PNG, 'image/png');
    return send(layout('Page', '<p>' + url.pathname + '</p>'));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: 'http://127.0.0.1:' + server.address().port }));
  });
}
