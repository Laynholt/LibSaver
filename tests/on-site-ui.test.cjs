const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

const toRegExp = pattern => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

// page-call.js in a vm with a fake chrome over the `tabs` array.
// onNoTab(tabs) runs when pageCall asks the user to open the site; onExec(tabId, tabs, n) may throw or change tabs.
function pageCallContext(tabs, { onNoTab = () => {}, onExec = () => {}, noTabApi = false, sendMessage } = {}) {
  const ctx = { tabs, handlerCalls: [], execTabs: [] };
  const chrome = { runtime: { sendMessage } };
  if (!noTabApi) {
    chrome.tabs = {
      get: async id => tabs.find(tab => tab.id === id) || Promise.reject(new Error(`No tab with id: ${id}`)),
      query: async ({ url }) => tabs.filter(tab => url.some(pattern => toRegExp(pattern).test(tab.url)))
    };
    chrome.scripting = {
      executeScript: async ({ target, func, args }) => {
        ctx.execTabs.push(target.tabId);
        const custom = onExec(target.tabId, tabs, ctx.execTabs.length);
        return [{ result: custom === undefined ? 'ok' : custom }];
      }
    };
  }
  Object.assign(ctx, { chrome, URL, console });
  vm.createContext(ctx);
  vm.runInContext(source('src/core/page-calls.js') + source('src/utils/page-call.js'), ctx);
  ctx.setNoTabHandler(async siteKey => { ctx.handlerCalls.push(siteKey); onNoTab(tabs); });
  return ctx;
}

test('findSiteTab keeps the preferred tab while it stays on the same site', async () => {
  const tabs = [{ id: 7, url: 'https://mangalib.me/ru/manga/x' }, { id: 9, url: 'https://mangalib.org/ru/catalog' }];
  const ctx = pageCallContext(tabs);
  assert.equal(await ctx.findSiteTab('mangalib', 7), 7);
});

test('findSiteTab falls back to another tab of the same site and never to another site', async () => {
  const tabs = [{ id: 7, url: 'https://hentailib.me/ru/manga/x' }, { id: 9, url: 'https://mangalib.org/ru/catalog' }];
  const ctx = pageCallContext(tabs);
  assert.equal(await ctx.findSiteTab('mangalib', 7), 9);
  assert.equal(await ctx.findSiteTab('ranobelib', 7), null);
});

test('findSiteTab skips discarded tabs', async () => {
  const tabs = [{ id: 1, url: 'https://mangalib.me/a', discarded: true }, { id: 2, url: 'https://mangalib.me/b', status: 'unloaded' }, { id: 3, url: 'https://mangalib.me/c' }];
  assert.equal(await pageCallContext(tabs).findSiteTab('mangalib'), 3);
});

test('pageCall waits through the no-tab handler and retries when the tab disappears', async () => {
  const tabs = [];
  const ctx = pageCallContext(tabs, {
    onNoTab: list => list.push({ id: 3, url: 'https://mangalib.me/ru/manga/x' }),
    onExec: (tabId, list, n) => {
      if (n === 1) {
        list.splice(0, list.length, { id: 4, url: 'https://mangalib.me/ru/manga/x' });
        throw new Error('No tab with id: 3.');
      }
    }
  });
  assert.equal(await ctx.pageCall('mangalib', 'chapterPages', [1, 's', 'normal']), 'ok');
  assert.deepEqual(ctx.handlerCalls, ['mangalib']);
  assert.deepEqual(ctx.execTabs, [3, 4]);
});

test('pageCall passes other injection errors through', async () => {
  const ctx = pageCallContext([{ id: 3, url: 'https://mangalib.me/x' }], { onExec: () => { throw new Error('boom'); } });
  await assert.rejects(ctx.pageCall('mangalib', 'chapters', []), { message: 'boom' });
});

test('default no-tab handler asks to open the site', async () => {
  const ctx = pageCallContext([]);
  vm.runInContext('setNoTabHandler()', ctx); // back to default
  await assert.rejects(ctx.pageCall('mangalib', 'chapters', []), { message: 'Откройте страницу сайта' });
});

test('without chrome.tabs/scripting the lookup goes through the service worker', async () => {
  const sent = [];
  const ctx = pageCallContext([], { noTabApi: true, sendMessage: async msg => { sent.push(msg.action); return { ok: true, result: msg.action === 'pageCall:findTab' ? 5 : 'done' }; } });
  assert.equal(await ctx.pageCall('mangalib', 'chapters', []), 'done');
  assert.deepEqual(sent, ['pageCall:findTab', 'pageCall:exec']);
});

