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
