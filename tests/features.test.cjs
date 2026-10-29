// Поиск глав, «Выбрать новые», разбивка на файлы, резервная копия настроек, подсказки к ошибкам, зеркала сайтов
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
function functionSource(file, name) {
  const text = source(file);
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(text);
  assert.ok(match, `Missing function: ${name}`);
  return text.slice(match.index, text.indexOf('\n}', match.index) + 2);
}
const json = value => JSON.parse(JSON.stringify(value));

const range = () => {
  const ctx = vm.createContext({});
  vm.runInContext(source('src/core/chapter-range.js') + '\nthis.downloadedStoreKey = downloadedStoreKey;', ctx); // const не попадает в контекст сам
  return ctx;
};
const chapters = [
  { id: 'a', volume: 1, number: '1', name: 'Начало' },
  { id: 'b', volume: 1, number: '2', name: 'Дорога' },
  { id: 'c', volume: 1, number: '2.5', name: 'Экстра' },
  { id: 'd', volume: 2, number: '10', name: '', displayTitle: 'Глава 10. Конец' }
];

test('findChapters: exact number, range in any order, name or display title, only among selected', () => {
  const { findChapters } = range();
  assert.deepEqual(json(findChapters(chapters, '2')), [1]);
  assert.deepEqual(json(findChapters(chapters, '2,5')), [2]);
  assert.deepEqual(json(findChapters(chapters, '10 - 2')), [1, 2, 3]);
  assert.deepEqual(json(findChapters(chapters, 'ДОРОГ')), [1]);
  assert.deepEqual(json(findChapters(chapters, 'конец')), [3]);
  assert.deepEqual(json(findChapters(chapters, '', new Set(['a', 'd']))), [0, 3]);
  assert.deepEqual(json(findChapters(chapters, 'экстра', new Set(['a']))), []);
});

test('downloaded chapters are keyed by volume and number, so another translation still counts as downloaded', () => {
  const { mergeDownloaded, newChapterIds, downloadedStoreKey } = range();
  assert.equal(downloadedStoreKey('1--x'), 'downloadedChapters:1--x');
  const stored = mergeDownloaded(['1:1'], [{ volume: 1, number: '1' }, { volume: 1, number: '2' }]);
  assert.deepEqual(json(stored), ['1:1', '1:2']);
  assert.deepEqual(json(newChapterIds(chapters, stored)), ['c', 'd']);
  assert.deepEqual(json(newChapterIds([{ id: 'other-branch', volume: 1, number: '2' }], stored)), []);
});

test('split: parts of N chapters, numbered file names that sort in order', () => {
  const ctx = vm.createContext({});
  vm.runInContext(functionSource('src/engine/engine.js', 'splitParts') + functionSource('src/engine/engine.js', 'partFilename'), ctx);
  const list = Array.from({ length: 25 }, (_, i) => ({ number: String(i + 1) }));
  assert.deepEqual(json(ctx.splitParts(list, 0)), [null]);
  assert.deepEqual(json(ctx.splitParts(list, 25)), [null]);
  assert.deepEqual(json(ctx.splitParts(list, 10).map(part => part.length)), [10, 10, 5]);
  assert.equal(ctx.partFilename('Тайтл.epub', 0, 12, list.slice(0, 10)), 'Тайтл - 01 (1-10).epub');
  assert.equal(ctx.partFilename('Тайтл', 2, 3, list.slice(20, 21)), 'Тайтл - 3 (21)');
});

test('settings backup: only LibSaver files, only known keys', () => {
  const ctx = vm.createContext({});
  const text = source('src/core/settings.js');
  vm.runInContext(text.slice(text.indexOf('const BACKUP_APP'), text.indexOf('\n}', text.indexOf('function parseSettingsBackup')) + 2), ctx);
  const parse = (data, known = ['imageQuality', 'theme']) => ctx.parseSettingsBackup(typeof data === 'string' ? data : JSON.stringify(data), known);
  assert.deepEqual(json(parse({ app: 'LibSaver', settings: { imageQuality: 'FHD', theme: null, 'titleData:x': {}, evil: 1 } })), { imageQuality: 'FHD' });
  assert.throws(() => parse('{oops'), /не JSON/);
  assert.throws(() => parse({ app: 'Other', settings: {} }), /не резервная копия/);
  assert.throws(() => parse({ app: 'LibSaver', settings: [] }), /не резервная копия/);
  assert.throws(() => parse({ app: 'LibSaver', settings: { unknown: 1 } }), /нет настроек/);
});