test('siteKeyOf and siteLinks follow the site groups', () => {
  const ctx = pageCallContext([]);
  assert.equal(ctx.siteKeyOf('https://novelslib.me/ru/book/1'), 'ranobelib');
  assert.equal(ctx.siteKeyOf('https://example.com/'), null);
  assert.deepEqual(Array.from(ctx.siteLinks('mangalib')), ['https://mangalib.me', 'https://mangalib.org']);
});

test('SITE_TAB_PATTERNS covers exactly the manifest content_scripts matches', () => {
  const ctx = pageCallContext([]);
  const patterns = Object.values(vm.runInContext('SITE_TAB_PATTERNS', ctx)).flat();
  const manifest = JSON.parse(source('src/manifest.json')).content_scripts[0].matches;
  assert.deepEqual([...patterns].sort(), [...manifest].sort());
});

test('every former executeScript func now lives in PAGE_CALLS and api/base use pageCall', () => {
  assert.doesNotMatch(source('src/core/api.js') + source('src/formatters/base.js'), /chrome\.scripting\.executeScript/);
  const ctx = vm.createContext({});
  vm.runInContext(source('src/core/page-calls.js'), ctx);
  assert.deepEqual(Object.keys(vm.runInContext('PAGE_CALLS', ctx)).sort(), ['chapterPages', 'chapters', 'covers', 'mangaChapterPages', 'metadata', 'metadataExtra']);
});

function functionSource(file, name) {
  const text = source(file);
  const match = new RegExp(`(?:async )?function ${name}[(]`).exec(text);
  assert.ok(match, `Missing function: ${name}`);
  return text.slice(match.index, text.indexOf('\n}', match.index) + 2);
}

// snapshot.js in a vm over a fake chrome.storage holding `data` (reads return copies, like the real one)
function snapshotContext(data) {
  const chrome = { storage: { local: {
    get: async keys => structuredClone(Object.fromEntries([].concat(keys).filter(key => key in data).map(key => [key, data[key]]))),
    set: async values => Object.assign(data, structuredClone(values)),
    remove: async keys => { for (const key of [].concat(keys)) delete data[key]; }
  } } };
  const ctx = vm.createContext({ chrome, URL, console });
  vm.runInContext(source('src/utils/title-store.js') + source('src/utils/page-call.js') + source('src/core/snapshot.js'), ctx);
  return ctx;
}

test('snapshot freezes title data and settings at the moment of the click', async () => {
  const data = { imageQuality: '1080', tocFormat: 'default', speedMode: true, 'titleData:s': { metadata: { titleRu: 'T' }, chapters: [{ id: 1 }, { id: 2 }], translatorPriority: ['a'] }, 'originalTitleData:s': { metadata: { titleRu: 'T0' } } };
  const snap = await snapshotContext(data).buildDownloadSnapshot({ slug: 's', tabId: 5, sourceUrl: 'https://mangalib.me/ru/manga/s', selectedChapterIds: [2], format: 'cbz', imageServer: 'normal', textOnly: false, speedMode: true });
  data.imageQuality = 'ORIGINAL'; data['titleData:s'].metadata.titleRu = 'Changed';
  assert.equal(snap.downloadData.quality, '1080');
  assert.equal(snap.title, 'T');
  assert.equal(snap.siteKey, 'mangalib');
  assert.deepEqual(snap.downloadData.selectedChapterIds, [2]);
  assert.deepEqual(snap.titleExtras.translatorPriority, ['a']);
  assert.equal(snap.stored.speedMode, true);
});

test('snapshot carries what popup and prepare used to put into downloadData', async () => {
  const data = { 'titleData:s': { metadata: { titleRu: 'T', cover: 'c0' }, covers: ['c1'], chapters: [{ id: 1 }, { id: 2 }], filteredChapters: [{ id: 2 }] }, 'originalTitleData:s': { metadata: { titleEn: 'E' } }, disableToc: true };
  const snap = await snapshotContext(data).buildDownloadSnapshot({ slug: 's', tabId: 5, sourceUrl: 'https://ranobelib.me/ru/book/s', selectedChapterIds: [2], format: 'epub', imageServer: 'compressed', textOnly: true });
  const d = snap.downloadData;
  assert.deepEqual([d.siteType, d.siteKey, snap.siteType, d.tabId, d.mangaId], ['ranobe', 'ranobelib', 'ranobe', 5, 's']);
  assert.deepEqual([d.selectedFormat, d.imageServer, d.textOnly], ['epub', 'compressed', true]);
  assert.deepEqual([d.quality, d.coverQuality, d.resizeMethod, d.adaptiveRatio, d.jpegQuality, d.imageFormat, d.pdfImageFormat, d.pdfJpegQuality], ['ORIGINAL', 'ORIGINAL', 'MIN_SIDE', 3, 1, 'original', 'original-png', 1]);
  assert.deepEqual([d.disableToc, d.epubTocPage], [true, false]);
  assert.deepEqual(d.allCovers, ['c1']);
  assert.equal(d.originalCover, 'c0');
  assert.deepEqual(d.chapters, [{ id: 2 }]);
  assert.deepEqual(d.originalMetadata, { titleEn: 'E' });
  assert.deepEqual(snap.titleExtras.allChapters, [{ id: 1 }, { id: 2 }]);
  assert.equal(snap.titleExtras.sourceUrl, 'https://ranobelib.me/ru/book/s');
  assert.equal(JSON.stringify(snap.titleExtras.chapterBranchOverrides), '{}');
  assert.ok(snap.id && snap.createdAt);
});

test('startDownload and formatters never read chrome.storage', () => {
  assert.doesNotMatch(functionSource('src/core/download.js', 'startDownload'), /chrome\.storage|getTitleStore/);
  assert.doesNotMatch(source('src/formatters/cbz.js'), /getTitleStore|chrome\.storage/);
});

// download.js целиком в vm; листенер собирает события в events
function downloadEventsContext(extra = {}) {
  const events = [];
  const ctx = vm.createContext({ console: { error() {}, log() {} }, window: { getStatisticsValue: () => 0 }, ...extra });
  vm.runInContext(source('src/core/download.js') + '\nthis.downloadControl = downloadControl;', ctx);
  ctx.setDownloadListener(event => events.push(structuredClone(event))); // clone: vm objects have another Object.prototype, deepEqual is strict about it
  return { ctx, events };
}

test('download.js does not touch the DOM or storage', () => {
  assert.doesNotMatch(source('src/core/download.js'), /document\.|chrome\.storage|saveAs\(/);
});

test('chapter error emits a decision and skip resumes with the chapter skipped', async () => {
  const { ctx, events } = downloadEventsContext();
  const pending = ctx.handleChapterError({ volume: 1, number: 2, displayTitle: 'Г2' }, new Error('boom'), 1);
  assert.deepEqual(events.at(-1), { type: 'decision', decision: { kind: 'chapter', chapterTitle: 'Г2', message: 'boom' } });
  assert.ok(events.some(e => e.type === 'paused' && e.paused === true));
  ctx.downloadControl.skip();
  assert.deepEqual({ ...(await pending) }, { shouldRetry: false, shouldSkip: true });
  assert.ok(events.some(e => e.type === 'decisionDone'));
  assert.deepEqual(events.filter(e => e.type === 'paused').map(e => e.paused), [true, false]);
});

test('image error emits a decision with the image url and retry repeats the image', async () => {
  const { ctx, events } = downloadEventsContext();
  const pending = ctx.handleImageError({ volume: 1, number: 2, displayTitle: 'Г2' }, new Error('bad'), 1, 'https://x/1.jpg');
  assert.deepEqual(events.at(-1), { type: 'decision', decision: { kind: 'image', chapterTitle: 'Г2', message: 'bad', imageUrl: 'https://x/1.jpg' } });
  ctx.downloadControl.retry();
  assert.deepEqual({ ...(await pending) }, { shouldRetry: true, shouldSkip: false });
});

test('pause and resume emit paused events', () => {
  const { ctx, events } = downloadEventsContext();
  ctx.downloadControl.pause();
  ctx.downloadControl.resume();
  assert.deepEqual(events, [{ type: 'paused', paused: true }, { type: 'paused', paused: false }]);
});

test('stats event carries the protocol fields and takes over from storage', () => {
  const { ctx, events } = downloadEventsContext({ window: { getStatisticsValue: name => name === 'downloadStartTime' ? 0 : 3 } });
  ctx.updateStatisticsDisplay();
  const { type, stats } = events.at(-1);
  assert.equal(type, 'stats');
  assert.deepEqual(Object.keys(stats).sort(), ['elapsed', 'errors', 'estimated', 'fileSize', 'maxRequestsPerMinute', 'oldFormatChapters', 'requestsPerMinute', 'skippedChapters', 'skippedImages', 'totalChapters', 'totalCovers', 'totalImages']);
  assert.deepEqual([stats.errors, stats.requestsPerMinute, stats.maxRequestsPerMinute, stats.oldFormatChapters], [3, 0, 0, 3]);
});

test('log and progress events carry what the window draws', () => {
  const { ctx, events } = downloadEventsContext();
  ctx.addLog('hi', true, 'red');
  ctx.updateProgress(2, 5);
  assert.match(events[0].line, /^\[.*\] hi$/);
  assert.deepEqual([events[0].type, events[0].isError, events[0].color], ['log', true, 'red']);
  assert.deepEqual(events[1], { type: 'progress', current: 2, total: 5 });
});