test('a failed download says what to do next', () => {
  const ctx = vm.createContext({ console, chrome: {} });
  vm.runInContext(source('src/utils/page-call.js') + source('src/core/downloads-view.js'), ctx);
  assert.match(ctx.errorHelp('HTTP 429: Too Many'), /Ускорить/);
  assert.match(ctx.errorHelp('Failed to fetch'), /зеркало/);
  assert.match(ctx.errorHelp('что-то странное'), /Логи/);
  const html = ctx.renderQueueItem({ id: 'a', slug: 's', siteKey: 'mangalib', title: 'T', format: 'epub', status: 'error', error: 'HTTP 404', progress: { current: 0, total: 1 } });
  assert.match(html, /dl-error-help">Глава или файл удалены/);
});

// Фон над фейковой сетью: hosts - какие адреса отвечают и куда переадресуют
function mirrorContext(hosts, stored = {}) {
  const data = { ...stored };
  const fetched = [];
  const ctx = vm.createContext({
    URL, AbortController, setTimeout, clearTimeout,
    fetch: async url => {
      fetched.push(url);
      if (!(url in hosts)) throw new TypeError('Failed to fetch');
      const val = hosts[url];
      if (val && typeof val === 'object') return { url: val.url || url, ok: val.ok !== false, status: val.status || 200 };
      return { url: hosts[url] || url };
    },
    chrome: { storage: { local: { get: async () => ({ ...data }), set: async values => Object.assign(data, values) } } }
  });
  const background = source('src/background.js');
  vm.runInContext(source('src/utils/page-call.js') + ['probeOrigin', 'findMirror', 'refreshMirrors'].map(name => functionSource('src/background.js', name)).join('\n') + '\nlet mirrorCheck = null;', ctx);
  assert.match(background, /let mirrorCheck = null;/);
  return { ctx, data, fetched };
}

test('mirrors: kept off while the main domain answers, found among v1..v9 when it does not, untouched offline', async () => {
  const answering = mirrorContext({ 'https://mangalib.me': null, 'https://v5.animelib.org': null, 'https://v2.shlib.life': null, 'https://ranobelib.me': null, 'https://hentailib.me': null }, { siteMirrors: { mangalib: 'https://v3.mangalib.me' } });
  const result = await answering.ctx.refreshMirrors();
  assert.deepEqual(json(result), { animelib: 'https://v5.animelib.org', shlib: 'https://v2.shlib.life' });
  // a redirect away from the site is not a working mirror; offline nothing changes
  const offline = mirrorContext({ 'https://animelib.org': 'https://parking.example/' }, { siteMirrors: { animelib: 'https://v5.animelib.org' } });
  assert.equal(await offline.ctx.findMirror('animelib'), undefined);
  assert.deepEqual(json((await offline.ctx.refreshMirrors()).animelib), 'https://v5.animelib.org');
});

test('mirrors: HTTP 403/500 errors count as dead main domain and trigger mirror fallback', async () => {
  const http403 = mirrorContext({
    'https://animelib.org': { url: 'https://animelib.org', ok: false, status: 403 },
    'https://v5.animelib.org': null
  });
  assert.equal(await http403.ctx.findMirror('animelib'), 'https://v5.animelib.org');
});
test('SiteMenuRestorer: updates AnimeLIB link to v5 and removes disabled sites', () => {
  function makeElement(tag, attrs = {}) {
    const children = [];
    const classes = new Set(attrs.className ? attrs.className.split(' ') : []);
    const attributes = { ...attrs };
    const dataset = {};
    const el = {
      tagName: tag.toUpperCase(),
      dataset,
      children,
      parent: null,
      get classList() {
        return {
          contains: c => classes.has(c),
          add: c => classes.add(c),
          forEach: fn => classes.forEach(fn),
          [Symbol.iterator]: () => classes[Symbol.iterator]()
        };
      },
      getAttribute: a => attributes[a] || null,
      setAttribute: (a, v) => { attributes[a] = String(v); if (a === 'href') el.href = v; },
      hasAttribute: a => a in attributes,
      href: attrs.href || '',
      textContent: attrs.textContent || '',
      closest: sel => {
        const parts = sel.split(',').map(s => s.trim().replace(/^\./, ''));
        let cur = el;
        while (cur) {
          if (parts.some(p => cur.classList?.contains(p))) return cur;
          cur = cur.parent;
        }
        return null;
      },
      appendChild: child => {
        if (child.nodeType === 11) {
          while (child.children.length > 0) {
            const c = child.children.shift();
            c.parent = el;
            children.push(c);
          }
          return child;
        }
        child.parent = el;
        children.push(child);
        return child;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelectorAll: sel => {
        const res = [];
        function walk(node) {
          for (const ch of node.children) {
            if (sel.includes('.menu-item') && ch.classList?.contains('menu-item')) res.push(ch);
            walk(ch);
          }
        }
        walk(el);
        return res;
      },
      querySelector: sel => el.querySelectorAll(sel)[0] || null,
      cloneNode: deep => makeElement(tag, { ...attributes, className: Array.from(classes).join(' '), textContent: el.textContent, href: el.href }),
      get innerHTML() { return ''; },
      set innerHTML(val) { if (val === '') children.length = 0; }
    };
    return el;
  }

  function runRestorer(storageValues) {
    const tippyBox = makeElement('div', { className: 'tippy-box' });
    const menuList = makeElement('div', { className: 'menu-list' });
    tippyBox.appendChild(menuList);
    const items = [
      makeElement('a', { className: 'menu-item axh_f7', href: 'https://hentailib.me', textContent: 'HentaiLIB' }),
      makeElement('a', { className: 'menu-item axh_f7', href: 'https://v2.shlib.life', textContent: 'SlashLIB' }),
      makeElement('a', { className: 'menu-item axh_f7', href: 'https://ranobelib.me', textContent: 'RanobeLIB' }),
      makeElement('a', { className: 'menu-item axh_f7', href: 'https://animelib.org', textContent: 'AnimeLIB' })
    ];
    items.forEach(it => menuList.appendChild(it));

    const listeners = { storage: [] };
    const ctx = {
      console,
      URL,
      Array,
      Map,
      Set,
      JSON,
      setTimeout: fn => fn(),
      clearTimeout: () => {},
      window: { location: { hostname: 'mangalib.me' }, addEventListener: () => {} },
      document: {
        body: makeElement('body'),
        querySelectorAll: sel => sel.includes('.menu-list') ? [menuList] : [],
        createElement: (tag, attrs) => makeElement(tag, attrs),
        createDocumentFragment: () => {
          const frag = makeElement('fragment');
          frag.nodeType = 11;
          return frag;
        },
        addEventListener: () => {}
      },
      chrome: {
        storage: {
          local: { get: (keys, cb) => cb(storageValues) },
          onChanged: { addListener: fn => listeners.storage.push(fn) }
        },
        runtime: { getURL: f => f }
      },
      MutationObserver: class {
        observe() {}
        disconnect() {}
      }
    };
    ctx.window.document = ctx.document;
    vm.runInNewContext(source('src/content/SiteMenuRestorer.js'), ctx);
    return { menuList, listeners, ctx };
  }

  // 1. With custom link, AnimeLIB URL is updated to v5
  const { menuList: m1 } = runRestorer({
    enableSiteMenu: true,
    useCustomSiteLinks: true,
    customSiteLinks: { animelib: 'https://v5.animelib.org' },
    disabledSites: {}
  });
  const hrefs1 = m1.children.map(c => c.href);
  assert.ok(hrefs1.includes('https://v5.animelib.org'));
  assert.ok(!hrefs1.includes('https://animelib.org'));

  // 2. When disabled, AnimeLIB is removed from menu
  const { menuList: m2 } = runRestorer({
    enableSiteMenu: true,
    useCustomSiteLinks: true,
    customSiteLinks: { animelib: 'https://v5.animelib.org' },
    disabledSites: { animelib: true }
  });
  const hrefs2 = m2.children.map(c => c.href);
  assert.ok(!hrefs2.some(h => h.includes('animelib')));
  assert.equal(m2.children.length, 3);

  // 3. Custom order: RanobeLIB placed first
  const { menuList: m3 } = runRestorer({
    enableSiteMenu: true,
    useCustomSiteLinks: true,
    customSiteLinks: { animelib: 'https://v5.animelib.org' },
    siteMenuOrder: ['site-ranobelib', 'site-mangalib', 'site-hentailib', 'site-shlib', 'site-animelib'],
    disabledSites: {}
  });
  assert.ok(m3.children[0].href.includes('ranobelib'));

  // 4. All sites disabled -> menu is empty
  const { menuList: m4 } = runRestorer({
    enableSiteMenu: true,
    disabledSites: { mangalib: true, hentailib: true, shlib: true, ranobelib: true, animelib: true }
  });
  assert.equal(m4.children.length, 0);

  // 5. Only one site enabled -> only that site is in menu
  const { menuList: m5 } = runRestorer({
    enableSiteMenu: true,
    disabledSites: { mangalib: true, hentailib: true, shlib: true, animelib: true }
  });
  assert.equal(m5.children.length, 1);
  assert.ok(m5.children[0].href.includes('ranobelib'));
});
