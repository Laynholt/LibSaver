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
  const ctx = { tabs, handlerCalls: [], execTabs: [], delays: [] };
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
  Object.assign(ctx, { chrome, URL, console, setTimeout: (fn, ms) => { ctx.delays.push(ms); fn(); } });
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

test('findSiteTab checks the preferred tab by its host, not by a substring of the address', async () => {
  const tabs = [{ id: 7, url: 'https://example.com/?ref=mangalib.me' }, { id: 9, url: 'https://mangalib.org/ru/catalog' }];
  const ctx = pageCallContext(tabs);
  assert.equal(ctx.siteKeyOf(tabs[0].url), 'mangalib'); // the substring match would keep the foreign tab
  assert.equal(await ctx.findSiteTab('mangalib', 7), 9);
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
  assert.deepEqual(ctx.delays, [1000]); // pause before retrying a gone tab, no hot loop
});

test('findSiteTab treats a discarded or unloaded preferred tab as absent', async () => {
  const tabs = [{ id: 7, url: 'https://mangalib.me/a', discarded: true }, { id: 8, url: 'https://mangalib.me/b', status: 'unloaded' }, { id: 9, url: 'https://mangalib.me/c' }];
  const ctx = pageCallContext(tabs);
  assert.equal(await ctx.findSiteTab('mangalib', 7), 9);
  assert.equal(await ctx.findSiteTab('mangalib', 8), 9);
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
  assert.deepEqual(Object.keys(vm.runInContext('PAGE_CALLS', ctx)).sort(), ['animeApi', 'chapterPages', 'chapters', 'covers', 'mangaChapterPages', 'metadata', 'metadataExtra']);
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
  assert.deepEqual(Object.keys(stats).sort(), ['elapsed', 'errors', 'estimated', 'etaSeconds', 'fileSize', 'maxRequestsPerMinute', 'oldFormatChapters', 'requestsPerMinute', 'skippedChapters', 'skippedImages', 'totalChapters', 'totalCovers', 'totalImages']);
  assert.deepEqual([stats.errors, stats.requestsPerMinute, stats.maxRequestsPerMinute, stats.oldFormatChapters], [3, 0, 0, 3]);
});

test('log and progress events carry what the window draws', () => {
  const { ctx, events } = downloadEventsContext();
  ctx.addLog('hi', true, 'red');
  ctx.updateProgress(2, 5);
  assert.match(events[0].line, /^\[.*\] hi$/);
  assert.deepEqual([events[0].type, events[0].isError, events[0].color], ['log', true, 'red']);
  assert.deepEqual(events[1], { type: 'progress', current: 2, total: 5, part: 0 });
});

test('image progress adds the share of the current chapter and a new chapter resets it', () => {
  const { ctx, events } = downloadEventsContext();
  ctx.updateProgress(2, 5);
  ctx.updateImageProgress(10, 40);
  assert.deepEqual(events.at(-1), { type: 'progress', current: 2, total: 5, part: 0.25 });
  ctx.updateImageProgress(50, 40); // a page past the end never overshoots the chapter
  assert.equal(events.at(-1).part, 1);
  ctx.updateProgress(3, 5);
  assert.equal(events.at(-1).part, 0);
});

test('remaining time comes from the speed over the recent samples and grows while nothing moves', () => {
  const { ctx } = downloadEventsContext();
  const eta = ctx.estimateRemainingSeconds;
  assert.equal(eta([], 0), null);
  assert.equal(eta([{ t: 0, f: 0 }, { t: 2000, f: 0.1 }], 2000), null); // under 5 s the speed is not clear yet
  assert.equal(Math.round(eta([{ t: 0, f: 0 }, { t: 10000, f: 0.1 }], 10000)), 90); // 10 s per 10 % -> 90 s left
  assert.equal(Math.round(eta([{ t: 0, f: 0 }, { t: 10000, f: 0.1 }], 20000)), 180); // a stall of 10 s doubles it
  assert.equal(eta([{ t: 0, f: 0.5 }, { t: 10000, f: 0.5 }], 10000), null); // nothing moved
  assert.equal(eta([{ t: 0, f: 0.2 }, { t: 9000, f: 1 }], 9000), 0);
});

test('downloadControl.cancel ends a pending decision and stops further requests', async () => {
  const { ctx } = downloadEventsContext();
  const pending = ctx.handleChapterError({ volume: 1, number: 2, displayTitle: 'Г2' }, new Error('boom'), 1);
  ctx.downloadControl.cancel();
  await assert.rejects(pending, { message: 'Загрузка отменена', canceled: true });
  await assert.rejects(ctx.trackRequest(), { message: 'Загрузка отменена' });
});

// queue.js in this realm (deepEqual compares prototypes); run promises are settled by the test
const createQueue = options => new Function(source('src/engine/queue.js') + '\nreturn createQueue;')()(options);
const snap = (slug, id = slug) => ({ id, slug, siteKey: 'mangalib', title: 'T ' + slug, downloadData: { selectedFormat: 'cbz', tabId: 5, chapters: [{ id: 1 }] } });
const flush = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 30; i++) await flush(); };
function manualRun() {
  const runs = [];
  return { runs, run: (item, snapshot) => new Promise((resolve, reject) => runs.push({ item, snapshot, resolve, reject })) };
}
const statuses = q => Object.fromEntries(q.items().map(item => [item.id, item.status]));

test('queue runs one title at a time and starts the next by itself', async () => {
  const { runs, run } = manualRun();
  const changes = [];
  const q = createQueue({ run, onChange: items => changes.push(items) });
  const a = snap('a');
  q.enqueue(a);
  q.enqueue(snap('b'));
  await flush();
  assert.deepEqual(statuses(q), { a: 'running', b: 'queued' });
  assert.deepEqual(q.items()[1], { id: 'b', slug: 'b', siteKey: 'mangalib', title: 'T b', format: 'cbz', status: 'queued', progress: { current: 0, total: 0 } });
  assert.equal(runs.length, 1);
  assert.notEqual(runs[0].snapshot, a); // own copy: startDownload mutates chapters
  assert.deepEqual(runs[0].snapshot, a);
  runs[0].resolve({ filename: 'a.cbz' });
  await flush();
  assert.deepEqual(statuses(q), { a: 'done', b: 'running' });
  assert.equal(q.items()[0].filename, 'a.cbz');
  assert.equal(runs[1].item.slug, 'b');
  assert.ok(changes.length > 0);
});

test('queue rejects a second click on a title that is already queued or running', () => {
  const q = createQueue({ run: () => new Promise(() => {}), onChange() {} });
  assert.deepEqual(q.enqueue(snap('a')), { ok: true });
  assert.deepEqual(q.enqueue(snap('a', 'a2')), { ok: false, reason: 'already-queued' });
  assert.deepEqual(q.enqueue(snap('b')), { ok: true });
  assert.deepEqual(q.enqueue(snap('b', 'b2')), { ok: false, reason: 'already-queued' });
  q.cancel('b');
  assert.deepEqual(q.enqueue(snap('b', 'b3')), { ok: true });
});

test('an error in one title marks it and the queue moves on', async () => {
  const { runs, run } = manualRun();
  const q = createQueue({ run, onChange() {} });
  q.enqueue(snap('a'));
  q.enqueue(snap('b'));
  await flush();
  runs[0].reject(new Error('boom'));
  await flush();
  assert.deepEqual(statuses(q), { a: 'error', b: 'running' });
  assert.equal(q.items()[0].error, 'boom');
});

test('remove refuses the running item and drops a queued one', async () => {
  const { runs, run } = manualRun();
  const q = createQueue({ run, onChange() {} });
  q.enqueue(snap('a'));
  q.enqueue(snap('b'));
  await flush();
  assert.equal(q.remove('a'), false);
  assert.equal(q.remove('b'), true);
  assert.deepEqual(statuses(q), { a: 'running' });
  runs[0].resolve({ filename: 'a.cbz' });
  await flush();
  assert.equal(q.remove('a'), true);
  assert.deepEqual(q.items(), []);
});

test('cancel stops a queued title at once and the running one when its run settles', async () => {
  const { runs, run } = manualRun();
  const q = createQueue({ run, onChange() {} });
  q.enqueue(snap('a'));
  q.enqueue(snap('b'));
  q.enqueue(snap('c'));
  await flush();
  q.cancel('b');
  q.cancel('a');
  await flush();
  assert.deepEqual(statuses(q), { a: 'canceled', b: 'canceled', c: 'queued' }); // one download at a time: c waits for a's run to end
  runs[0].reject(new Error('Загрузка отменена'));
  await flush();
  assert.deepEqual(statuses(q), { a: 'canceled', b: 'canceled', c: 'running' });
  assert.equal(q.items()[0].error, undefined);
  assert.deepEqual(runs.map(r => r.item.id), ['a', 'c']);
});

test('setStatus merges extra fields and drops cleared ones', () => {
  const q = createQueue({ run: () => new Promise(() => {}), onChange() {} });
  q.enqueue(snap('a'));
  q.setStatus('a', 'waiting-decision', { decision: { kind: 'chapter', chapterTitle: 'Г1', message: 'x' } });
  assert.deepEqual(q.items()[0].decision, { kind: 'chapter', chapterTitle: 'Г1', message: 'x' });
  q.setStatus('a', 'running', { decision: undefined, progress: { current: 1, total: 3 } });
  assert.equal('decision' in q.items()[0], false);
  assert.deepEqual(q.items()[0].progress, { current: 1, total: 3 });
});

// engine.js + queue.js in a vm; startDownload(snapshot, { noTab, emit }) is the test's fake download
function engineContext({ findSiteTab = async () => 1, startDownload, downloads } = {}) {
  const ctx = { delays: [], history: [], sent: [], urls: [], revoked: [], controlCalls: [] };
  let onConnect, noTabHandler, listener;
  const downloadControl = {};
  for (const name of ['pause', 'resume', 'retry', 'skip', 'setSpeedMode', 'cancel']) downloadControl[name] = (...args) => ctx.controlCalls.push([name, ...args]);
  const chrome = { runtime: { onConnect: { addListener: fn => { onConnect = fn; } }, sendMessage: async message => { ctx.sent.push(JSON.parse(JSON.stringify(message))); return { ok: true }; } } };
  if (downloads) chrome.downloads = downloads;
  Object.assign(ctx, {
    chrome, console, structuredClone, Date,
    URL: { createObjectURL: () => { ctx.urls.push('blob:' + ctx.urls.length); return ctx.urls.at(-1); }, revokeObjectURL: url => ctx.revoked.push(url) },
    setTimeout: (fn, ms) => { ctx.delays.push(ms); setImmediate(fn); return ctx.delays.length; }, // a macrotask, so a polling loop cannot starve the test
    clearTimeout() {},
    findSiteTab,
    setNoTabHandler: fn => { noTabHandler = fn; },
    setDownloadListener: fn => { listener = fn; },
    startDownload: snapshot => startDownload(snapshot, { noTab: siteKey => noTabHandler(siteKey), emit: event => listener(event) }),
    downloadControl
  });
  vm.createContext(ctx);
  vm.runInContext(source('src/engine/queue.js'), ctx);
  const realCreateQueue = ctx.createQueue;
  ctx.createQueue = options => realCreateQueue({ ...options, onChange: items => { ctx.history.push(items.map(item => item.status).join()); options.onChange(items); } });
  vm.runInContext(source('src/engine/engine.js'), ctx);
  ctx.connect = (name = 'libsaver-engine') => {
    const port = { name, posted: [], postMessage: message => port.posted.push(JSON.parse(JSON.stringify(message))) };
    port.onMessage = { addListener: fn => { port.send = fn; } };
    port.onDisconnect = { addListener: fn => { port.disconnect = fn; } };
    onConnect(port);
    return port;
  };
  ctx.statusHistory = () => ctx.history.filter((entry, i) => entry !== ctx.history[i - 1]);
  return ctx;
}

test('waiting-tab returns to running when a tab of the site appears', async () => {
  const answers = [null, null, 12];
  const ctx = engineContext({
    findSiteTab: async () => answers.shift(),
    startDownload: async (snapshot, { noTab }) => { await noTab(snapshot.siteKey); return { blob: {}, filename: 'a.cbz' }; }
  });
  ctx.connect().send({ cmd: 'enqueue', snapshot: snap('a') });
  await settle();
  assert.deepEqual(ctx.statusHistory(), ['queued', 'running', 'waiting-tab', 'running', 'done']);
  assert.equal(answers.length, 0);
  assert.equal(ctx.delays.filter(ms => ms === 2000).length, 3);
});

test('cancel of a title waiting for a tab ends the wait and the next title starts', async () => {
  const runs = [];
  const ctx = engineContext({
    findSiteTab: async () => null,
    startDownload: (snapshot, { noTab }) => { const done = noTab(snapshot.siteKey).then(() => ({ blob: {}, filename: 'x' })); runs.push(done); return done; }
  });
  const port = ctx.connect();
  port.send({ cmd: 'enqueue', snapshot: snap('a') });
  port.send({ cmd: 'enqueue', snapshot: snap('b') });
  await settle();
  port.send({ cmd: 'cancel', id: 'a' });
  await settle();
  await assert.rejects(runs[0], { message: 'Загрузка отменена' });
  assert.ok(ctx.controlCalls.some(([name]) => name === 'cancel'));
  const { items } = port.posted.filter(m => m.type === 'state').at(-1).state;
  assert.deepEqual(items.map(item => item.status), ['canceled', 'waiting-tab']);
  port.send({ cmd: 'cancel', id: 'b' }); // stop b's polling so the test process can exit
  await assert.rejects(runs[1], { message: 'Загрузка отменена' });
});

test('cancel that arrives while the tab lookup is in flight still ends the wait', async () => {
  const lookups = [];
  const runs = [];
  const ctx = engineContext({
    findSiteTab: () => new Promise(resolve => lookups.push(resolve)),
    startDownload: (snapshot, { noTab }) => {
      const done = snapshot.slug === 'a' ? noTab(snapshot.siteKey).then(() => ({ blob: {}, filename: 'a' })) : Promise.resolve({ blob: {}, filename: 'b.cbz' });
      runs.push(done);
      return done;
    }
  });
  const port = ctx.connect();
  port.send({ cmd: 'enqueue', snapshot: snap('a') });
  port.send({ cmd: 'enqueue', snapshot: snap('b') });
  await settle();
  assert.equal(lookups.length, 1); // first poll is waiting for findSiteTab
  port.send({ cmd: 'cancel', id: 'a' });
  lookups[0](null);
  await settle();
  await assert.rejects(runs[0], { message: 'Загрузка отменена' });
  assert.equal(lookups.length, 1); // no polling after the cancel
  const { items } = port.posted.filter(m => m.type === 'state').at(-1).state;
  assert.deepEqual(items.map(item => item.status), ['canceled', 'done']);
});

test('engine turns download events into state, forwards commands and saves the file', async () => {
  let finish;
  const ctx = engineContext({
    startDownload: (snapshot, { emit }) => new Promise(resolve => {
      emit({ type: 'progress', current: 1, total: 2 });
      emit({ type: 'log', line: 'L1', isError: false, color: null });
      emit({ type: 'stats', stats: { elapsed: '00:01' } });
      emit({ type: 'paused', paused: true });
      emit({ type: 'decision', decision: { kind: 'chapter', chapterTitle: 'Г1', message: 'boom' } });
      finish = () => { emit({ type: 'decisionDone' }); emit({ type: 'paused', paused: false }); resolve({ blob: {}, filename: 'a.cbz' }); };
    })
  });
  assert.equal(ctx.connect('other-port').send, undefined); // other ports are ignored
  const port = ctx.connect();
  assert.deepEqual(port.posted[0], { type: 'state', state: { items: [], stats: null, logTail: [] } });
  port.send({ cmd: 'enqueue', snapshot: snap('a') });
  port.send({ cmd: 'enqueue', snapshot: snap('a', 'a2') });
  await settle();
  assert.deepEqual(port.posted.filter(m => m.type === 'enqueueResult'), [{ type: 'enqueueResult', ok: true }, { type: 'enqueueResult', ok: false, reason: 'already-queued' }]);
  assert.deepEqual(port.posted.find(m => m.type === 'log'), { type: 'log', id: 'a', line: 'L1', isError: false, color: null });
  const states = port.posted.filter(m => m.type === 'state');
  assert.equal(states.length, 2); // the burst of changes goes out as one throttled state
  assert.deepEqual(states[1].state, {
    items: [{ id: 'a', slug: 'a', siteKey: 'mangalib', title: 'T a', format: 'cbz', status: 'waiting-decision', progress: { current: 1, total: 2, part: 0 }, decision: { kind: 'chapter', chapterTitle: 'Г1', message: 'boom' } }],
    stats: { elapsed: '00:01' },
    logTail: [{ line: 'L1', isError: false, color: null }]
  });
  port.send({ cmd: 'decision', choice: 'retry' });
  port.send({ cmd: 'pause' });
  port.send({ cmd: 'speedMode', on: true });
  assert.deepEqual(ctx.controlCalls, [['retry'], ['pause'], ['setSpeedMode', true]]);
  finish();
  await settle();
  assert.deepEqual(ctx.sent, [{ action: 'saveFile', url: 'blob:0', filename: 'a.cbz' }]);
  const last = port.posted.filter(m => m.type === 'state').at(-1).state.items[0];
  assert.deepEqual([last.status, last.filename, 'decision' in last], ['done', 'a.cbz', false]);
  port.send({ cmd: 'saveAgain', id: 'a' });
  await settle();
  assert.equal(ctx.sent.length, 2);
  port.send({ cmd: 'remove', id: 'a' });
  assert.deepEqual(ctx.revoked, ['blob:0']);
});

test('engine saves through chrome.downloads where it exists', async () => {
  const calls = [];
  const ctx = engineContext({ downloads: { download: async options => { calls.push({ ...options }); return 1; } }, startDownload: async () => ({ blob: {}, filename: 'a.cbz' }) });
  ctx.connect().send({ cmd: 'enqueue', snapshot: snap('a') });
  await settle();
  assert.deepEqual(calls, [{ url: 'blob:0', filename: 'a.cbz', saveAs: false }]);
  assert.deepEqual(ctx.sent, []);
});

test('ensureEngine creates one offscreen document even for concurrent calls', async () => {
  const created = [];
  let has = false;
  const chrome = { offscreen: { hasDocument: async () => has, createDocument: async options => { await null; created.push(JSON.parse(JSON.stringify(options))); has = true; } } };
  const ctx = vm.createContext({ chrome });
  vm.runInContext('let engineReady = null;\n' + functionSource('src/background.js', 'ensureEngine'), ctx);
  assert.deepEqual(await Promise.all([ctx.ensureEngine(), ctx.ensureEngine()]), [true, true]);
  assert.equal(await ctx.ensureEngine(), true);
  assert.deepEqual(created, [{ url: 'engine/engine.html', reasons: ['DOM_PARSER', 'BLOBS'], justification: 'Фоновая сборка файлов LibSaver' }]);
  assert.ok(JSON.parse(source('src/manifest.json')).permissions.includes('offscreen'));
});

test('saveFile is refused to a page context with a tab (content script) and served to the engine', async () => {
  const downloads = [];
  const ctx = vm.createContext({ chrome: { downloads: { download: async options => { downloads.push({ ...options }); return 1; } } }, console });
  vm.runInContext(functionSource('src/background.js', 'handleEngineMessage'), ctx);
  const ask = sender => new Promise(resolve => ctx.handleEngineMessage({ action: 'saveFile', url: 'blob:x', filename: 'a.cbz' }, sender, response => resolve(JSON.parse(JSON.stringify(response)))));
  const refused = await ask({ id: 'ext', tab: { id: 3 } });
  assert.equal(refused.ok, false);
  assert.ok(refused.error);
  assert.deepEqual(downloads, []);
  assert.deepEqual(await ask({ id: 'ext', url: 'chrome-extension://ext/engine/engine.html' }), { ok: true });
  assert.deepEqual(downloads, [{ url: 'blob:x', filename: 'a.cbz', saveAs: false }]);
});

test('scripts of the engine page use neither storage, tabs, downloads nor the window DOM', () => {
  const scripts = [...source('src/engine/engine.html').matchAll(/<script src="\.\.\/([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(scripts, ['libs/jszip.min.js', 'libs/pica.min.js', 'core/page-calls.js', 'utils/page-call.js', 'core/api.js', 'utils/protection.js', 'utils/header.js', 'core/statistics.js',
    'formatters/base.js', 'formatters/epub.js', 'formatters/txt.js', 'formatters/pdf.js', 'formatters/html.js', 'formatters/fb2.js', 'formatters/cbz.js', 'formatters/index.js', 'core/download.js', 'engine/queue.js', 'engine/anime.js', 'engine/engine.js']);
  // code only: template literals (html.js builds the reader page's script in one) and line comments are text
  const code = file => source('src/' + file).replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``').replace(/^\s*\/\/.*$/gm, '');
  for (const file of scripts.filter(file => file !== 'utils/page-call.js' && file !== 'engine/engine.js')) {
    assert.doesNotMatch(code(file), /chrome\.storage|chrome\.tabs\.|chrome\.scripting|chrome\.downloads|document\.getElementById/, file);
  }
});

// --- Firefox: the engine runs as the background page, merged with background.js ---

test('engine-side code promises no toast it cannot show, and no message goes to a listener that is gone (R33)', () => {
  assert.doesNotMatch(source('src/formatters/base.js'), /showToast\(/); // the JPEG fallback is a log line in the engine
  assert.doesNotMatch(source('src/core/settings.js'), /tocSettingsReset/);
});

test('firefoxManifest: background page instead of the service worker, gecko id, no Chrome-only permissions', () => {
  const { firefoxManifest } = require('../tools/build-firefox.cjs');
  const chromeManifest = JSON.parse(source('src/manifest.json'));
  const manifest = firefoxManifest(chromeManifest);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, undefined);
  assert.deepEqual(manifest.background, { page: 'engine/background-firefox.html' });
  assert.ok(fs.existsSync(path.join(root, 'src', manifest.background.page)));
  assert.equal(manifest.browser_specific_settings.gecko.id, 'libsaver@laynholt');
  assert.deepEqual(manifest.browser_specific_settings, { gecko: { id: 'libsaver@laynholt', strict_min_version: '128.0', data_collection_permissions: { required: ['none'] } }, gecko_android: { strict_min_version: '128.0' } });
  assert.equal(manifest.permissions.includes('offscreen'), false);
  assert.equal(manifest.permissions.includes('system.display'), false);
  assert.deepEqual(manifest.permissions, chromeManifest.permissions.filter(permission => permission !== 'offscreen' && permission !== 'system.display'));
  assert.deepEqual(manifest.web_accessible_resources, chromeManifest.web_accessible_resources);
  assert.ok(chromeManifest.background.service_worker); // the Chrome manifest itself is left as is
});

test('Firefox background page loads background.js and every engine.html script once, with no top-level name clash', () => {
  const scripts = file => [...source(file).matchAll(/<script src="\.\.\/([^"]+)"/g)].map(match => match[1]);
  const page = scripts('src/engine/background-firefox.html');
  assert.deepEqual(page.filter(file => file !== 'background.js'), scripts('src/engine/engine.html'));
  assert.equal(page.filter(file => file === 'background.js').length, 1);
  // a const declared twice in one page is a SyntaxError for the whole script; a second function silently replaces the first
  const names = file => [...source('src/' + file).matchAll(/^(?:async )?(?:const|let|var|function|class) +([\w$]+)/gm)].map(match => match[1]);
  const engineNames = new Set(page.filter(file => file !== 'background.js' && !file.startsWith('libs/')).flatMap(names));
  assert.deepEqual(names('background.js').filter(name => engineNames.has(name)), []);
});

test('in the Firefox background page the engine calls the page, saves and fetches images directly, not via runtime.sendMessage', async () => {
  const sent = [], executed = [], downloads = [], fetched = [];
  const tab = { id: 7, url: 'https://mangalib.me/ru/manga/x', status: 'complete' };
  const chrome = {
    // the page does not receive its own message: nobody answers
    runtime: { sendMessage: (message, reply) => { sent.push(message.action); reply?.(undefined); return Promise.resolve(undefined); } },
    tabs: { get: async () => tab, query: async () => [tab] },
    scripting: { executeScript: async ({ target }) => { executed.push(target.tabId); return [{ result: 'ok' }]; } },
    downloads: { download: async options => { downloads.push({ ...options }); return 1; } }
  };
  const ctx = vm.createContext({
    chrome, URL, console, setTimeout,
    fetch: async url => { fetched.push(url); return { ok: true, blob: async () => ({}) }; },
    FileReader: class { readAsDataURL() { this.result = 'data:image/png;base64,'; this.onloadend(); } }
  });
  vm.runInContext(source('src/core/page-calls.js') + source('src/utils/page-call.js') + functionSource('src/background.js', 'directFetch')
    + functionSource('src/engine/engine.js', 'safeDownloadFilename') + functionSource('src/engine/engine.js', 'saveFile')
    + source('src/formatters/base.js') + '\nthis.Formatter = BaseFormatter;', ctx);
  assert.equal(await ctx.pageCall('mangalib', 'chapters', []), 'ok');
  assert.deepEqual(executed, [7]);
  await ctx.saveFile('blob:x', 'a.cbz');
  assert.deepEqual(downloads, [{ url: 'blob:x', filename: 'a.cbz', saveAs: false }]);
  await new ctx.Formatter({}).downloadAndResizeImage('https://img3.cdnlibs.org/p.png', 'ORIGINAL').catch(() => {}); // no Image in the vm: only the fetch matters
  assert.deepEqual(fetched, ['https://img3.cdnlibs.org/p.png']);
  assert.deepEqual(sent, []);
});

test('ensureEngine answers true without chrome.offscreen (Firefox: the engine is the background page itself)', async () => {
  const ctx = vm.createContext({ chrome: {} });
  vm.runInContext('let engineReady = null;\n' + functionSource('src/background.js', 'ensureEngine'), ctx);
  assert.equal(await ctx.ensureEngine(), true);
});

// --- Downloads view: pure markup of the queue, the log and the stats ---

// downloads-view.js in a vm without a document: only the pure renderers load, the port wiring waits for DOMContentLoaded
function viewContext() {
  const ctx = vm.createContext({ console, chrome: {} });
  vm.runInContext(source('src/utils/page-call.js') + source('src/core/downloads-view.js'), ctx);
  return ctx;
}
const queueItem = (over = {}) => ({ id: 'a', slug: 's', siteKey: 'mangalib', title: 'Title', format: 'cbz', status: 'running', progress: { current: 1, total: 4 }, ...over });
const cmds = html => [...html.matchAll(/data-cmd="([^"]+)"/g)].map(match => match[1]);

test('renderQueueItem escapes the title, the format and the error', () => {
  const view = viewContext();
  const html = view.renderQueueItem(queueItem({ title: '<b>Bold</b> & "q"', format: '<i>', status: 'error', error: '<script>x</script>' }));
  assert.doesNotMatch(html, /<b>|<i>|<script>/);
  assert.match(html, /&lt;b&gt;Bold&lt;\/b&gt; &amp; &quot;q&quot;/);
  assert.match(html, /Ошибка: &lt;script&gt;x&lt;\/script&gt;/);
});

test('waiting-tab names the site and links to its domains', () => {
  const html = viewContext().renderQueueItem(queueItem({ status: 'waiting-tab' }));
  assert.match(html, /Откройте страницу MangaLIB, чтобы продолжить/);
  assert.match(html, /href="https:\/\/mangalib\.me"/);
  assert.match(html, /href="https:\/\/mangalib\.org"/);
  assert.match(html, /data-url="https:\/\/mangalib\.org"/);
});

test('retry and skip are offered only while a decision is pending', () => {
  const view = viewContext();
  const decision = { kind: 'chapter', chapterTitle: 'Глава <1>', message: 'boom <b>' };
  const waiting = view.renderQueueItem(queueItem({ status: 'waiting-decision', decision }));
  assert.deepEqual(cmds(waiting).filter(cmd => cmd === 'retry' || cmd === 'skip'), ['retry', 'skip']);
  assert.match(waiting, /Глава &lt;1&gt;/);
  assert.match(waiting, /boom &lt;b&gt;/);
  assert.doesNotMatch(waiting, /Глава <1>|boom <b>/);
  assert.deepEqual(cmds(view.renderQueueItem(queueItem())), ['pause', 'cancel']);
});

test('each status offers exactly its commands, all addressed to the item', () => {
  const view = viewContext();
  const expected = {
    queued: ['cancel', 'remove'],
    running: ['pause', 'cancel'],
    paused: ['resume', 'cancel'],
    'waiting-tab': ['cancel'],
    'waiting-decision': ['retry', 'skip', 'cancel'],
    done: ['saveAgain', 'remove'],
    error: ['remove'],
    canceled: ['remove']
  };
  for (const [status, commands] of Object.entries(expected)) {
    const html = view.renderQueueItem(queueItem({ status, decision: { kind: 'chapter', chapterTitle: '', message: '' }, canSaveAgain: true }));
    assert.deepEqual(cmds(html), commands, status);
    assert.equal((html.match(/data-id="a"/g) || []).length, commands.length, status);
  }
  assert.deepEqual(cmds(view.renderQueueItem(queueItem({ status: 'done' }))), ['remove']); // the engine released its file (R32)
});

test('progress shows chapters done out of total; a finished title with fewer chapters is reported as partial', () => {
  const view = viewContext();
  assert.match(view.renderQueueItem(queueItem()), /1 \/ 4 глав/);
  assert.match(view.renderQueueItem(queueItem()), /width: 25%/);
  const done = view.renderQueueItem(queueItem({ status: 'done', progress: { current: 4, total: 4 }, filename: 'a<b>.cbz' }));
  assert.match(done, /Готово/);
  assert.doesNotMatch(done, /с пропусками/);
  assert.match(done, /a&lt;b&gt;\.cbz/);
  assert.match(view.renderQueueItem(queueItem({ status: 'done', progress: { current: 1, total: 2 } })), /Готово с пропусками: 1 \/ 2 глав/);
  assert.match(view.renderQueueItem(queueItem({ status: 'queued', progress: { current: 0, total: 0 } })), /width: 0%/);
});

test('renderStats prints the protocol fields and escapes them', () => {
  const view = viewContext();
  const html = view.renderStats({ elapsed: '5 сек', estimated: '1 мин', fileSize: '<1 MB', errors: 2, skippedChapters: 1, skippedImages: 3, requestsPerMinute: 7, maxRequestsPerMinute: 75, oldFormatChapters: 0, totalChapters: 4, totalCovers: 1, totalImages: 80 });
  assert.match(html, /7 \(75\)/);
  assert.match(html, /Пропущено глав:<\/span>\s*<span class="analysis-value">1</);
  assert.match(html, /&lt;1 MB/);
  assert.doesNotMatch(html, /Главы старого формата/);
  assert.match(view.renderStats({ oldFormatChapters: 2 }), /Главы старого формата/);
  assert.equal(view.renderStats(null), '');
});

test('renderLog escapes lines, marks errors and keeps only safe colors', () => {
  const view = viewContext();
  const html = view.renderLog([{ line: '<img src=x>', isError: true, color: null }, { line: 'ok', isError: false, color: '#2e7d32' }, { line: 'bad', isError: false, color: 'red;background:url(x)' }]);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<div class="log-entry error">&lt;img src=x&gt;<\/div>/);
  assert.match(html, /<div class="log-entry" style="color: #2e7d32">ok<\/div>/);
  assert.match(html, /<div class="log-entry">bad<\/div>/);
});

test('downloads page is self-contained: theme, port client and view, no download code', () => {
  const html = source('src/html/downloads.html');
  const scripts = [...html.matchAll(/<script src="\.\.\/([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(scripts.slice(-3), ['core/theme.js', 'utils/page-call.js', 'core/downloads-view.js']);
  assert.ok(scripts.includes('core/theme-init.js'));
  assert.doesNotMatch(html, /download\.js|formatters|jszip|FileSaver/);
  assert.match(html, /css\/downloads\.css/);
  assert.match(html, /id="speed-mode-checkbox"/);
  assert.ok(JSON.parse(source('src/manifest.json')).web_accessible_resources[0].resources.includes('html/downloads.html'));
  assert.doesNotMatch(source('src/core/downloads-view.js'), /startDownload|downloadControl/);
});

// --- Downloads view: the port client over a fake DOM and a fake port ---

function wiringContext({ failures = 0 } = {}) {
  const elements = {};
  const clone = value => JSON.parse(JSON.stringify(value)); // vm objects have another Object.prototype
  const element = id => elements[id] ||= { id, innerHTML: '', hidden: false, style: {}, checked: false, scrollTop: 0, scrollHeight: 100, clientHeight: 50, listeners: {}, textContent: '', classes: new Set(), classList: { toggle: (name, on) => { on ? elements[id].classes.add(name) : elements[id].classes.delete(name); } }, addEventListener(type, fn) { this.listeners[type] = fn; } };
  const ports = [];
  const created = [];
  const stored = [];
  const delays = [];
  const seenWhileRetrying = [];
  const storageListeners = [];
  const intervals = []; // { fn, ms, cleared }; the id is the 1-based index
  let attempts = 0;
  const ctx = vm.createContext({
    console: { error() {}, log() {} }, setTimeout: (fn, ms) => { delays.push(ms); fn(); return 0; },
    setInterval: (fn, ms) => intervals.push({ fn, ms, cleared: false }), clearInterval: id => { intervals[id - 1].cleared = true; },
    document: { getElementById: element, addEventListener() {} },
    chrome: {
      runtime: {
        sendMessage: async message => {
          if (++attempts > 1) seenWhileRetrying.push(element('dl-connection').textContent);
          if (attempts <= failures) throw new Error('engine restarting');
          ports.push({ ensure: clone(message) });
          return true;
        },
        connect: options => {
          const port = { options, posted: [], postMessage: message => port.posted.push(clone(message)), onMessage: { addListener: fn => { port.receive = fn; } }, onDisconnect: { addListener: fn => { port.drop = fn; } } };
          ports.push(port);
          return port;
        }
      },
      tabs: { create: options => created.push(clone(options)) },
      storage: { onChanged: { addListener: fn => storageListeners.push(fn) }, local: { get: async () => ({ speedMode: true }), set: async values => stored.push(clone(values)) } }
    }
  });
  vm.runInContext(source('src/utils/page-call.js') + source('src/core/downloads-view.js'), ctx);
  return { ctx, element, ports, created, stored, delays, seenWhileRetrying, storageListeners, intervals };
}

test('view ensures the engine, connects to the port and draws the state it receives', async () => {
  const { ctx, element, ports } = wiringContext();
  await ctx.initDownloadsView();
  assert.deepEqual(ports[0], { ensure: { action: 'ensureEngine' } });
  const port = ports[1];
  assert.equal(port.options.name, 'libsaver-engine');
  assert.equal(element('speed-mode-checkbox').checked, true); // restored from storage
  port.receive({ type: 'state', state: { items: [queueItem({ title: 'A<b>' })], stats: { errors: 1 }, logTail: [{ line: 'L', isError: false, color: null }] } });
  assert.match(element('dl-list').innerHTML, /A&lt;b&gt;/);
  assert.match(element('dl-log').innerHTML, />L</);
  assert.match(element('dl-stats').innerHTML, /analysis-value/);
  assert.equal(element('dl-empty').hidden, true);
  port.receive({ type: 'state', state: { items: [], stats: null, logTail: [] } });
  assert.equal(element('dl-empty').hidden, false);
  assert.equal(element('dl-list').innerHTML, '');
});

test('«Очистить завершённые» shows only with finished items and removes all of them at once, leaving the active ones', async () => {
  const { ctx, element, ports } = wiringContext();
  await ctx.initDownloadsView();
  const port = ports[1];
  port.receive({ type: 'state', state: { items: [queueItem({ id: 'run', status: 'running' }), queueItem({ id: 'q', status: 'queued' })], stats: null, logTail: [] } });
  assert.equal(element('dl-clear-finished').hidden, true);
  port.receive({ type: 'state', state: { items: [queueItem({ id: 'run', status: 'running' }), queueItem({ id: 'd', status: 'done' }), queueItem({ id: 'e', status: 'error' }), queueItem({ id: 'c', status: 'canceled' })], stats: null, logTail: [] } });
  assert.equal(element('dl-clear-finished').hidden, false);
  element('dl-clear-finished').listeners.click();
  assert.deepEqual(port.posted, [{ cmd: 'remove', id: 'd' }, { cmd: 'remove', id: 'e' }, { cmd: 'remove', id: 'c' }]);
});

test('view buttons become protocol commands; links open tabs; speed mode is sent and remembered', async () => {
  const { ctx, element, ports, created, stored } = wiringContext();
  await ctx.initDownloadsView();
  const port = ports[1];
  const click = (cmd, id = 'a') => element('dl-list').listeners.click({ target: { closest: selector => selector === '[data-cmd]' ? { dataset: { cmd, id } } : null }, preventDefault() {} });
  for (const cmd of ['pause', 'resume', 'cancel', 'remove', 'saveAgain', 'retry', 'skip']) click(cmd);
  assert.deepEqual(port.posted, [
    { cmd: 'pause' }, { cmd: 'resume' }, { cmd: 'cancel', id: 'a' }, { cmd: 'remove', id: 'a' }, { cmd: 'saveAgain', id: 'a' },
    { cmd: 'decision', choice: 'retry' }, { cmd: 'decision', choice: 'skip' }
  ]);
  let prevented = 0;
  element('dl-list').listeners.click({ target: { closest: selector => selector === 'a[data-url]' ? { dataset: { url: 'https://mangalib.me' } } : null }, preventDefault: () => prevented++ });
  assert.deepEqual([created, prevented], [[{ url: 'https://mangalib.me' }], 1]);
  const speed = element('speed-mode-checkbox');
  speed.checked = false;
  speed.listeners.change();
  assert.deepEqual(port.posted.at(-1), { cmd: 'speedMode', on: false });
  assert.deepEqual(stored, [{ speedMode: false }]);
});

test('view pings the engine every 20 s while a title is in work, and stops when the queue is idle or the port drops (R31)', async () => {
  const { ctx, ports, intervals } = wiringContext();
  await ctx.initDownloadsView();
  const port = ports[1];
  port.receive({ type: 'state', state: { items: [queueItem({ status: 'done' })], stats: null, logTail: [] } });
  assert.equal(intervals.length, 0); // nothing in work
  port.receive({ type: 'state', state: { items: [queueItem({ status: 'waiting-tab' })], stats: null, logTail: [] } });
  port.receive({ type: 'state', state: { items: [queueItem()], stats: null, logTail: [] } });
  assert.deepEqual(intervals.map(timer => timer.ms), [20000]); // one timer, not one per state
  intervals[0].fn();
  assert.deepEqual(port.posted, [{ cmd: 'ping' }]);
  port.receive({ type: 'state', state: { items: [queueItem({ status: 'done' })], stats: null, logTail: [] } });
  assert.equal(intervals[0].cleared, true);
  port.receive({ type: 'state', state: { items: [queueItem({ status: 'paused' })], stats: null, logTail: [] } });
  assert.equal(intervals.length, 2);
  port.drop();
  assert.equal(intervals[1].cleared, true);
});

// --- Safe file names for chrome.downloads ---

test('safeDownloadFilename replaces reserved characters, strips trailing dots and spaces, keeps the extension', () => {
  const ctx = vm.createContext({});
  vm.runInContext(functionSource('src/engine/engine.js', 'safeDownloadFilename'), ctx);
  const safe = ctx.safeDownloadFilename;
  assert.equal(safe('A: B?.cbz'), 'A_ B_.cbz');
  assert.equal(safe('Что?..cbz'), 'Что_.cbz');
  assert.equal(safe('Title. .epub'), 'Title.epub');
  assert.equal(safe('Title   '), 'Title');
  assert.equal(safe('a/b\\c*d"e<f>g|h\u0001.pdf'), 'a_b_c_d_e_f_g_h_.pdf');
  assert.equal(safe('.cbz'), 'LibSaver.cbz');
  assert.equal(safe('..'), 'LibSaver');
  assert.equal(safe(''), 'LibSaver');
  assert.equal(safe('Plain name.fb2'), 'Plain name.fb2');
});

test('engine saves under the safe name, first time and again', async () => {
  const calls = [];
  const ctx = engineContext({ downloads: { download: async options => { calls.push(options.filename); return 1; } }, startDownload: async () => ({ blob: {}, filename: 'A: B?. .cbz' }) });
  const port = ctx.connect();
  port.send({ cmd: 'enqueue', snapshot: snap('a') });
  await settle();
  port.send({ cmd: 'saveAgain', id: 'a' });
  await settle();
  assert.deepEqual(calls, ['A_ B_.cbz', 'A_ B_.cbz']);
  assert.equal(port.posted.filter(m => m.type === 'state').at(-1).state.items[0].filename, 'A: B?. .cbz'); // the item keeps the real name
});

test('engine keeps the file only of the latest finished title: the older one is released and loses «Сохранить ещё раз» (R32)', async () => {
  const ctx = engineContext({ startDownload: async snapshot => ({ blob: {}, filename: `${snapshot.slug}.cbz` }) });
  const port = ctx.connect();
  port.send({ cmd: 'enqueue', snapshot: snap('a') });
  await settle();
  assert.deepEqual(ctx.revoked, []);
  let items = port.posted.filter(m => m.type === 'state').at(-1).state.items;
  assert.deepEqual(items.map(item => [item.id, item.status, !!item.canSaveAgain]), [['a', 'done', true]]);
  port.send({ cmd: 'enqueue', snapshot: snap('b') });
  await settle();
  assert.deepEqual(ctx.revoked, ['blob:0']); // a's blob goes when b is ready
  items = port.posted.filter(m => m.type === 'state').at(-1).state.items;
  assert.deepEqual(items.map(item => [item.id, item.status, 'canSaveAgain' in item]), [['a', 'done', false], ['b', 'done', true]]);
  const saved = ctx.sent.length;
  port.send({ cmd: 'saveAgain', id: 'a' }); // released: nothing to save
  await settle();
  assert.equal(ctx.sent.length, saved);
  port.send({ cmd: 'saveAgain', id: 'b' });
  await settle();
  assert.deepEqual(ctx.sent.at(-1), { action: 'saveFile', url: 'blob:1', filename: 'b.cbz' });
  port.send({ cmd: 'remove', id: 'a' }); // removing a released item revokes nothing
  assert.deepEqual(ctx.revoked, ['blob:0']);
  port.send({ cmd: 'remove', id: 'b' });
  assert.deepEqual(ctx.revoked, ['blob:0', 'blob:1']);
});

test('engine takes «ping» as a no-op: no error, no state, no command (R31)', async () => {
  const ctx = engineContext({ startDownload: () => new Promise(() => {}) });
  const port = ctx.connect();
  port.send({ cmd: 'enqueue', snapshot: snap('a') });
  await settle();
  const posted = port.posted.length;
  port.send({ cmd: 'ping' });
  await settle();
  assert.equal(port.posted.length, posted);
  assert.deepEqual(ctx.controlCalls, []);
});

// --- the windows as clients of the queue (engine-client.js, site-download.js) ---

function queueClient({ reply, disconnectInstead = false }) {
  const calls = [];
  const clone = value => JSON.parse(JSON.stringify(value));
  const port = { posted: [], disconnected: false, disconnect() { this.disconnected = true; }, onMessage: { addListener: fn => { port.receive = fn; } }, onDisconnect: { addListener: fn => { port.drop = fn; } },
    postMessage(message) { this.posted.push(clone(message)); Promise.resolve().then(() => disconnectInstead ? port.drop() : port.receive({ type: 'enqueueResult', ...reply })); } };
  const ctx = vm.createContext({
    chrome: { runtime: { sendMessage: async message => { calls.push(['sendMessage', clone(message)]); return true; }, connect: options => { calls.push(['connect', options.name]); return port; } } }
  });
  vm.runInContext(source('src/utils/engine-client.js'), ctx);
  return { ctx, calls, port };
}

test('«Скачать» enqueues the snapshot in the engine and lets the port go', async () => {
  const { ctx, calls, port } = queueClient({ reply: { ok: true } });
  assert.equal((await ctx.enqueueSnapshot({ id: 'x' })).ok, true);
  assert.deepEqual(calls, [['sendMessage', { action: 'ensureEngine' }], ['connect', 'libsaver-engine']]);
  assert.deepEqual(port.posted, [{ cmd: 'enqueue', snapshot: { id: 'x' } }]);
  assert.equal(port.disconnected, true);
});

test('a title that is already queued comes back as a refusal the windows show as a message', async () => {
  const { ctx } = queueClient({ reply: { ok: false, reason: 'already-queued' } });
  assert.deepEqual(jsonCopy(await ctx.enqueueSnapshot({ id: 'x' })), { type: 'enqueueResult', ok: false, reason: 'already-queued' });
  const quick = quickContext({}, { enqueueResult: { ok: false, reason: 'already-queued' } });
  assert.deepEqual(jsonCopy(await quick.enqueueSelection({ slug: 's', tabId: 1, url: 'https://mangalib.me/ru/manga/s', selectedChapterIds: [1], format: 'cbz' })), { ok: false, message: 'Этот тайтл уже в очереди' });
});

test('other rejections and a missing engine surface as errors', async () => {
  const quick = quickContext({}, { enqueueResult: { ok: false, reason: 'queue-full' } });
  await assert.rejects(quick.enqueueSelection({ slug: 's', tabId: 1, url: 'https://mangalib.me/ru/manga/s', selectedChapterIds: [1], format: 'cbz' }), /Очередь не приняла/);
  await assert.rejects(queueClient({ disconnectInstead: true }).ctx.enqueueSnapshot({ id: 'x' }), /Движок загрузки/);
});

test('the windows over the site no longer run, render or save downloads themselves', () => {
  for (const file of ['src/core/panel.js', 'src/core/quick.js', 'src/core/site-download.js']) {
    assert.doesNotMatch(source(file), /startDownload|runDownload|saveAs\(|downloadControl|setDownloadListener|addLogToContainer|renderStats/, file);
  }
  for (const page of ['panel', 'quick']) {
    assert.doesNotMatch(source(`src/html/${page}.html`), /core\/download\.js|formatters\/|jszip|pica|FileSaver|id="log"|id="btn-pause"|stats-time/, page);
  }
  assert.match(source('src/core/panel.js'), /downloads\.html/);
  // the old «Подготовка» and tabbed windows are gone together with their pages and styles
  for (const file of ['html/prepare', 'core/prepare', 'css/prepare', 'html/workspace', 'core/workspace'].map(name => `src/${name}.${name.split('/')[0] === 'core' ? 'js' : name.split('/')[0]}`)) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
});

test('view shows «Подключаюсь…» until the first state, then the queue or «Очередь пуста»', async () => {
  const { ctx, element, ports } = wiringContext();
  await ctx.initDownloadsView();
  assert.equal(element('dl-connection').textContent, 'Подключаюсь…');
  assert.equal(element('dl-connection').hidden, false);
  assert.equal(element('dl-empty').hidden, true); // the empty-queue text must not appear before the engine has answered
  assert.equal(element('dl-list').classes.has('dl-offline'), true);
  ports[1].receive({ type: 'state', state: { items: [], stats: null, logTail: [] } });
  assert.equal(element('dl-connection').hidden, true);
  assert.equal(element('dl-empty').hidden, false);
  assert.equal(element('dl-list').classes.has('dl-offline'), false);
});

test('view keeps reconnecting with a growing delay, says so meanwhile, and commands reach the new port', async () => {
  const { ctx, element, ports, delays, seenWhileRetrying } = wiringContext({ failures: 3 });
  await ctx.initDownloadsView();
  assert.deepEqual(delays, [1000, 2000, 4000]);
  assert.deepEqual(seenWhileRetrying, Array(3).fill('Нет связи с движком, переподключаюсь…'));
  const port = ports[1];
  port.receive({ type: 'state', state: { items: [queueItem()], stats: null, logTail: [] } });
  const click = cmd => element('dl-list').listeners.click({ target: { closest: selector => selector === '[data-cmd]' ? { dataset: { cmd, id: 'a' } } : null }, preventDefault() {} });
  click('cancel');
  assert.deepEqual(port.posted, [{ cmd: 'cancel', id: 'a' }]);
  // the port drops (engine restart): offline notice, commands are not sent into the void, a new connection follows
  port.drop();
  assert.equal(element('dl-connection').hidden, false);
  assert.equal(element('dl-connection').textContent, 'Нет связи с движком, переподключаюсь…');
  click('remove');
  assert.deepEqual(port.posted, [{ cmd: 'cancel', id: 'a' }]);
  await settle(); // the fake timer fires at once, so the new connection comes up
  assert.equal(ports.length, 4); // ensure + port, twice
  assert.equal(element('dl-connection').textContent, 'Подключаюсь…');
  ports[3].receive({ type: 'state', state: { items: [queueItem()], stats: null, logTail: [] } });
  click('remove');
  assert.deepEqual(port.posted, [{ cmd: 'cancel', id: 'a' }]);
  assert.deepEqual(ports[3].posted, [{ cmd: 'remove', id: 'a' }]);
});

test('the reconnect delay is capped', async () => {
  const { ctx, delays } = wiringContext({ failures: 6 });
  await ctx.initDownloadsView();
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 10000, 10000]);
});

test('«Ускорить» in the downloads view follows storage changes', async () => {
  const { ctx, element, storageListeners } = wiringContext();
  await ctx.initDownloadsView();
  assert.equal(storageListeners.length, 1);
  const speed = element('speed-mode-checkbox');
  assert.equal(speed.checked, true);
  storageListeners[0]({ speedMode: { newValue: false } }, 'local');
  assert.equal(speed.checked, false);
  storageListeners[0]({ speedMode: { newValue: true } }, 'sync');
  assert.equal(speed.checked, false); // other areas are ignored
  storageListeners[0]({ speedMode: { newValue: true } }, 'local');
  assert.equal(speed.checked, true);
  storageListeners[0]({ speedMode: { newValue: false } }, 'local');
  storageListeners[0]({ speedMode: {} }, 'local'); // key removed: back to the default, on
  assert.equal(speed.checked, true);
});

test('the snapshot takes «Ускорить» from storage, so the windows pass no value of their own', async () => {
  for (const file of ['src/core/site-download.js', 'src/core/quick.js']) assert.doesNotMatch(source(file), /speedMode/, file);
  const snapshot = await snapshotContext({ speedMode: true, 'titleData:s': { metadata: { titleRu: 'T' } }, 'originalTitleData:s': { metadata: {} } })
    .buildDownloadSnapshot({ slug: 's', tabId: 5, sourceUrl: 'https://mangalib.me/ru/manga/s', selectedChapterIds: [1], format: 'cbz', imageServer: 'normal', textOnly: false });
  assert.equal(snapshot.stored.speedMode, true);
});

// Задача 6: chapter-range.js, ?slug= в title-store, title-loader.js

function chapterRangeContext() {
  const ctx = vm.createContext({});
  vm.runInContext(source('src/core/chapter-range.js'), ctx);
  return ctx;
}

test('rangeChapterIds returns ids between two indices inclusive, in either order', () => {
  const { rangeChapterIds } = chapterRangeContext();
  const chapters = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(rangeChapterIds(chapters, 2, 0), [1, 2, 3]);
  assert.deepEqual(rangeChapterIds(chapters, 0, 1), [1, 2]);
  assert.deepEqual(rangeChapterIds(chapters, 1, 1), [2]);
});

test('chapterLabel is «Том X. Глава Y. Название» and drops the name part when empty', () => {
  const { chapterLabel } = chapterRangeContext();
  assert.equal(chapterLabel({ volume: '2', number: '15', name: 'Встреча' }), 'Том 2. Глава 15. Встреча');
  assert.equal(chapterLabel({ volume: '1', number: '3', name: '' }), 'Том 1. Глава 3');
  assert.equal(chapterLabel({ volume: '1', number: '3' }), 'Том 1. Глава 3');
});

test('applyTranslatorPriority picks the preferred translator per chapter and records it in the overrides', () => {
  const { applyTranslatorPriority, getUniqueChapters } = chapterRangeContext();
  const branch = (id, team) => ({ branch_id: id, teams: [{ id: team, name: 'T' + team }] });
  const chapter = (id, ...branches) => ({ id, branches, branchId: String(branches[0].branch_id), branchTeamName: 'x' });
  const chapters = [chapter(1, branch(10, 1), branch(20, 2)), chapter(2, branch(10, 1), branch(20, 2)), chapter(3, branch(20, 2))];
  // без приоритета он строится по числу глав у переводчика: у T2 три главы, у T1 две
  const priority = applyTranslatorPriority(chapters, [], {});
  assert.deepEqual(Array.from(priority), ['20_2', '10_1']);
  assert.deepEqual(chapters.map(ch => ch.branchId), ['20', '20', '20']);
  // явный приоритет; одиночная глава остаётся у единственного переводчика
  const overrides = {};
  applyTranslatorPriority(chapters, ['10_1', '20_2'], overrides);
  assert.deepEqual(chapters.map(ch => ch.branchId), ['10', '10', '20']);
  assert.deepEqual({ ...overrides }, { 1: '10_1', 2: '10_1' });
  assert.equal(getUniqueChapters([{ id: 1 }, { id: 1 }, { id: 2 }]).length, 2);
});

test('getTitleStore takes currentSlug from ?slug= on extension pages only, else from storage', async () => {
  const run = async (search, protocol = 'chrome-extension:') => {
    const data = { currentSlug: 'stored', 'titleData:abc': { n: 1 }, 'titleData:stored': { n: 2 } };
    const ctx = vm.createContext({ URLSearchParams, chrome: { storage: { local: {
      get: async keys => structuredClone(Object.fromEntries([].concat(keys).filter(key => key in data).map(key => [key, data[key]]))),
      set: async values => Object.assign(data, values),
      remove: async keys => { for (const key of [].concat(keys)) delete data[key]; }
    } } }, location: { search, protocol } });
    vm.runInContext(source('src/utils/title-store.js'), ctx);
    return structuredClone(await ctx.getTitleStore(['titleData', 'currentSlug']));
  };
  const fromUrl = { currentSlug: 'abc', titleData: { abc: { n: 1 } } };
  const fromStorage = { currentSlug: 'stored', titleData: { stored: { n: 2 } } };
  assert.deepEqual(await run('?slug=abc'), fromUrl);
  assert.deepEqual(await run('?slug=abc', 'moz-extension:'), fromUrl);
  assert.deepEqual(await run('?title=0'), fromStorage);
  assert.deepEqual(await run(''), fromStorage);
  // у сайта свой параметр slug: он не подменяет тайтл
  assert.deepEqual(await run('?slug=abc', 'https:'), fromStorage);
  // битое процентное кодирование не бросает
  await assert.doesNotReject(run('?slug=%E0%A4%A'));
});

test('chapter-range.js, title-loader.js and the pages loading them are not redefined by other scripts on the pages loading them', () => {
  const names = file => [...source(file).matchAll(/^(?:async\s+)?function\s+(\w+)|^(?:const|let|var)\s+(\w+)/gm)].map(m => m[1] || m[2]);
  const pages = { 'src/html/chapters.html': 'src/editors/chapters.js', 'src/html/panel.html': 'src/core/panel.js', 'src/html/quick.html': 'src/core/quick.js' };
  for (const [html, script] of Object.entries(pages)) {
    const scripts = [...source(html).matchAll(/<script src="\.\.\/([^"]+)"/g)].map(m => 'src/' + m[1]);
    assert.ok(scripts.includes('src/core/chapter-range.js') && scripts.indexOf('src/core/chapter-range.js') < scripts.indexOf(script), html);
    const shared = scripts.filter(file => file.endsWith('/chapter-range.js') || file.endsWith('/title-loader.js'));
    const sharedNames = new Set(shared.flatMap(names));
    for (const file of scripts.filter(file => !shared.includes(file) && !file.includes('/libs/'))) {
      const clash = names(file).filter(name => sharedNames.has(name));
      assert.deepEqual(clash, [], `${file} redefines names from chapter-range.js/title-loader.js on ${html}`);
    }
  }
});

// title-loader.js в vm: хранилище на data, загрузчики api.js заменены заглушками
function titleLoaderContext(data, api = {}) {
  const calls = [];
  const ctx = vm.createContext({
    URL, console: { error() {}, log() {} },
    chrome: { storage: { local: {
      get: async keys => structuredClone(keys === null ? data : Object.fromEntries([].concat(keys).filter(key => key in data).map(key => [key, data[key]]))),
      set: async values => Object.assign(data, structuredClone(values)),
      remove: async keys => { for (const key of [].concat(keys)) delete data[key]; }
    } } },
    formatChapterTitle: (vol, num, name) => `${vol}-${num}-${name}`,
    loadChapters: async tabId => { calls.push(['chapters', tabId]); return api.chapters; },
    loadMetadata: async tabId => { calls.push(['metadata', tabId]); return api.metadata; },
    loadCovers: async (tabId, slug) => { calls.push(['covers', tabId, slug]); return api.covers; }
  });
  vm.runInContext(['src/utils/title-store.js', 'src/utils/page-call.js', 'src/core/chapter-range.js', 'src/core/title-loader.js'].map(source).join('\n'), ctx);
  ctx.calls = calls;
  return ctx;
}

const rawChapters = [
  { id: 2, volume: '1', number: '2', name: 'B', branches: [{ branch_id: 7, teams: [{ id: 1, name: 'Team' }] }] },
  { id: 1, volume: '1', number: '1', name: '', branches: [{ branch_id: 7, teams: [{ id: 1, name: 'Team' }] }] }
];
const mangaApi = () => ({
  chapters: { success: true, slug: '123--title', chapters: structuredClone(rawChapters) },
  metadata: { success: true, slug: '123--title', metadata: { titleRu: 'Тайтл', cover: 'c0', totalChapters: 2 } },
  covers: { success: true, covers: ['c0', 'c1'] }
});

test('loadTitleData rejects non-title pages and unknown sites with a code and never touches the API', async () => {
  const ctx = titleLoaderContext({}, mangaApi());
  await assert.rejects(ctx.loadTitleData({ tabId: 1, url: 'https://example.org/ru/manga/1--a' }), { code: 'unsupported-site' });
  await assert.rejects(ctx.loadTitleData({ tabId: 1, url: 'https://mangalib.me/ru/catalog' }), { code: 'not-title-page' });
  assert.deepEqual(ctx.calls, []);
});

test('loadTitleData loads a title in parallel, saves it and returns unique chapters with the translator priority applied', async () => {
  const data = {};
  const ctx = titleLoaderContext(data, mangaApi());
  const info = await ctx.loadTitleData({ tabId: 5, url: 'https://mangalib.me/ru/manga/123--title?section=info' });
  assert.deepEqual(ctx.calls, [['chapters', 5], ['metadata', 5], ['covers', 5, '123--title']]);
  assert.deepEqual([info.slug, info.siteKey, info.siteType, info.title], ['123--title', 'mangalib', 'manga', 'Тайтл']);
  assert.deepEqual(Array.from(info.chapters, ch => ch.id), [1, 2]); // отсортированы по тому и номеру
  assert.equal(info.allChapters.length, 2);
  assert.deepEqual(Array.from(info.covers), ['c0', 'c1']);
  assert.deepEqual(Array.from(info.translatorPriority), ['7_1']);
  assert.equal(info.chapters[0].displayTitle, '1-1-');
  assert.equal(data.currentSlug, '123--title');
  const stored = data['titleData:123--title'];
  assert.equal(stored.chapters.length, 2);
  assert.deepEqual(stored.metadata, { titleRu: 'Тайтл', cover: 'c0', totalChapters: 2 });
  assert.deepEqual(data['originalTitleData:123--title'].covers, [{ url: 'c0', type: 'url' }, { url: 'c1', type: 'url' }]);
  assert.ok(stored.cacheTimestamp > 0);
});

test('loadTitleData answers from a fresh complete cache and reloads when forced or stale', async () => {
  const data = {};
  await titleLoaderContext(data, mangaApi()).loadTitleData({ tabId: 5, url: 'https://mangalib.me/ru/manga/123--title' });
  data.currentSlug = 'other';
  const cached = titleLoaderContext(data, mangaApi());
  const info = await cached.loadTitleData({ tabId: 5, url: 'https://mangalib.me/ru/manga/123--title' });
  assert.deepEqual(cached.calls, []);
  assert.equal(data.currentSlug, '123--title');
  assert.deepEqual([info.title, info.chapters.length, info.covers.length], ['Тайтл', 2, 2]);
  assert.equal(info.metadata.cover, 'c0');

  const forced = titleLoaderContext(data, mangaApi());
  await forced.loadTitleData({ tabId: 5, url: 'https://mangalib.me/ru/manga/123--title', force: true });
  assert.equal(forced.calls.length, 3);

  data['titleData:123--title'].cacheTimestamp = Date.now() - 11 * 60 * 1000;
  const stale = titleLoaderContext(data, mangaApi());
  await stale.loadTitleData({ tabId: 5, url: 'https://mangalib.me/ru/manga/123--title' });
  assert.equal(stale.calls.length, 3);
});

test('loadTitleData survives failing metadata and covers, and fails with load-failed without chapters', async () => {
  const partial = mangaApi();
  partial.metadata = { success: false, error: 'x' };
  partial.covers = { success: false };
  const info = await titleLoaderContext({}, partial).loadTitleData({ tabId: 1, url: 'https://mangalib.me/ru/manga/123--title' });
  assert.equal(info.chapters.length, 2);
  const broken = mangaApi();
  broken.chapters = { success: false, error: 'x' };
  const data = {};
  await assert.rejects(titleLoaderContext(data, broken).loadTitleData({ tabId: 1, url: 'https://mangalib.me/ru/manga/123--title' }), { code: 'load-failed' });
  assert.equal(data.currentSlug, undefined);
});

test('title loader and chapter helpers do not touch the page DOM', () => {
  assert.doesNotMatch(source('src/core/title-loader.js'), /document\.|window\./);
  assert.doesNotMatch(source('src/core/chapter-range.js'), /document\.|window\./);
});

// ---- Task 7: content script site-ui.js ----

// Minimal DOM: just what ensureButtons and the buttons host use
class FakeEl {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attrs = {}; this.parentElement = null; this.selectors = []; this.computed = {};
    this.style = { setProperty: (name, value) => { this.style[name] = value; } };
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  attachShadow() { return new FakeEl('#shadow'); }
  addEventListener() {}
  remove() { this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
  get nextElementSibling() { const siblings = this.parentElement?.children; return siblings?.[siblings.indexOf(this) + 1] || null; }
  insertAdjacentElement(where, el) {
    assert.equal(where, 'afterend');
    el.remove(); // like the DOM: an element that is already in the tree moves
    this.parentElement.children.splice(this.parentElement.children.indexOf(this) + 1, 0, el);
    el.parentElement = this.parentElement;
    return el;
  }
  matches(selector) { return selector === '[data-libsaver-buttons]' ? 'data-libsaver-buttons' in this.attrs : this.selectors.includes(selector); }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

// Title page: root > grid > read button; `columns` is the grid's computed grid-template-columns
function fakeTitleDoc(siteKey, { columns = '260px' } = {}) {
  const doc = new FakeEl('#document');
  const grid = new FakeEl('div');
  grid.computed = { gridTemplateColumns: columns };
  const anchor = new FakeEl('a');
  anchor.selectors = ['a.btn.variant-primary[href*="/read/"]'];
  anchor.computed = { height: '32px', width: '260px', borderRadius: '6px' };
  grid.append(anchor);
  doc.append(grid);
  Object.assign(doc, {
    anchor, grid, siteKey,
    head: new FakeEl('head'),
    createElement: tag => new FakeEl(tag),
    createElementNS: (ns, tag) => new FakeEl(tag),
    defaultView: { getComputedStyle: el => el.computed }
  });
  return doc;
}

function siteUiContext({ stored = {} } = {}) {
  const listeners = new Set();
  const messageListeners = new Set();
  const ctx = {
    console, URL, URLSearchParams, stored, listeners, messageListeners,
    location: { href: 'https://mangalib.me/ru/manga/123--title', origin: 'https://mangalib.me' },
    chrome: {
      runtime: { id: 'id', getURL: file => 'chrome-extension://id/' + file, sendMessage: async () => ({}), onMessage: { addListener: fn => messageListeners.add(fn), removeListener: fn => messageListeners.delete(fn) } },
      storage: { local: { get: async () => structuredClone(stored) }, onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } }
    }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  // the content script list from manifest.json: theme.js (ACCENT_COLORS), page-call.js (siteKeyOf), formats.js (format key), site-ui.js
  vm.runInContext(['src/core/theme.js', 'src/utils/page-call.js', 'src/utils/formats.js', 'src/content/site-ui.js'].map(source).join('\n'), ctx);
  return ctx;
}

test('ensureButtons inserts once and survives repeated SPA updates', () => {
  const ctx = siteUiContext();
  const doc = fakeTitleDoc('mangalib');
  assert.equal(ctx.ensureButtons(doc, 'https://mangalib.me/ru/manga/x'), 'inserted');
  assert.equal(doc.grid.children[1].attrs['data-libsaver-buttons'], '');
  assert.equal(ctx.ensureButtons(doc, 'https://mangalib.me/ru/manga/x'), 'present');
  assert.equal(doc.querySelectorAll('[data-libsaver-buttons]').length, 1);
  assert.equal(ctx.ensureButtons(doc, 'https://mangalib.me/ru/catalog'), 'not-title');
  assert.equal(doc.querySelectorAll('[data-libsaver-buttons]').length, 0);
});

test('ensureButtons reports a missing anchor and an unsupported site without touching the page', () => {
  const ctx = siteUiContext();
  const doc = fakeTitleDoc('mangalib');
  doc.anchor.selectors = [];
  assert.equal(ctx.ensureButtons(doc, 'https://mangalib.me/ru/manga/x'), 'no-anchor');
  const other = fakeTitleDoc('x');
  assert.equal(ctx.ensureButtons(other, 'https://example.com/ru/manga/x'), 'no-anchor');
  assert.equal(doc.querySelectorAll('[data-libsaver-buttons]').length + other.querySelectorAll('[data-libsaver-buttons]').length, 0);
});

test('ensureButtons takes a full grid row when the grid has several columns, and sizes itself from the anchor', () => {
  const ctx = siteUiContext();
  const narrow = fakeTitleDoc('ranobelib', { columns: '170px 170px' });
  Object.assign(narrow.anchor.computed, { zIndex: '3', order: '1' }); // телефонная вёрстка: сайт поднимает кнопки над фоном шапки
  ctx.ensureButtons(narrow, 'https://ranobelib.me/ru/book/y');
  const row = narrow.grid.children[1];
  assert.deepEqual([row.style.gridColumn, row.style['--ls-width'], row.style.zIndex, row.style.order], ['1 / -1', '100%', '3', '1']);
  const wide = fakeTitleDoc('ranobelib');
  ctx.ensureButtons(wide, 'https://ranobelib.me/ru/book/y');
  const host = wide.grid.children[1];
  assert.ok(!host.style.gridColumn);
  assert.deepEqual([host.style['--ls-height'], host.style['--ls-radius'], host.style['--ls-width']], ['32px', '6px', '260px']);
});

test('reader pages are not title pages', () => {
  const ctx = siteUiContext();
  assert.equal(ctx.isTitlePage('https://mangalib.me/ru/manga/x/read/v1/c1'), false);
  assert.equal(ctx.isTitlePage('https://ranobelib.me/ru/book/y'), true);
  assert.equal(ctx.isTitlePage('https://mangalib.me/ru/manga/123--title?section=info#top'), true);
  assert.equal(ctx.isTitlePage('https://mangalib.me/ru/catalog'), false);
});

test('title slug is parsed like title-loader does, and the settings URL carries slug, tab, url and parent', () => {
  const ctx = siteUiContext();
  assert.equal(ctx.titleSlug('https://mangalib.me/ru/manga/123--title?section=info#top'), '123--title');
  assert.equal(ctx.titleSlug('https://ranobelib.me/ru/book/7--y'), '7--y');
  const url = new URL(ctx.buildPanelUrl('https://mangalib.me/ru/manga/123--title', 42, 'https://mangalib.me'));
  assert.equal(url.href.split('?')[0], 'chrome-extension://id/html/panel.html');
  assert.deepEqual(Object.fromEntries(url.searchParams), { slug: '123--title', tab: '42', url: 'https://mangalib.me/ru/manga/123--title', parent: 'https://mangalib.me' });
});

test('frame messages are trusted only from our iframe and origin', () => {
  const ctx = siteUiContext();
  const frame = { contentWindow: {} };
  assert.equal(ctx.isTrustedFrameMessage({ source: frame.contentWindow, origin: 'chrome-extension://id', data: { libsaver: true } }, frame), true);
  assert.equal(ctx.isTrustedFrameMessage({ source: {}, origin: 'chrome-extension://id', data: { libsaver: true } }, frame), false);
  assert.equal(ctx.isTrustedFrameMessage({ source: frame.contentWindow, origin: 'https://mangalib.me', data: { libsaver: true } }, frame), false);
  assert.equal(ctx.isTrustedFrameMessage({ source: frame.contentWindow, origin: 'chrome-extension://id', data: { libsaver: false } }, frame), false);
  assert.equal(ctx.isTrustedFrameMessage({ source: frame.contentWindow, origin: 'chrome-extension://id', data: null }, frame), false);
});

test('accent: the forced one wins, otherwise the site color; the light theme uses the light variant', () => {
  const ctx = siteUiContext();
  const accent = (site, forced, dark) => JSON.parse(JSON.stringify(ctx.accentFor(site, forced, dark)));
  assert.equal(accent('mangalib', 'auto', true).color, '#ef6c00');
  assert.equal(accent('mangalib', undefined, false).color, '#ff9100');
  assert.equal(accent('hentailib', 'auto', true).color, '#b71c1c');
  assert.equal(accent('shlib', 'auto', true).color, '#ad1457');
  assert.equal(accent('ranobelib', 'auto', true).color, '#1565c0');
  assert.equal(accent('mangalib', 'green', true).color, '#4caf50');
  assert.equal(accent('mangalib', 'nonsense', true).color, '#ef6c00');
});

test('site-ui content script is registered for all five sites, with its stylesheet, font and iframe pages exposed', () => {
  const manifest = JSON.parse(source('src/manifest.json'));
  const script = manifest.content_scripts[1];
  assert.deepEqual(script.js, ['core/theme.js', 'utils/page-call.js', 'utils/formats.js', 'content/site-ui.js']);
  assert.deepEqual(script.matches, manifest.content_scripts[0].matches);
  assert.ok(script.matches.includes('https://animelib.org/*'));
  const [libs, ...rest] = manifest.web_accessible_resources;
  for (const resource of ['css/site-ui.css', 'html/panel.html', 'html/quick.html', 'html/downloads.html', 'libs/fontawesome/webfonts/fa-solid-900.woff2']) {
    assert.ok(libs.resources.includes(resource), resource);
  }
  // R14: pages open only on the sites where site-ui.js frames them, not on <all_urls>; the deleted pages and the popup are gone
  assert.deepEqual(libs.matches, script.matches);
  assert.deepEqual(libs.resources.filter(resource => /prepare|workspace|popup/.test(resource)), []);
  // SiteMenuRestorer.js fetches the menu icons on the same sites: one entry covers them
  assert.deepEqual([libs.resources.includes('assets/svg/*.svg'), rest.length], [true, 0]);
  assert.equal(JSON.stringify(manifest).includes('<all_urls>'), JSON.stringify(manifest.host_permissions).includes('<all_urls>'));
  assert.equal(libs.resources.some(resource => resource.startsWith('assets/fonts')), false); // pages load their own fonts, the site never asks for them
  assert.equal(manifest.permissions.some(name => name.startsWith('system.')), false);
});

test('whoami answers with the sender tab id and url', () => {
  const ctx = vm.createContext({ chrome: {}, console });
  vm.runInContext(functionSource('src/background.js', 'handleEngineMessage'), ctx);
  let answer;
  ctx.handleEngineMessage({ action: 'whoami' }, { tab: { id: 5, url: 'https://mangalib.me/ru/manga/x' } }, response => { answer = JSON.parse(JSON.stringify(response)); });
  assert.deepEqual(answer, { tabId: 5, url: 'https://mangalib.me/ru/manga/x' });
});

// ---- Task 8: quick «Скачать» popover ----

test('format options are one list per site type, shared by the panel, the quick popover and the buttons', () => {
  const ctx = vm.createContext({ console });
  vm.runInContext(['src/utils/formats.js', 'src/utils/page-call.js', 'src/core/title-loader.js', 'src/core/site-download.js', 'src/core/quick.js'].map(source).join('\n'), ctx);
  const values = siteKey => Array.from(ctx.quickFormatOptions(siteKey), option => option.value);
  assert.ok(!values('ranobelib').includes('cbz'));
  assert.deepEqual(values('ranobelib'), ['epub', 'fb2', 'pdf', 'txt', 'html']);
  for (const siteKey of ['mangalib', 'hentailib', 'shlib']) {
    assert.ok(!values(siteKey).includes('fb2') && !values(siteKey).includes('txt'), siteKey);
    assert.deepEqual(values(siteKey), ['cbz', 'zip', 'pdf', 'epub', 'html']);
  }
  assert.deepEqual(values('animelib'), ['mp4']);
  assert.deepEqual([ctx.defaultFormatFor('manga'), ctx.defaultFormatFor('ranobe'), ctx.defaultFormatFor('anime')], ['cbz', 'epub', 'mp4']);
  assert.deepEqual([ctx.formatKeyFor('manga'), ctx.formatKeyFor('ranobe'), ctx.formatKeyFor('anime'), ctx.formatKeyFor(undefined)], ['selectedFormat_manga', 'selectedFormat_ranobe', 'selectedFormat_anime', 'selectedFormat_ranobe']);
  assert.doesNotMatch(source('src/core/panel.js'), /value: 'cbz'/);
  assert.doesNotMatch(source('src/core/quick.js'), /value: 'cbz'/);
});

function quickContext(data = {}, { enqueueResult = { ok: true } } = {}) {
  const calls = { snapshot: [], enqueue: [] };
  const ctx = vm.createContext({
    URL, console,
    chrome: { storage: { local: {
      get: async keys => structuredClone(Object.fromEntries([].concat(keys).filter(key => key in data).map(key => [key, data[key]]))),
      set: async values => Object.assign(data, structuredClone(values)),
      remove: async keys => { for (const key of [].concat(keys)) delete data[key]; }
    } } },
    buildDownloadSnapshot: async args => { calls.snapshot.push(structuredClone(args)); return { id: 'snap' }; },
    enqueueSnapshot: async snapshot => { calls.enqueue.push(snapshot); return enqueueResult; }
  });
  vm.runInContext(['src/utils/title-store.js', 'src/utils/page-call.js', 'src/core/chapter-range.js', 'src/utils/formats.js', 'src/core/title-loader.js', 'src/core/site-download.js', 'src/core/quick.js'].map(source).join('\n'), ctx);
  ctx.calls = calls;
  return ctx;
}

test('the button label counts chapters in Russian and the range keeps «до» not below «от»', () => {
  const ctx = quickContext();
  const labels = [1, 2, 4, 5, 11, 12, 21, 22, 25, 111].map(ctx.downloadLabel);
  assert.deepEqual(labels, ['Скачать 1 главу', 'Скачать 2 главы', 'Скачать 4 главы', 'Скачать 5 глав', 'Скачать 11 глав', 'Скачать 12 глав', 'Скачать 21 главу', 'Скачать 22 главы', 'Скачать 25 глав', 'Скачать 111 глав']);
  assert.deepEqual(Array.from(ctx.syncRange(5, 3, 'from')), [5, 5]);
  assert.deepEqual(Array.from(ctx.syncRange(5, 3, 'to')), [3, 3]);
  assert.deepEqual(Array.from(ctx.syncRange(2, 7, 'from')), [2, 7]);
  assert.deepEqual(Array.from(ctx.syncRange(2, 7, 'to')), [2, 7]);
});

test('quick settings keep the preparation window defaults for the image server and text-only', () => {
  const ctx = quickContext();
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.quickSettings({}))), { imageServer: 'compressed', textOnly: false });
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.quickSettings({ imageServer: 'normal', textOnly: true }))), { imageServer: 'normal', textOnly: true });
  assert.equal(ctx.quickSettings({ imageServer: 'bogus', textOnly: 'yes' }).imageServer, 'compressed');
  assert.equal(ctx.quickSettings({ textOnly: 'yes' }).textOnly, false);
});

test('the quick window writes siteType and sourceUrl before loading, like popup, and forwards force and onProgress', async () => {
  const data = {};
  const ctx = quickContext(data);
  const seen = [];
  ctx.loadTitleData = async args => { seen.push([data.siteType, data.sourceUrl, args.tabId, args.url, args.force, args.onProgress]); return { slug: 's' }; };
  const url = 'https://ranobelib.me/ru/book/7--y';
  const onProgress = () => {};
  assert.deepEqual(await ctx.loadQuickTitle({ tabId: 3, url }), { slug: 's' });
  await ctx.loadQuickTitle({ tabId: 3, url, force: true, onProgress });
  assert.deepEqual(seen, [['ranobe', url, 3, url, false, undefined], ['ranobe', url, 3, url, true, onProgress]]);
});

test('«Скачать N глав» snapshots the chosen range, fixes the saved range for the editors and enqueues once', async () => {
  const chapter = id => ({ id, volume: '1', number: String(id), name: '' });
  const data = {
    'titleData:7--y': { chapters: [1, 2, 3, 4].map(chapter), filteredChapters: [chapter(1)], metadata: {} },
    imageServer: 'normal', textOnly: true, speedMode: true
  };
  const ctx = quickContext(data);
  const info = { slug: '7--y', chapters: [1, 2, 3, 4].map(chapter), allChapters: [1, 2, 3, 4].map(chapter) };
  const url = 'https://ranobelib.me/ru/book/7--y';
  const result = await ctx.startQuickDownload({ info, fromIdx: 2, toIdx: 1, tabId: 9, url, format: 'txt' });
  assert.equal(result.ok, true);
  assert.deepEqual(ctx.calls.snapshot, [{ slug: '7--y', tabId: 9, sourceUrl: url, selectedChapterIds: [2, 3], format: 'txt', imageServer: 'normal', textOnly: true }]);
  assert.ok(!('speedMode' in ctx.calls.snapshot[0]));
  assert.deepEqual(ctx.calls.enqueue, [{ id: 'snap' }]);
  assert.deepEqual(data['titleData:7--y'].filteredChapters.map(ch => ch.id), [2, 3]);
  assert.ok(!('fromIdx' in data['titleData:7--y']) && !('toIdx' in data['titleData:7--y'])); // nothing reads the old popup bounds any more
});

test('an already queued title is reported in words, other rejections are errors', async () => {
  const info = { slug: 's', chapters: [{ id: 1 }], allChapters: [{ id: 1 }] };
  const args = { info, fromIdx: 0, toIdx: 0, tabId: 1, url: 'https://mangalib.me/ru/manga/s', format: 'cbz' };
  const queued = await quickContext({}, { enqueueResult: { ok: false, reason: 'already-queued' } }).startQuickDownload(args);
  assert.deepEqual(JSON.parse(JSON.stringify(queued)), { ok: false, message: 'Этот тайтл уже в очереди' });
  await assert.rejects(quickContext({}, { enqueueResult: { ok: false, reason: 'queue-full' } }).startQuickDownload(args), /^Error: Очередь не приняла тайтл$/);
});

test('load errors have the texts popup shows', () => {
  const ctx = quickContext();
  const text = code => ctx.loadErrorText(Object.assign(new Error('x'), { code }));
  assert.equal(text('load-failed'), 'Не удалось получить данные из API.');
  assert.equal(text('not-title-page'), 'Перейдите на главную страницу нужного тайтла.');
  assert.equal(text('unsupported-site'), 'Перейдите на один из поддерживаемых сайтов.');
  assert.equal(ctx.loadErrorText(new Error('boom')), 'boom');
});

test('quick.html is a self-contained extension page that loads what quick.js needs, in order', () => {
  const html = source('src/html/quick.html');
  const scripts = [...html.matchAll(/<script src="\.\.\/([^"]+)"/g)].map(m => m[1]);
  const order = ['core/theme-init.js', 'utils/title-store.js', 'core/theme.js', 'utils/header.js', 'core/page-calls.js', 'utils/page-call.js', 'core/api.js', 'core/chapter-range.js', 'utils/formats.js', 'core/title-loader.js', 'core/snapshot.js', 'utils/engine-client.js', 'core/quick.js'];
  assert.deepEqual(scripts.filter(script => order.includes(script)), order);
  assert.doesNotMatch(html, /<script(?![^>]*src=)/); // no inline scripts (extension CSP)
  const panelScriptList = [...source('src/html/panel.html').matchAll(/<script src="\.\.\/([^"]+)"/g)].map(m => m[1]);
  for (const shared of ['utils/formats.js', 'utils/engine-client.js']) {
    assert.ok(panelScriptList.includes(shared) && panelScriptList.indexOf(shared) < panelScriptList.indexOf('core/panel.js'), shared);
  }
  assert.doesNotMatch(source('src/core/panel.js'), /function enqueueSnapshot/);
  assert.doesNotMatch(source('src/core/quick.js'), /innerHTML/); // chapter labels and errors go in as text
});

test('popover placement: width of the buttons row (min 280), below when it fits, above when not, capped on the roomier side', () => {
  const ctx = siteUiContext();
  const place = (rect, height, vw = 1000, vh = 800) => JSON.parse(JSON.stringify(ctx.popoverPlacement(rect, height, { width: vw, height: vh })));
  assert.deepEqual(place({ left: 100, top: 200, bottom: 232, width: 260 }, 150), { left: 100, top: 238, width: 280, height: 150 });
  assert.deepEqual(place({ left: 100, top: 200, bottom: 232, width: 400 }, 150), { left: 100, top: 238, width: 400, height: 150 });
  assert.deepEqual(place({ left: 100, top: 600, bottom: 632, width: 300 }, 250), { left: 100, top: 344, width: 300, height: 250 });
  assert.deepEqual(place({ left: 100, top: 300, bottom: 332, width: 300 }, 500, 1000, 400), { left: 100, top: 8, width: 300, height: 286 });
  assert.equal(place({ left: 900, top: 100, bottom: 132, width: 400 }, 100).left, 592);
  assert.equal(place({ left: 0, top: 100, bottom: 132, width: 260 }, 100, 250).width, 234);
});

test('the settings URL can carry a section for the window to open on', () => {
  const ctx = siteUiContext();
  const url = new URL(ctx.buildPanelUrl('https://mangalib.me/ru/manga/123--title', 42, 'https://mangalib.me', 'chapters'));
  assert.equal(url.searchParams.get('section'), 'chapters');
  assert.equal(new URL(ctx.buildPanelUrl('https://mangalib.me/ru/manga/123--title', 42, 'https://mangalib.me')).searchParams.has('section'), false);
});

test('popover frame messages: close and resize (numbers only); the popover has no «Подробнее…» - the ⚙ button opens the window', () => {
  const ctx = siteUiContext();
  const log = [];
  ctx.closePopover = () => log.push('close');
  ctx.openSettings = section => log.push(['settings', section]);
  ctx.resizePopover = height => log.push(['resize', height]);
  const handlers = vm.runInContext('popoverMessageHandlers', ctx); // const: not a property of the context
  assert.equal(handlers.openPanel, undefined);
  assert.doesNotMatch(source('src/html/quick.html'), /Подробнее|id="more"/);
  assert.doesNotMatch(source('src/core/quick.js'), /openPanel|\$\('more'\)/);
  handlers.close();
  handlers.resize({ height: 180 });
  handlers.resize({ height: 'tall' });
  handlers.resize({});
  assert.deepEqual(log, ['close', ['resize', 180]]);
});

test('the «Скачать» label and accent follow the format and accent saved in storage', async () => {
  const stored = { selectedFormat_manga: 'pdf', accentColor: 'green', theme: 'dark' };
  const ctx = siteUiContext({ stored });
  const doc = fakeTitleDoc('mangalib');
  const created = [];
  const createElement = doc.createElement;
  doc.createElement = tag => { const el = createElement(tag); created.push(el); return el; };
  ctx.ensureButtons(doc, 'https://mangalib.me/ru/manga/x');
  const host = doc.grid.children[1];
  const label = created.find(el => el.tag === 'small');
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  assert.equal(label.textContent, 'PDF');
  assert.equal(host.style['--ls-accent'], '#4caf50');
  assert.equal(ctx.listeners.size, 1);

  const change = async (key, value, area = 'local') => {
    stored[key] = value;
    for (const listener of [...ctx.listeners]) listener({ [key]: { newValue: value } }, area);
    await settle();
  };
  await change('selectedFormat_manga', 'zip');
  assert.equal(label.textContent, 'ZIP');
  await change('accentColor', 'pink');
  assert.equal(host.style['--ls-accent'], '#e91e63');
  await change('selectedFormat_ranobe', 'fb2'); // another site's format: nothing to redraw
  assert.equal(label.textContent, 'ZIP');
  stored.selectedFormat_manga = 'cbz';
  await change('selectedFormat_manga', 'cbz', 'sync'); // not the local area
  assert.equal(label.textContent, 'ZIP');
});

test('a button row that left the page stops listening to storage', () => {
  const ctx = siteUiContext({ stored: {} });
  const doc = fakeTitleDoc('ranobelib');
  ctx.ensureButtons(doc, 'https://ranobelib.me/ru/book/y');
  doc.grid.children[1].isConnected = false;
  for (const listener of [...ctx.listeners]) listener({ theme: { newValue: 'light' } }, 'local');
  assert.equal(ctx.listeners.size, 0);
});

test('quick.js takes the tab and URL from whoami and refuses forged or foreign embedders', () => {
  const ctx = quickContext();
  const embedder = (me, tab) => JSON.parse(JSON.stringify(ctx.verifiedEmbedder(me, tab)));
  const title = 'https://mangalib.me/ru/manga/123--title';
  assert.deepEqual(embedder({ tabId: 5, url: title }, '5'), { tabId: 5, url: title, parentOrigin: 'https://mangalib.me' });
  assert.deepEqual(embedder({ tabId: 5, url: title }, null), { tabId: 5, url: title, parentOrigin: 'https://mangalib.me' });
  assert.equal(embedder({ tabId: 5, url: 'https://sub.ranobelib.me/ru/book/7--y' }).parentOrigin, 'https://sub.ranobelib.me');
  // forged tab, forged host (LIB name only in the query/path/lookalike domain), non-title pages, missing answers
  assert.equal(embedder({ tabId: 5, url: title }, '6'), null);
  assert.equal(embedder({ tabId: 5, url: 'https://evil.example/ru/manga/x?mangalib.me/ru/manga/x' }, '5'), null);
  assert.equal(embedder({ tabId: 5, url: 'https://mangalib.me.evil.example/ru/manga/x' }, '5'), null);
  assert.equal(embedder({ tabId: 5, url: 'https://evilmangalib.me/ru/manga/x' }, '5'), null);
  assert.equal(embedder({ tabId: 5, url: 'http://mangalib.me/ru/manga/x' }, '5'), null);
  assert.equal(embedder({ tabId: 5, url: 'https://mangalib.me/ru/catalog' }, '5'), null);
  assert.equal(embedder({ tabId: 5, url: 'chrome-extension://id/html/quick.html' }, '5'), null);
  assert.equal(embedder({ tabId: undefined, url: title }, null), null);
  assert.equal(embedder(null, null), null);
  assert.equal(embedder(undefined, '5'), null);
});

test('startQuick learns the embedder before loading anything and never reads url or parent from the address', () => {
  const text = source('src/core/quick.js');
  const start = text.slice(text.indexOf('function startQuick'));
  assert.doesNotMatch(start, /params\.get\('(url|parent)'\)/);
  assert.ok(start.indexOf("action: 'whoami'") > 0 && start.indexOf("action: 'whoami'") < start.indexOf('load(false)'));
  assert.match(start, /verifiedEmbedder\(me, params\.get\('tab'\)\)/);
});

// quick.js with a fake page: startQuick wired to fake elements, whoami answered by me
function quickPage({ me, search = '?tab=7' }) {
  const posted = [];
  const data = {};
  const loads = [];
  const elements = {};
  const element = id => elements[id] ||= (() => {
    const el = { id, classes: new Set(), handlers: {}, children: [], value: '', textContent: '', disabled: false };
    el.classList = { toggle: (name, on) => { if (on ?? !el.classes.has(name)) el.classes.add(name); else el.classes.delete(name); }, add: name => el.classes.add(name), remove: name => el.classes.delete(name) };
    el.addEventListener = (type, handler) => { el.handlers[type] = handler; };
    el.replaceChildren = (...nodes) => { el.children = nodes; };
    el.getBoundingClientRect = () => ({ height: 50 });
    return el;
  })();
  const ctx = vm.createContext({
    URL, URLSearchParams, console: { error() {}, log() {} },
    location: { search },
    window: { parent: { postMessage: (message, origin) => posted.push([message, origin]) }, applySiteAccent: () => {} },
    document: { getElementById: element, createElement: () => ({}), addEventListener() {} },
    ResizeObserver: class { observe() {} },
    loadAndApplyTheme: async () => {},
    chrome: {
      runtime: { sendMessage: async () => me },
      storage: { local: { get: async () => ({}), set: async values => Object.assign(data, values), remove: async () => {} } }
    }
  });
  vm.runInContext(['src/utils/title-store.js', 'src/utils/page-call.js', 'src/core/chapter-range.js', 'src/utils/formats.js', 'src/core/title-loader.js', 'src/core/site-download.js', 'src/core/quick.js'].map(source).join('\n'), ctx);
  // startQuick is waiting for whoami: swap the loader before it answers
  ctx.loadTitleData = async args => { loads.push(JSON.parse(JSON.stringify(args))); return { chapters: [] }; };
  return { ctx, element, data, loads, posted, settle: () => new Promise(resolve => setTimeout(resolve, 5)) };
}

test('an embedder that whoami does not vouch for gets an error without «Повторить», and nothing can load or write', async () => {
  const forged = 'https://evil.example/ru/manga/x?mangalib.me/ru/manga/x';
  const page = quickPage({ me: { tabId: 7, url: forged }, search: '?tab=7&url=' + encodeURIComponent('https://mangalib.me/ru/manga/1--a') + '&parent=https%3A%2F%2Fevil.example' });
  await page.settle();
  assert.equal(page.element('error').classes.has('hidden'), false);
  assert.match(page.element('error-text').textContent, /только на странице тайтла/);
  assert.equal(page.element('retry').classes.has('hidden'), true);
  page.element('retry').handlers.click(); // a clickjacked click on the hidden button, or a script
  await page.settle();
  assert.deepEqual(page.data, {});
  assert.deepEqual(page.loads, []);
  assert.deepEqual(page.posted, []);
});

test('a vouched embedder loads with the tab and URL from whoami, and «Повторить» reloads with force', async () => {
  const url = 'https://mangalib.me/ru/manga/1--a';
  const page = quickPage({ me: { tabId: 7, url }, search: '?tab=7&url=' + encodeURIComponent('https://evil.example/') });
  await page.settle();
  assert.deepEqual(page.loads, [{ tabId: 7, url, force: false }]);
  assert.equal(page.data.sourceUrl, url);
  assert.equal(page.element('retry').classes.has('hidden'), false); // empty title: an error that can be retried
  page.element('retry').handlers.click();
  await page.settle();
  assert.deepEqual(page.loads[1], { tabId: 7, url, force: true });
  assert.ok(page.posted.every(([, origin]) => origin === 'https://mangalib.me'));
});

test('quick.html scrolls the body inside a full-height frame and measures an inner wrapper', () => {
  const html = source('src/html/quick.html');
  assert.match(html, /html, body \{\s*height: 100%;/);
  assert.match(html, /body \{\s*overflow-y: auto;/);
  assert.equal(html.match(/\n    body \{/g).length, 1); // one body rule
  assert.match(html, /<div id="quick-content">/);
  assert.match(source('src/core/quick.js'), /observe\(content\)/);
});

// ---- Task 9: download progress on the page ----

const jsonOf = value => JSON.parse(JSON.stringify(value));
const queueEntry = (status, extra = {}) => ({ id: extra.slug || 'a', slug: 'a', siteKey: 'mangalib', title: 'Title A', format: 'cbz', status, progress: { current: 0, total: 0 }, ...extra });
const stateOf = (...items) => ({ items, stats: null, logTail: [] });

test('plaqueText: running shows the percent and the rest of the queue, waiting and paused say what is needed, nothing active gives null', () => {
  const ctx = siteUiContext();
  const text = (state, site = 'mangalib') => jsonOf(ctx.plaqueText(state, site));
  assert.deepEqual(text(stateOf(queueEntry('running', { progress: { current: 9, total: 20 } }))), { title: 'Title A', detail: '45%', percent: 45 });
  assert.deepEqual(text(stateOf(queueEntry('running', { progress: { current: 9, total: 20 } }), queueEntry('queued', { slug: 'b' }), queueEntry('queued', { slug: 'c' }))), { title: 'Title A', detail: '45% · +2 в очереди', percent: 45 });
  const withEta = { ...stateOf(queueEntry('running', { progress: { current: 9, total: 20, part: 0.5 } })), stats: { estimated: '3 мин 5 сек', etaSeconds: 185 } };
  assert.deepEqual(text(withEta), { title: 'Title A', detail: '48% · ≈3 мин 5 сек', percent: 48 }); // the page share counts, the time left is shown
  assert.equal(text({ ...withEta, stats: { estimated: 'Вычисляется...', etaSeconds: null } }).detail, '48%');
  assert.equal(text(stateOf(queueEntry('waiting-tab'))).detail, 'Откройте страницу MangaLIB, чтобы продолжить');
  assert.equal(text(stateOf(queueEntry('waiting-tab', { siteKey: 'shlib' }))).detail, 'Откройте страницу SlashLIB, чтобы продолжить');
  assert.equal(text(stateOf(queueEntry('waiting-decision', { decision: { kind: 'chapter', chapterTitle: 'Г1', message: 'x' } }))).detail, 'Нужно решение: ошибка главы');
  assert.equal(text(stateOf(queueEntry('paused'))).detail, 'Пауза');
  assert.deepEqual(text(stateOf(queueEntry('queued'), queueEntry('queued', { slug: 'b' }))), { title: 'Title A', detail: 'В очереди' });
  assert.equal(text(stateOf()), null);
  assert.equal(text(stateOf(queueEntry('done'), queueEntry('error'), queueEntry('canceled'))), null);
  assert.equal(text(null), null);
  assert.equal(text(stateOf(queueEntry('running', { progress: { current: 0, total: 0 } }))).detail, '0%'); // total unknown yet
});

test('buttonProgress: the running title of this page gets the percent, a queued one «В очереди», others nothing', () => {
  const ctx = siteUiContext();
  const progress = (state, site = 'mangalib', slug = 'a') => jsonOf(ctx.buttonProgress(state, site, slug));
  const running = queueEntry('running', { progress: { current: 1, total: 3 } });
  assert.deepEqual(progress(stateOf(running)), { kind: 'running', percent: 33 });
  assert.deepEqual(progress(stateOf(queueEntry('queued'))), { kind: 'queued' });
  assert.equal(progress(stateOf(running), 'mangalib', 'other'), null);
  assert.equal(progress(stateOf(running), 'ranobelib'), null); // the same slug on another site is another title
  assert.equal(progress(stateOf(queueEntry('paused'))), null);
  assert.equal(progress(null), null);
});

test('the button paints the percent and «В очереди» for its own title and follows the page address', () => {
  const ctx = siteUiContext();
  const doc = fakeTitleDoc('mangalib');
  doc.documentElement = new FakeEl('html');
  ctx.document = doc;
  const created = [];
  const createElement = doc.createElement;
  doc.createElement = tag => { const el = createElement(tag); created.push(el); return el; };
  ctx.ensureButtons(doc, 'https://mangalib.me/ru/manga/123--title');
  const [download] = created.filter(el => el.className === 'download');
  const fill = created.find(el => el.className === 'fill');
  const percent = created.find(el => el.className === 'percent');
  const label = created.find(el => el.tag === 'span' && !el.className);
  assert.deepEqual([download.attrs['data-state'], fill.style.width, percent.textContent, label.textContent], ['', '0%', '', 'Скачать']);

  const mine = { slug: '123--title', siteKey: 'mangalib' };
  ctx.setEngineState(stateOf(queueEntry('running', { ...mine, progress: { current: 9, total: 20 } })));
  assert.deepEqual([download.attrs['data-state'], fill.style.width, percent.textContent, label.textContent], ['running', '45%', '45%', 'Скачать']);
  ctx.setEngineState(stateOf(queueEntry('queued', mine)));
  assert.deepEqual([download.attrs['data-state'], fill.style.width, percent.textContent, label.textContent], ['queued', '0%', '', 'В очереди']);
  ctx.setEngineState(stateOf(queueEntry('running', { ...mine, progress: { current: 1, total: 2 } })));
  ctx.location.href = 'https://mangalib.me/ru/manga/999--other'; // SPA moved to another title under the same host
  ctx.paintButtons();
  assert.deepEqual([download.attrs['data-state'], fill.style.width, label.textContent], ['', '0%', 'Скачать']);
  ctx.setEngineState(null);
  assert.equal(download.attrs['data-state'], '');
});

test('plaque corner: the nearest corner to the drop point, margin 16px, the default is bottom-right', () => {
  const ctx = siteUiContext();
  const view = { width: 1000, height: 800 };
  assert.equal(ctx.snapCorner(100, 100, view), 'top-left');
  assert.equal(ctx.snapCorner(900, 100, view), 'top-right');
  assert.equal(ctx.snapCorner(100, 700, view), 'bottom-left');
  assert.equal(ctx.snapCorner(900, 700, view), 'bottom-right');
  const host = new FakeEl('div');
  ctx.applyCorner(host);
  assert.deepEqual([host.style.top, host.style.bottom, host.style.left, host.style.right], ['auto', '16px', 'auto', '16px']);
  vm.runInContext("plaqueCorner = 'top-left'", ctx);
  ctx.applyCorner(host);
  assert.deepEqual([host.style.top, host.style.bottom, host.style.left, host.style.right], ['16px', 'auto', '16px', 'auto']);
});

test('the plaque appears with the queue, shows its texts, comes back when the page drops it, and goes when nothing is left to download', () => {
  const ctx = siteUiContext();
  const doc = fakeTitleDoc('mangalib');
  doc.documentElement = new FakeEl('html');
  ctx.document = doc;
  ctx.renderPlaque(doc);
  assert.equal(doc.documentElement.children.length, 0);
  vm.runInContext('engine.state = ' + JSON.stringify(stateOf(queueEntry('running', { progress: { current: 1, total: 4 } }))), ctx);
  ctx.renderPlaque(doc);
  const first = vm.runInContext('plaque', ctx);
  assert.deepEqual([doc.documentElement.children.length, first.title.textContent, first.detail.textContent], [1, 'Title A', '25%']);
  assert.equal(first.button.attrs['aria-label'], 'Title A: 25%');
  assert.ok(first.host.attrs['data-libsaver-plaque'] === '');
  first.host.isConnected = false; // thrown out by the page
  ctx.renderPlaque(doc);
  const second = vm.runInContext('plaque', ctx);
  assert.notEqual(second, first);
  assert.equal(second.host.parentElement, doc.documentElement);
  vm.runInContext('engine.state = null', ctx);
  ctx.renderPlaque(doc);
  assert.deepEqual([vm.runInContext('plaque', ctx), second.host.parentElement], [null, null]);
});

test('the plaque corner follows storage, accepts only the four corners and only from the local area', () => {
  const ctx = siteUiContext();
  const host = new FakeEl('div');
  ctx.testHost = host;
  vm.runInContext('plaque = { host: testHost }', ctx);
  const corner = () => vm.runInContext('plaqueCorner', ctx);
  ctx.onPlaqueCornerChanged({ plaqueCorner: { newValue: 'top-left' } }, 'local');
  assert.deepEqual([corner(), host.style.top, host.style.left], ['top-left', '16px', '16px']);
  ctx.onPlaqueCornerChanged({ plaqueCorner: { newValue: 'middle' } }, 'local');
  ctx.onPlaqueCornerChanged({ plaqueCorner: { newValue: 'top-right' } }, 'sync');
  ctx.onPlaqueCornerChanged({ plaqueCorner: { newValue: undefined } }, 'local'); // nothing saved yet
  ctx.onPlaqueCornerChanged({ theme: { newValue: 'light' } }, 'local');
  assert.equal(corner(), 'top-left');
});

// Fake port and timers for connectEngine; `ensure` decides what ensureEngine answers
function engineLinkContext({ ensure = async () => true } = {}) {
  const ctx = siteUiContext();
  const doc = fakeTitleDoc('mangalib');
  doc.documentElement = new FakeEl('html');
  ctx.document = doc;
  const link = { doc, ports: [], messages: [], timers: [] };
  ctx.chrome.runtime.sendMessage = async message => { link.messages.push(message.action); return ensure(); };
  ctx.chrome.runtime.connect = options => {
    const port = { name: options.name, disconnected: false, posted: [], postMessage(message) { this.posted.push(JSON.parse(JSON.stringify(message))); }, disconnect() { this.disconnected = true; }, onMessage: { addListener: fn => { port.receive = fn; } }, onDisconnect: { addListener: fn => { port.drop = fn; } } };
    link.ports.push(port);
    return port;
  };
  ctx.setTimeout = (fn, ms) => { link.timers.push({ fn, ms }); return link.timers.length; };
  ctx.clearTimeout = () => {};
  link.intervals = []; // { fn, ms, cleared }; the id is 1000 + the index
  ctx.setInterval = (fn, ms) => 1000 + link.intervals.push({ fn, ms, cleared: false }) - 1;
  ctx.clearInterval = id => { link.intervals[id - 1000].cleared = true; };
  link.state = () => vm.runInContext('engine.state', ctx);
  link.failures = () => vm.runInContext('engine.failures', ctx);
  return { ctx, link };
}

test('the content script asks the background for the engine, takes its state from the port, and drops the state when the port drops', async () => {
  const { ctx, link } = engineLinkContext();
  await ctx.connectEngine();
  assert.deepEqual([link.messages, link.ports.map(port => port.name)], [['ensureEngine'], ['libsaver-engine']]);
  await ctx.connectEngine(); // already connected: no second port
  assert.equal(link.ports.length, 1);
  link.ports[0].receive({ type: 'log', id: 'a', line: 'x' }); // only «state» matters
  assert.equal(link.state(), null);
  link.ports[0].receive({ type: 'state', state: stateOf(queueEntry('running', { progress: { current: 1, total: 4 } })) });
  assert.equal(vm.runInContext('plaque', ctx).detail.textContent, '25%');
  link.ports[0].drop();
  assert.deepEqual([link.state(), vm.runInContext('plaque', ctx)], [null, null]);
  assert.deepEqual(link.timers.map(timer => timer.ms), [1000]); // reconnect in a second
  link.timers[0].fn();
  await settle();
  assert.equal(link.ports.length, 2);
});

test('the content script pings the engine every 20 s while a title is in work, and stops when idle, on a dropped port and on stop (R31)', async () => {
  const { ctx, link } = engineLinkContext();
  await ctx.connectEngine();
  const [port] = link.ports;
  port.receive({ type: 'state', state: stateOf(queueEntry('done')) });
  assert.equal(link.intervals.length, 0);
  port.receive({ type: 'state', state: stateOf(queueEntry('waiting-decision')) });
  port.receive({ type: 'state', state: stateOf(queueEntry('running')) });
  assert.deepEqual(link.intervals.map(timer => timer.ms), [20000]);
  link.intervals[0].fn();
  assert.deepEqual(port.posted, [{ cmd: 'ping' }]);
  port.receive({ type: 'state', state: stateOf(queueEntry('canceled')) });
  assert.equal(link.intervals[0].cleared, true);
  port.receive({ type: 'state', state: stateOf(queueEntry('queued')) });
  port.drop();
  assert.equal(link.intervals[1].cleared, true);
  link.timers[0].fn(); // reconnect
  await settle();
  link.ports[1].receive({ type: 'state', state: stateOf(queueEntry('paused')) });
  ctx.stopEngineLink();
  assert.deepEqual(link.intervals.map(timer => timer.cleared), [true, true, true]);
});

test('after five failed reconnects in a row the content script stops until the page address changes', async () => {
  const { ctx, link } = engineLinkContext({ ensure: async () => { throw new Error('no engine'); } });
  await ctx.connectEngine();
  for (let retry = 0; retry < 5; retry++) {
    assert.equal(link.timers.length, retry + 1);
    link.timers[retry].fn();
    await settle();
  }
  assert.equal(link.messages.length, 6); // the first try and five retries
  assert.equal(link.timers.length, 5); // the sixth failure schedules nothing
  ctx.retryEngine(); // the address changed
  await settle();
  assert.equal(link.messages.length, 7);
  assert.equal(link.timers.length, 6);
  const healthy = engineLinkContext(); // not exhausted: a new address changes nothing
  await healthy.ctx.connectEngine();
  healthy.ctx.retryEngine();
  assert.equal(healthy.link.messages.length, 1);
});

test('a flapping engine does not reconnect forever: the count resets only after the link stayed up 5 s', async () => {
  const { ctx, link } = engineLinkContext();
  let now = 1000;
  ctx.Date = { now: () => now };
  // up and dropped at once, six times: a state message alone does not reset the count
  for (let round = 0; round < 6; round++) {
    await ctx.connectEngine();
    if (link.ports.length === round) break; // gave up
    link.ports[round].receive({ type: 'state', state: stateOf() });
    now += 100;
    link.ports[round].drop();
    if (link.timers[round]) link.timers[round].fn();
    await settle();
  }
  assert.equal(link.ports.length, 6);
  assert.equal(link.timers.length, 5); // the sixth drop schedules nothing
  assert.equal(link.failures(), 6);
  // a link that stayed up long enough starts the count over
  ctx.retryEngine();
  await settle();
  assert.equal(link.ports.length, 7);
  now += 5000;
  link.ports[6].drop();
  assert.equal(link.failures(), 1);
  assert.equal(link.timers.length, 6);
});

test('ensureEngine answering false is a failed attempt, not a connection', async () => {
  const { ctx, link } = engineLinkContext({ ensure: async () => false });
  await ctx.connectEngine();
  assert.deepEqual([link.ports.length, link.timers.length], [0, 1]);
});

test('a content script whose extension was reloaded stops instead of reconnecting', async () => {
  const { ctx, link } = engineLinkContext();
  await ctx.connectEngine();
  ctx.stops = 0;
  vm.runInContext('stopSiteUi = () => { stops++; }', ctx);
  ctx.chrome.runtime.id = undefined; // what chrome.runtime looks like after the reload
  link.ports[0].drop();
  assert.deepEqual([ctx.stops, link.timers.length], [1, 0]); // stopped, no reconnect timer
  await ctx.connectEngine();
  assert.deepEqual([ctx.stops, link.messages.length], [2, 1]); // and no further calls into the dead runtime
});

test('stopping the engine link disconnects the port and cancels the reconnect', async () => {
  const { ctx, link } = engineLinkContext();
  await ctx.connectEngine();
  ctx.stopEngineLink();
  assert.equal(link.ports[0].disconnected, true);
  link.ports[0].drop(); // a late disconnect event
  assert.equal(link.timers.length, 0);
  await ctx.connectEngine();
  assert.equal(link.ports.length, 1);
});

test('the page check is throttled: a quiet page waits 200 ms, constant mutations still run it within a second', () => {
  const ctx = siteUiContext();
  let now = 0;
  const timers = [];
  ctx.Date = { now: () => now };
  ctx.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  ctx.clearTimeout = () => {};
  let runs = 0;
  const schedule = ctx.createScheduler(() => { runs++; });
  for (now of [0, 150, 300, 450, 600, 750, 900, 950]) schedule();
  assert.deepEqual(timers.map(timer => timer.ms), [200, 200, 200, 200, 200, 200, 100, 50]);
  timers.at(-1).fn();
  assert.equal(runs, 1);
  now = 1000;
  schedule(); // the wait starts over after a run
  assert.equal(timers.at(-1).ms, 200);
});

test('a buttons host that is no longer right after the anchor is put back (SPA re-render)', () => {
  const ctx = siteUiContext();
  const doc = fakeTitleDoc('mangalib');
  const url = 'https://mangalib.me/ru/manga/x';
  assert.equal(ctx.ensureButtons(doc, url), 'inserted');
  const host = doc.grid.children[1];
  const intruder = new FakeEl('div');
  doc.grid.children.splice(1, 0, intruder); // the site pushed something between the anchor and our host
  intruder.parentElement = doc.grid;
  assert.equal(ctx.ensureButtons(doc, url), 'moved');
  assert.deepEqual([doc.grid.children[1] === host, doc.grid.children.length, doc.querySelectorAll('[data-libsaver-buttons]').length], [true, 3, 1]);
  assert.equal(ctx.ensureButtons(doc, url), 'present');
});

test('the overlay host is recreated on the same address when the page detached it', () => {
  const ctx = siteUiContext();
  const doc = fakeTitleDoc('mangalib');
  doc.documentElement = new FakeEl('html');
  ctx.document = doc;
  const log = [];
  ctx.addEventListener = (type) => log.push(['add', type]);
  ctx.removeEventListener = (type) => log.push(['remove', type]);
  Object.assign(ctx, { setTimeout: () => 1, clearTimeout: () => {}, focus: () => {} });
  ctx.reviveOverlay(); // no overlay: nothing happens
  ctx.openOverlay('chrome-extension://id/html/downloads.html');
  const first = vm.runInContext('overlay', ctx);
  ctx.reviveOverlay(); // still attached
  assert.equal(vm.runInContext('overlay', ctx), first);
  first.host.isConnected = false;
  log.length = 0;
  ctx.reviveOverlay();
  const second = vm.runInContext('overlay', ctx);
  assert.notEqual(second, first);
  assert.equal(second.src, 'chrome-extension://id/html/downloads.html');
  assert.equal(second.host.parentElement, doc.documentElement);
  assert.deepEqual(log, [['remove', 'keydown'], ['remove', 'message'], ['add', 'keydown'], ['add', 'message']]); // the old listeners go, new ones come
  assert.deepEqual(doc.documentElement.children, [second.host]); // the detached host is not kept for a delayed removal
});

// Fake page for the overlay: listeners by type, timers run by hand, focus calls counted
function overlayContext() {
  const ctx = siteUiContext();
  const doc = fakeTitleDoc('mangalib');
  doc.documentElement = new FakeEl('html');
  ctx.document = doc;
  const page = { doc, listeners: {}, timers: new Map(), nextTimer: 1, focused: 0 };
  ctx.addEventListener = (type, fn) => { page.listeners[type] = fn; };
  ctx.removeEventListener = type => { delete page.listeners[type]; };
  ctx.setTimeout = (fn, ms) => { page.timers.set(page.nextTimer, { fn, ms }); return page.nextTimer++; };
  ctx.clearTimeout = id => page.timers.delete(id);
  ctx.focus = () => { page.focused++; };
  page.hosts = () => doc.documentElement.children;
  page.runTimers = () => { for (const [id, { fn }] of [...page.timers]) { page.timers.delete(id); fn(); } };
  return { ctx, page };
}

test('closing the overlay hides it at once and removes the host 1.5 s later, so the editors can finish saving (R29)', () => {
  const { ctx, page } = overlayContext();
  const src = 'chrome-extension://id/html/panel.html?slug=x';
  for (const close of [
    () => page.listeners.keydown({ key: 'Escape', isTrusted: true, stopPropagation() {} }), // Esc
    () => vm.runInContext('frameMessageHandlers', ctx).close() // ✕ in the window: postMessage 'close'
  ]) {
    ctx.openOverlay(src);
    const { host } = vm.runInContext('overlay', ctx);
    close();
    assert.equal(vm.runInContext('overlay', ctx), null);
    assert.deepEqual(page.hosts(), [host]); // still there: the frame lives on
    assert.deepEqual([host.style.visibility, host.style.pointerEvents, host.inert], ['hidden', 'none', true]);
    assert.equal(page.doc.documentElement.style.overflow, undefined); // the page scrolls again
    assert.deepEqual(Object.keys(page.listeners), []);
    assert.deepEqual([...page.timers.values()].map(timer => timer.ms), [1500]);
    page.runTimers();
    assert.deepEqual(page.hosts(), []);
  }
  assert.equal(page.focused, 2); // focus goes back to the page each time
});

test('reopening within 1.5 s reuses the closing window on the same address; on another address the old one lives out its delay', () => {
  const { ctx, page } = overlayContext();
  const src = 'chrome-extension://id/html/panel.html?slug=x';
  ctx.openOverlay(src);
  const { host } = vm.runInContext('overlay', ctx);
  ctx.closeOverlay();
  ctx.openOverlay(src);
  const reopened = vm.runInContext('overlay', ctx);
  assert.equal(reopened.host, host); // same frame, with its unsaved state
  assert.deepEqual([host.style.visibility, host.style.pointerEvents, host.inert], ['', '', false]);
  assert.equal(page.timers.size, 0); // the delayed removal is canceled
  assert.deepEqual(page.hosts(), [host]);
  assert.ok(page.listeners.keydown && page.listeners.message);
  // ✕ in the reused window: its message is checked against the same frame (it used to throw on frame.contentWindow)
  reopened.frame.contentWindow = {};
  page.listeners.message({ source: reopened.frame.contentWindow, origin: 'chrome-extension://id', data: { libsaver: true, type: 'close' } });
  assert.equal(vm.runInContext('overlay', ctx), null);
  ctx.openOverlay(src);

  ctx.closeOverlay();
  ctx.openOverlay(src + '&section=downloads');
  const other = vm.runInContext('overlay', ctx);
  assert.notEqual(other.host, host);
  assert.deepEqual(page.hosts(), [host, other.host]); // the hidden old frame finishes its autosave
  assert.equal(host.style.visibility, 'hidden');
  assert.equal(page.timers.size, 1);
  page.runTimers();
  assert.deepEqual(page.hosts(), [other.host]);

  ctx.closeOverlay(); // two closes in a row: each hidden frame keeps its own delay
  ctx.openOverlay(src);
  ctx.closeOverlay();
  assert.equal(page.hosts().length, 2);
  assert.equal(page.timers.size, 2);
  page.runTimers();
  assert.deepEqual(page.hosts(), []);
});

test('stopSiteUi removes a closing overlay at once', () => {
  const { ctx, page } = overlayContext();
  ctx.MutationObserver = class { observe() {} disconnect() {} };
  page.doc.body = new FakeEl('body');
  ctx.location.href = 'https://example.com/'; // not a LIB site: no engine link, just the page watcher
  ctx.startSiteUi();
  ctx.openOverlay('chrome-extension://id/html/panel.html');
  ctx.closeOverlay();
  assert.equal(page.hosts().length, 1);
  vm.runInContext('stopSiteUi()', ctx);
  assert.deepEqual(page.hosts(), []);
  assert.equal(page.timers.size, 0);
});

test('an open «Скачать» popover closes when the page moves to another title and stays on the same one', () => {
  const ctx = siteUiContext();
  ctx.removedCount = 0;
  vm.runInContext("popover = { host: { remove() { removedCount++; } }, slug: '123--title', listeners: [] }", ctx);
  ctx.closePopoverOnTitleChange('https://mangalib.me/ru/manga/123--title?section=info#top');
  assert.notEqual(vm.runInContext('popover', ctx), null);
  ctx.closePopoverOnTitleChange('https://mangalib.me/ru/manga/456--other');
  assert.deepEqual([vm.runInContext('popover', ctx), ctx.removedCount], [null, 1]);
  ctx.closePopoverOnTitleChange('https://mangalib.me/ru/manga/456--other'); // nothing open: no error
});

test('the plaque click opens the settings window on the downloads section', async () => {
  const ctx = siteUiContext();
  const opened = [];
  ctx.openOverlay = src => opened.push(src);
  ctx.chrome.runtime.sendMessage = async () => ({ tabId: 42, url: 'https://mangalib.me/ru/manga/123--title' });
  ctx.openDownloads();
  await settle();
  assert.equal(opened.length, 1);
  const url = new URL(opened[0]);
  assert.equal(url.href.split('?')[0], 'chrome-extension://id/html/panel.html');
  assert.deepEqual([url.searchParams.get('section'), url.searchParams.get('tab')], ['downloads', '42']);
});

test('the site name map lives in page-call.js and the downloads view no longer carries its own copy', () => {
  assert.match(source('src/utils/page-call.js'), /const SITE_NAMES = /);
  assert.doesNotMatch(source('src/core/downloads-view.js'), /const SITE_NAMES/);
});

// ---- Task 9, round 1: plaque pointer path and teardown ----

// Fake pointer events through the real listeners of createPlaque; window listeners are kept per type
function plaqueDragContext() {
  const { ctx, link } = engineLinkContext();
  const { doc } = link;
  doc.documentElement.clientWidth = 1000;
  doc.documentElement.clientHeight = 800;
  const windowHandlers = {};
  ctx.addEventListener = (type, fn) => { (windowHandlers[type] ||= new Set()).add(fn); };
  ctx.removeEventListener = (type, fn) => { windowHandlers[type]?.delete(fn); };
  const handlers = new Map(); // element -> { type: fn }
  const createElement = doc.createElement;
  doc.createElement = tag => {
    const el = createElement(tag);
    el.addEventListener = (type, fn) => { handlers.set(el, { ...handlers.get(el), [type]: fn }); };
    return el;
  };
  const saved = [];
  ctx.chrome.storage.local.set = async values => { saved.push(values); };
  const opened = [];
  ctx.openSettings = section => opened.push(section); // the plaque asks for the settings window on its section
  vm.runInContext('engine.state = ' + JSON.stringify(stateOf(queueEntry('running', { progress: { current: 1, total: 4 } }))), ctx);
  ctx.renderPlaque(doc);
  const { button, host } = vm.runInContext('plaque', ctx);
  host.getBoundingClientRect = () => ({ left: 900, top: 700 });
  const captured = [];
  button.setPointerCapture = id => captured.push(id);
  const event = (type, x, y, extra = {}) => ({ type, clientX: x, clientY: y, isTrusted: true, button: 0, pointerId: 7, pointerType: 'mouse', preventDefault() { this.prevented = true; }, ...extra });
  const fire = e => { for (const fn of [...(windowHandlers[e.type] || [])]) fn(e); };
  const click = (extra = {}) => handlers.get(button).click({ isTrusted: true, ...extra });
  const down = e => handlers.get(button).pointerdown(e);
  const listenerCount = () => Object.values(windowHandlers).reduce((sum, set) => sum + set.size, 0);
  return { ctx, link, host, opened, saved, captured, event, fire, click, down, listenerCount, corner: () => vm.runInContext('plaqueCorner', ctx) };
}

test('plaque: a press with a move under 5px is a click that opens the downloads section', () => {
  const t = plaqueDragContext();
  const press = t.event('pointerdown', 950, 750);
  t.down(press);
  assert.equal(press.prevented, true); // the mouse does not select page text
  assert.equal(t.listenerCount(), 3);
  t.fire(t.event('pointermove', 952, 751));
  t.fire(t.event('pointerup', 952, 751));
  assert.equal(t.listenerCount(), 0);
  t.click();
  assert.deepEqual([t.opened, t.saved, t.captured, t.corner()], [['downloads'], [], [], 'bottom-right']);
  t.click({ isTrusted: false }); // a script click does nothing
  assert.equal(t.opened.length, 1);
});

test('plaque: a drag over 5px captures the pointer, snaps to the nearest corner, saves it, and the click after it opens nothing', () => {
  const t = plaqueDragContext();
  t.down(t.event('pointerdown', 950, 750));
  t.fire(t.event('pointermove', 940, 740));
  assert.deepEqual(t.captured, [7]);
  assert.deepEqual([t.host.style.left, t.host.style.top, t.host.style.right, t.host.style.bottom], ['890px', '690px', 'auto', 'auto']);
  t.fire(t.event('pointermove', 120, 90));
  t.fire(t.event('pointerup', 120, 90));
  assert.deepEqual([t.corner(), jsonOf(t.saved), t.listenerCount()], ['top-left', [{ plaqueCorner: 'top-left' }], 0]);
  assert.deepEqual([t.host.style.top, t.host.style.left, t.host.style.bottom, t.host.style.right], ['16px', '16px', 'auto', 'auto']);
  t.click(); // the click the browser sends after the release
  assert.equal(t.opened.length, 0);
  // an activation that comes after the release's own click (the keyboard) must not be swallowed
  t.down(t.event('pointerdown', 20, 20));
  t.fire(t.event('pointermove', 400, 20));
  t.fire(t.event('pointerup', 400, 20));
  const reset = t.link.timers.at(-1);
  assert.equal(reset.ms, 0);
  reset.fn();
  t.click();
  assert.equal(t.opened.length, 1);
});

test('plaque: a cancelled drag puts the plaque back in its corner without saving and cleans up', () => {
  const t = plaqueDragContext();
  t.down(t.event('pointerdown', 950, 750));
  t.fire(t.event('pointermove', 300, 300));
  assert.equal(t.host.style.right, 'auto');
  t.fire(t.event('pointercancel', 300, 300));
  assert.deepEqual([t.corner(), t.saved, t.listenerCount()], ['bottom-right', [], 0]);
  assert.deepEqual([t.host.style.right, t.host.style.bottom, t.host.style.left, t.host.style.top], ['16px', '16px', 'auto', 'auto']);
  const other = t.event('pointerdown', 950, 750, { button: 2 }); // not the main button
  t.down(other);
  assert.equal(t.listenerCount(), 0);
});

test('stopSiteUi takes everything down: observer, resize and storage listeners, plaque, buttons, scheduler and the engine port', async () => {
  const { ctx, link } = engineLinkContext();
  const { doc } = link;
  doc.body = new FakeEl('body');
  doc.documentElement = doc; // the fake document is its own root, so the plaque lands next to the title grid
  const observers = [];
  ctx.MutationObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
  };
  const windowListeners = new Set();
  ctx.addEventListener = (type, fn) => windowListeners.add(`${type}`);
  ctx.removeEventListener = (type, fn) => windowListeners.delete(`${type}`);
  const cleared = [];
  ctx.clearTimeout = id => cleared.push(id);
  ctx.startSiteUi();
  await settle();
  const [observer] = observers;
  assert.deepEqual([observers.length, observer.target === doc, observer.options.subtree], [1, true, true]);
  assert.ok(windowListeners.has('resize'));
  assert.ok(ctx.listeners.has(ctx.onPlaqueCornerChanged));
  assert.ok(ctx.messageListeners.has(ctx.onRuntimeMessage)); // the popup request reaches the page
  assert.equal(doc.querySelectorAll('[data-libsaver-buttons]').length, 1);
  link.ports[0].receive({ type: 'state', state: stateOf(queueEntry('running', { progress: { current: 1, total: 4 } })) });
  assert.notEqual(vm.runInContext('plaque', ctx), null);
  observer.callback(); // a mutation: the check is scheduled
  const pending = link.timers.length; // the scheduler's timer id is its 1-based index
  vm.runInContext('stopSiteUi()', ctx);

  assert.equal(observer.disconnected, true);
  assert.equal(windowListeners.has('resize'), false);
  assert.equal(ctx.listeners.has(ctx.onPlaqueCornerChanged), false);
  assert.equal(ctx.messageListeners.has(ctx.onRuntimeMessage), false);
  assert.equal(doc.querySelectorAll('[data-libsaver-buttons]').length, 0);
  assert.equal(vm.runInContext('plaque', ctx), null);
  assert.ok(cleared.includes(pending)); // the scheduled check is canceled
  assert.equal(link.ports[0].disconnected, true);
  assert.equal(vm.runInContext('engine.stopped', ctx), true);
  vm.runInContext('stopSiteUi()', ctx); // a second call is harmless
});

// ---- Task 10: the settings window (panel.html) ----

const panelScripts = ['src/utils/title-store.js', 'src/utils/page-call.js', 'src/core/chapter-range.js', 'src/utils/formats.js', 'src/core/title-loader.js', 'src/core/site-download.js', 'src/core/panel.js'];
const jsonCopy = value => JSON.parse(JSON.stringify(value));

function panelLogic() {
  const ctx = vm.createContext({ URL, URLSearchParams, console });
  vm.runInContext(['src/core/chapter-range.js', 'src/core/panel.js'].map(source).join('\n'), ctx);
  return ctx;
}

test('the section list is fixed: «Форматы» holds the settings of every format whatever format is picked, «Загрузки» last', () => {
  const ctx = panelLogic();
  const sections = ctx.PANEL_SECTIONS();
  const urls = Object.fromEntries(Array.from(sections, section => [section.id, section.url]));
  assert.deepEqual(urls, { chapters: 'chapters.html', metadata: 'metadata.html', covers: 'covers.html', images: 'settings.html?group=images', toc: 'settings.html?group=toc', formats: 'settings.html?group=formats', general: 'settings.html?group=general', about: 'settings.html?group=about', downloads: 'downloads.html' });
  assert.deepEqual(jsonCopy(sections.find(section => section.id === 'formats')), { id: 'formats', group: 'build', title: 'Форматы', url: 'settings.html?group=formats' });
  assert.equal(sections.at(-1).group, null);
});

test('every section frame gets the title slug, after ? or &, and none when there is no title', () => {
  const ctx = panelLogic();
  assert.equal(ctx.panelFrameSrc({ url: 'chapters.html' }, '123--title'), 'chapters.html?slug=123--title');
  assert.equal(ctx.panelFrameSrc({ url: 'settings.html?group=toc' }, '123--title'), 'settings.html?group=toc&slug=123--title');
  assert.equal(ctx.panelFrameSrc({ url: 'chapters.html' }, 'a b&c'), 'chapters.html?slug=a%20b%26c');
  assert.equal(ctx.panelFrameSrc({ url: 'downloads.html' }, ''), 'downloads.html');
});

test('phone subtitles: chapters, fields, covers, image quality, TOC format and the format name', () => {
  const ctx = panelLogic();
  const counts = { selected: 24, total: 109, fields: 12, covers: 3 };
  assert.equal(ctx.sectionSubtitle('chapters', {}, { selected: 24, total: 109 }), '24 из 109');
  assert.equal(ctx.sectionSubtitle('metadata', {}, counts), '12 полей');
  assert.equal(ctx.sectionSubtitle('metadata', {}, { fields: 1 }), '1 поле');
  assert.equal(ctx.sectionSubtitle('metadata', {}, { fields: 3 }), '3 поля');
  assert.equal(ctx.sectionSubtitle('metadata', {}, { fields: 21 }), '21 поле');
  assert.equal(ctx.sectionSubtitle('covers', {}, counts), '3');
  assert.equal(ctx.sectionSubtitle('images', {}, counts), 'Без сжатия');
  assert.equal(ctx.sectionSubtitle('images', { imageQuality: 'FHD' }, counts), '1080px');
  assert.equal(ctx.sectionSubtitle('toc', {}, counts), 'Том X. Глава Y. Название');
  assert.equal(ctx.sectionSubtitle('toc', { tocFormat: 'no_headers' }, counts), 'Без заголовков');
  assert.equal(ctx.sectionSubtitle('formats', { format: 'cbz' }, counts), 'CBZ');
  for (const id of ['general', 'about', 'downloads']) assert.equal(ctx.sectionSubtitle(id, {}, counts), '', id);
  assert.equal(ctx.sectionSubtitle('images', { imageQuality: 'bogus' }, counts), '');
});

test('selected chapters: the chapters section wins, then the range, then all; branch duplicates count once', () => {
  const ctx = panelLogic();
  const chapters = [{ id: 1 }, { id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(Array.from(ctx.selectedIds({ chapters, filteredChapters: [{ id: 2 }], selectedChapterIds: [3, 1] })), [3, 1]);
  assert.deepEqual(Array.from(ctx.selectedIds({ chapters, filteredChapters: [{ id: 2 }, { id: 2 }, { id: 3 }] })), [2, 3]);
  assert.deepEqual(Array.from(ctx.selectedIds({ chapters })), [1, 2, 3]);
  assert.deepEqual(Array.from(ctx.selectedIds({ chapters, selectedChapterIds: [] })), []);
  assert.deepEqual(Array.from(ctx.selectedIds(undefined)), []);
  assert.deepEqual(jsonCopy(ctx.panelCounts({ chapters, filteredChapters: [{ id: 2 }], covers: [{}, {}] }, { a: true, b: false, c: true })), { selected: 1, total: 3, fields: 2, covers: 2 });
  assert.deepEqual(jsonCopy(ctx.panelCounts(undefined, undefined)), { selected: 0, total: 0, fields: 15, covers: 0 });
});

test('verifiedEmbedder can accept any page of a LIB site when the title page is not required', () => {
  const ctx = quickContext();
  const catalog = { tabId: 5, url: 'https://mangalib.me/ru/catalog' };
  assert.equal(ctx.verifiedEmbedder(catalog, '5'), null);
  assert.deepEqual(jsonCopy(ctx.verifiedEmbedder(catalog, '5', { requireTitle: false })), { tabId: 5, url: catalog.url, parentOrigin: 'https://mangalib.me' });
  assert.equal(ctx.verifiedEmbedder(catalog, '6', { requireTitle: false }), null);
  assert.equal(ctx.verifiedEmbedder({ tabId: 5, url: 'https://mangalib.me.evil.example/' }, '5', { requireTitle: false }), null);
  assert.equal(ctx.verifiedEmbedder({ tabId: 5, url: 'http://mangalib.me/' }, '5', { requireTitle: false }), null);
  assert.equal(ctx.verifiedEmbedder(null, null, { requireTitle: false }), null);
});

// panel.js on a fake page: elements by id, whoami answered by `me`, storage with change events, a fake queue port
class PanelEl {
  constructor(tag = 'div') {
    Object.assign(this, { tag, children: [], classes: new Set(), handlers: {}, attrs: {}, dataset: {}, textContent: '', className: '', value: '', checked: false, disabled: false });
    this.classList = { toggle: (name, on) => { if (on ?? !this.classes.has(name)) this.classes.add(name); else this.classes.delete(name); }, add: name => this.classes.add(name), remove: name => this.classes.delete(name) };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attrs[name] = value; }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  fire(type, event = {}) { for (const handler of this.handlers[type] || []) handler(event); }
  has(name) { return this.classes.has(name) || this.className.split(' ').includes(name); }
}

const panelChapters = Array.from({ length: 109 }, (_, index) => ({ id: index + 1, volume: '1', number: String(index + 1), name: '' }));
const panelTitleData = (extra = {}) => ({ chapters: panelChapters, metadata: { titleRu: 'Морино' }, covers: [{}, {}, {}], filteredChapters: panelChapters.slice(0, 24), ...extra });
const panelUrl = 'https://mangalib.me/ru/manga/123--title';

function panelPage({ me, search = '?tab=7', ancestorOrigins, width = 1000, stored = {}, title = panelTitleData(), enqueueResult = { ok: true } }) {
  const data = { 'titleData:123--title': title, ...structuredClone(stored) };
  const calls = { loads: [], snapshots: [], enqueues: [], posted: [], writes: [], messages: [] };
  const elements = {};
  const element = id => elements[id] ||= new PanelEl(id);
  const storageListeners = [];
  const windowHandlers = {};
  const documentHandlers = {};
  const port = { posted: [], postMessage: message => port.posted.push(jsonCopy(message)), onMessage: { addListener: fn => { port.receive = fn; } }, onDisconnect: { addListener: fn => { port.drop = fn; } } };
  const ctx = vm.createContext({
    URL, URLSearchParams, console: { error() {}, log() {} },
    location: { search, protocol: 'chrome-extension:', ancestorOrigins },
    window: {
      innerWidth: width,
      parent: { postMessage: (message, origin) => calls.posted.push([message, origin]) },
      applySiteAccent: () => {},
      addEventListener: (type, fn) => { (windowHandlers[type] ||= []).push(fn); }
    },
    document: { getElementById: element, createElement: tag => new PanelEl(tag), body: new PanelEl('body'), addEventListener: (type, fn) => { (documentHandlers[type] ||= []).push(fn); } },
    loadAndApplyTheme: async () => {},
    setupThemeMessageListener() {},
    showToast() {},
    buildDownloadSnapshot: async args => { calls.snapshots.push(structuredClone(args)); return { id: 'snap' }; },
    enqueueSnapshot: async snapshot => { calls.enqueues.push(snapshot); return enqueueResult; },
    chrome: {
      runtime: {
        sendMessage: async message => { calls.messages.push(message.action); return message.action === 'whoami' ? me : true; },
        connect: () => port,
        onMessage: { addListener() {} }
      },
      storage: {
        local: {
          get: async keys => structuredClone(Object.fromEntries((keys === null ? Object.keys(data) : [].concat(keys)).filter(key => key in data).map(key => [key, data[key]]))),
          set: async values => {
            calls.writes.push(Object.keys(values));
            Object.assign(data, structuredClone(values));
            for (const listener of storageListeners) listener(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { newValue: value }])), 'local');
          },
          remove: async () => {}
        },
        onChanged: { addListener: fn => storageListeners.push(fn) }
      }
    }
  });
  vm.runInContext(panelScripts.map(source).join('\n'), ctx);
  // startPanel is waiting for whoami: swap the loader before it answers
  ctx.loadTitleData = async args => {
    calls.loads.push(jsonCopy(args));
    args.onProgress?.(3);
    return { slug: '123--title', siteKey: 'mangalib', siteType: 'manga', title: 'Морино (из API)', chapters: panelChapters, allChapters: panelChapters, covers: [] };
  };
  const page = {
    ctx, data, calls, element, port,
    body: ctx.document.body,
    frames: () => element('frames').children.map(frame => ({ src: frame.src, active: frame.classes.has('active') })),
    menu: () => element('menu').children.filter(node => node.tag === 'button').map(button => ({ title: button.children[0].textContent, note: button.children[1].textContent, on: button.has('on'), button })),
    item: title => page.menu().find(entry => entry.title === title).button,
    resize: newWidth => { ctx.window.innerWidth = newWidth; for (const fn of windowHandlers.resize) fn(); },
    key: event => { for (const fn of documentHandlers.keydown) fn(event); },
    settle
  };
  return page;
}

test('panel.js refuses an embedder that whoami does not vouch for: an error, no storage write, no load, no message to the page', async () => {
  const forged = 'https://evil.example/ru/manga/x?mangalib.me/ru/manga/x';
  for (const me of [{ tabId: 7, url: forged }, { tabId: 7, url: 'https://mangalib.me.evil.example/ru/manga/x' }, { tabId: 8, url: panelUrl }, null]) {
    const page = panelPage({ me, search: '?tab=7&url=' + encodeURIComponent(panelUrl) + '&parent=https%3A%2F%2Fevil.example&section=downloads' });
    const before = jsonCopy(page.data);
    await page.settle();
    assert.equal(page.element('error').has('hidden'), false);
    assert.match(page.element('error-text').textContent, /только на страницах/);
    assert.equal(page.element('retry').has('hidden'), true);
    assert.equal(page.element('main').has('hidden'), true);
    page.element('retry').fire('click'); // a clickjacked click on the hidden button, or a script
    page.element('download').fire('click');
    page.element('format').fire('change');
    page.element('close').fire('click');
    page.key({ key: 'Escape' });
    await page.settle();
    assert.deepEqual(page.data, before);
    assert.deepEqual([page.calls.writes, page.calls.loads, page.calls.snapshots, page.calls.enqueues, page.calls.posted], [[], [], [], [], []]);
    assert.deepEqual(page.element('frames').children, []);
    assert.deepEqual(page.calls.messages, ['whoami']); // not even the engine is woken
  }
});

test('on a page of the site that is not a title only «Загрузки» opens: no title is loaded and nothing is written', async () => {
  const page = panelPage({ me: { tabId: 7, url: 'https://mangalib.me/ru/catalog' }, search: '?tab=7&slug=&section=chapters' });
  await page.settle();
  assert.deepEqual([page.calls.writes, page.calls.loads, page.calls.snapshots], [[], [], []]);
  assert.deepEqual(page.frames(), [{ src: 'downloads.html', active: true }]); // the forged ?section= is ignored: only downloads exist
  assert.equal(page.body.classes.has('single'), true);
  assert.equal(page.element('foot').has('hidden'), true);
  assert.equal(page.element('title').textContent, 'Загрузки');
  page.element('close').fire('click');
  assert.deepEqual(jsonCopy(page.calls.posted), [[{ libsaver: true, type: 'close' }, 'https://mangalib.me']]);
  page.element('download').fire('click');
  page.element('retry').fire('click');
  await page.settle();
  assert.deepEqual([page.calls.writes, page.calls.loads, page.calls.snapshots, page.calls.enqueues], [[], [], [], []]);
});

test('opened on «Загрузки» from a title page, the window shows them at once and loads the title behind them; a failed load keeps them (R33)', async () => {
  const page = panelPage({ me: { tabId: 7, url: panelUrl }, search: '?tab=7&section=downloads' });
  let finish;
  const realLoad = page.ctx.loadTitleData;
  page.ctx.loadTitleData = args => new Promise(resolve => { finish = () => resolve(realLoad(args)); });
  await page.settle();
  assert.deepEqual(page.frames(), [{ src: 'downloads.html', active: true }]); // before the title has loaded
  assert.equal(page.element('main').has('hidden'), false);
  assert.equal(page.element('loading').has('hidden'), true);
  assert.equal(page.element('foot').has('hidden'), true);
  assert.deepEqual(page.menu().map(entry => entry.title), ['Загрузки']);
  finish();
  await page.settle();
  assert.equal(page.body.classes.has('single'), false);
  assert.equal(page.element('foot').has('hidden'), false);
  assert.deepEqual(page.menu().filter(entry => entry.on).map(entry => entry.title), ['Загрузки']);
  assert.equal(page.menu().length, 9); // the other sections are there now
  assert.equal(page.frames().filter(frame => frame.active).length, 1);

  const failing = panelPage({ me: { tabId: 7, url: panelUrl }, search: '?tab=7&section=downloads' });
  failing.ctx.loadTitleData = async () => { throw Object.assign(new Error('load-failed'), { code: 'load-failed' }); };
  await failing.settle();
  assert.equal(failing.element('error').has('hidden'), true);
  assert.equal(failing.element('main').has('hidden'), false);
  assert.deepEqual(failing.frames(), [{ src: 'downloads.html', active: true }]);
});

test('a vouched title page loads with the tab and URL from whoami, writes siteType and sourceUrl first, and opens on «Главы»', async () => {
  const page = panelPage({ me: { tabId: 7, url: panelUrl }, search: '?tab=7&url=' + encodeURIComponent('https://evil.example/') + '&parent=https%3A%2F%2Fevil.example' });
  await page.settle();
  assert.deepEqual(page.calls.loads, [{ tabId: 7, url: panelUrl, force: false }]);
  assert.deepEqual([page.data.siteType, page.data.sourceUrl], ['manga', panelUrl]);
  assert.deepEqual(page.frames(), [{ src: 'chapters.html?slug=123--title', active: true }]); // other sections are not created until opened
  assert.equal(page.element('loading-progress').value, 3); // the loader's three parts move the loading bar
  assert.equal(page.element('title').textContent, 'Морино');
  const entries = page.menu().map(entry => [entry.title, entry.note, entry.on]);
  assert.deepEqual(entries, [['Главы', '24', true], ['Метаданные', '15', false], ['Обложки', '3', false], ['Картинки', '', false], ['Оглавление', '', false], ['Форматы', '', false], ['Общие', '', false], ['О LibSaver', '', false], ['Загрузки', '', false]]);
  assert.equal(page.element('download').textContent, 'Скачать 24 главы');
  assert.equal(page.element('download').disabled, false);
  assert.equal(page.element('format').value, 'cbz');
  assert.deepEqual(page.element('format').children.map(option => option.value), ['cbz', 'zip', 'pdf', 'epub', 'html']);
  assert.equal(page.element('foot').has('hidden'), false);
  assert.deepEqual(page.calls.messages, ['whoami', 'ensureEngine']);
});

test('sections open lazily, keep their frame, and a section named in the address opens first (unknown names do not)', async () => {
  const page = panelPage({ me: { tabId: 7, url: panelUrl }, search: '?tab=7&section=toc' });
  await page.settle();
  assert.deepEqual(page.frames(), [{ src: 'settings.html?group=toc&slug=123--title', active: true }]);
  page.item('Метаданные').fire('click');
  assert.deepEqual(page.frames(), [{ src: 'settings.html?group=toc&slug=123--title', active: false }, { src: 'metadata.html?slug=123--title', active: true }]);
  page.item('Оглавление').fire('click');
  assert.deepEqual(page.frames().map(frame => frame.active), [true, false]); // the toc frame is kept, not recreated
  assert.deepEqual(page.menu().filter(entry => entry.on).map(entry => entry.title), ['Оглавление']);

  const bogus = panelPage({ me: { tabId: 7, url: panelUrl }, search: '?tab=7&section=evil' });
  await bogus.settle();
  assert.equal(bogus.frames()[0].src, 'chapters.html?slug=123--title');
});

test('the format select is the stored format; changing it keeps «Форматы» and its frame', async () => {
  const page = panelPage({ me: { tabId: 7, url: panelUrl }, search: '?tab=7&section=formats', stored: { selectedFormat_manga: 'pdf' } });
  await page.settle();
  assert.equal(page.element('format').value, 'pdf');
  assert.deepEqual(page.frames(), [{ src: 'settings.html?group=formats&slug=123--title', active: true }]);
  for (const format of ['cbz', 'epub']) {
    page.element('format').value = format;
    page.element('format').fire('change');
    await page.settle();
    assert.equal(page.data.selectedFormat_manga, format);
    assert.deepEqual(page.menu().filter(entry => entry.on).map(entry => entry.title), ['Форматы']);
    assert.deepEqual(page.frames(), [{ src: 'settings.html?group=formats&slug=123--title', active: true }]); // the frame is not reloaded
  }
});

test('«Скачать N глав» queues the selected chapters, leaves «Ускорить» to the snapshot, then opens «Загрузки»', async () => {
  const page = panelPage({ me: { tabId: 7, url: panelUrl }, stored: { imageServer: 'normal' } });
  await page.settle();
  page.element('download').fire('click');
  await page.settle();
  const [args] = page.calls.snapshots;
  assert.deepEqual(args.selectedChapterIds, panelChapters.slice(0, 24).map(chapter => chapter.id));
  assert.deepEqual({ ...args, selectedChapterIds: null }, { slug: '123--title', tabId: 7, sourceUrl: panelUrl, selectedChapterIds: null, format: 'cbz', imageServer: 'normal', textOnly: false });
  assert.equal('speedMode' in args, false);
  assert.deepEqual(page.calls.enqueues, [{ id: 'snap' }]);
  assert.deepEqual(page.frames().at(-1), { src: 'downloads.html?slug=123--title', active: true });
  assert.equal(page.element('download').disabled, false);
});

test('the chapters section’s selection beats the range, and an empty selection disables the button', async () => {
  const page = panelPage({ me: { tabId: 7, url: panelUrl }, title: panelTitleData({ selectedChapterIds: [5, 6, 7] }) });
  await page.settle();
  assert.equal(page.element('download').textContent, 'Скачать 3 главы');
  page.element('download').fire('click');
  await page.settle();
  assert.deepEqual(page.calls.snapshots[0].selectedChapterIds, [5, 6, 7]);

  const none = panelPage({ me: { tabId: 7, url: panelUrl }, title: panelTitleData({ selectedChapterIds: [] }) });
  await none.settle();
  assert.equal(none.element('download').textContent, 'Скачать');
  assert.equal(none.element('download').disabled, true);
});

test('a refusal from the queue shows its message and stays on the section', async () => {
  const page = panelPage({ me: { tabId: 7, url: panelUrl }, enqueueResult: { ok: false, reason: 'already-queued' } });
  await page.settle();
  page.element('download').fire('click');
  await page.settle();
  assert.equal(page.element('status').textContent, 'Этот тайтл уже в очереди');
  assert.equal(page.frames().length, 1);
  assert.equal(page.element('download').disabled, false);
});

test('a failure while queueing shows the error and gives the button back', async () => {
  const page = panelPage({ me: { tabId: 7, url: panelUrl } });
  await page.settle();
  page.ctx.enqueueSnapshot = async () => { throw new Error('Движок загрузки недоступен'); };
  page.element('download').fire('click');
  await page.settle();
  assert.equal(page.element('status').textContent, 'Не удалось начать загрузку: Движок загрузки недоступен');
  assert.equal(page.element('download').disabled, false);
  assert.equal(page.element('download').textContent, 'Скачать 24 главы'); // the selection is untouched
  assert.equal(page.frames().length, 1);
});

test('counters follow storage; the only «Ускорить» lives in «Загрузки»', async () => {
  const page = panelPage({ me: { tabId: 7, url: panelUrl }, stored: { metadataFields: { a: true, b: true, c: false } } });
  await page.settle();
  assert.equal(page.menu()[1].note, '2');
  await page.ctx.chrome.storage.local.set({ metadataFields: { a: true } });
  await page.ctx.chrome.storage.local.set({ 'titleData:123--title': panelTitleData({ selectedChapterIds: [1, 2], covers: [{}] }) });
  await page.settle();
  assert.deepEqual(page.menu().slice(0, 3).map(entry => entry.note), ['2', '1', '1']);
  assert.equal(page.element('download').textContent, 'Скачать 2 главы');
  assert.doesNotMatch(source('src/html/panel.html'), /id="speed"/);
  assert.doesNotMatch(source('src/core/panel.js'), /speedMode/);
});

test('the «Загрузки» counter is the number of titles in work in the queue state', async () => {
  const page = panelPage({ me: { tabId: 7, url: panelUrl } });
  await page.settle();
  const state = statuses => ({ type: 'state', state: { items: statuses.map(status => ({ status })) } });
  page.port.receive(state(['running', 'queued', 'done', 'error', 'waiting-tab']));
  assert.equal(page.menu().at(-1).note, '3');
  page.port.receive({ type: 'log' }); // only «state» matters
  assert.equal(page.menu().at(-1).note, '3');
  page.port.drop();
  assert.equal(page.menu().at(-1).note, '');
});

test('on a phone the window opens on the list of sections with subtitles, a tap opens one section full-screen, back returns to the list', async () => {
  const page = panelPage({ me: { tabId: 7, url: panelUrl }, width: 375, stored: { imageQuality: 'FHD' } });
  await page.settle();
  assert.equal(page.body.classes.has('phone'), true);
  assert.equal(page.body.classes.has('in-section'), false);
  assert.deepEqual(page.frames(), []); // no frame until a section is opened
  assert.equal(page.element('back').has('hidden'), true);
  assert.deepEqual(page.menu().map(entry => entry.note), ['24 из 109', '15 полей', '3', '1080px', 'Том X. Глава Y. Название', 'CBZ', '', '', '']);
  assert.equal(page.menu().some(entry => entry.on), false);
  assert.equal(page.element('foot').has('hidden'), false); // the footer stays pinned

  page.item('Картинки').fire('click');
  assert.equal(page.body.classes.has('in-section'), true);
  assert.equal(page.element('back').has('hidden'), false);
  assert.equal(page.element('title').textContent, 'Картинки');
  assert.deepEqual(page.frames(), [{ src: 'settings.html?group=images&slug=123--title', active: true }]);
  page.element('back').fire('click');
  assert.equal(page.body.classes.has('in-section'), false);
  assert.equal(page.element('title').textContent, 'Морино');
  assert.equal(page.element('back').has('hidden'), true);
  assert.equal(page.frames().length, 1); // kept alive
});

test('the phone layout is re-evaluated on resize', async () => {
  const page = panelPage({ me: { tabId: 7, url: panelUrl }, width: 375 });
  await page.settle();
  page.resize(1000);
  assert.equal(page.body.classes.has('phone'), false);
  assert.deepEqual(page.frames(), [{ src: 'chapters.html?slug=123--title', active: true }]);
  assert.deepEqual(page.menu().filter(entry => entry.on).map(entry => entry.title), ['Главы']);
  assert.equal(page.menu()[0].note, '24');
  page.resize(767);
  assert.equal(page.body.classes.has('phone'), true);
  page.resize(768);
  assert.equal(page.body.classes.has('phone'), false);
});

test('Esc and ✕ ask the page to close the window, at the origin whoami vouched for; Esc that a section handled does not', async () => {
  const page = panelPage({ me: { tabId: 7, url: panelUrl } });
  await page.settle();
  page.key({ key: 'Enter' });
  page.key({ key: 'Escape', defaultPrevented: true });
  assert.deepEqual(page.calls.posted, []);
  page.key({ key: 'Escape' });
  page.element('close').fire('click');
  assert.deepEqual(jsonCopy(page.calls.posted), [[{ libsaver: true, type: 'close' }, 'https://mangalib.me'], [{ libsaver: true, type: 'close' }, 'https://mangalib.me']]);
  // a section frame hands its own Esc to the same handler once it has loaded
  const frame = page.element('frames').children[0];
  let keydown;
  frame.contentDocument = { addEventListener: (type, fn) => { if (type === 'keydown') keydown = fn; } };
  frame.fire('load');
  keydown({ key: 'Escape' });
  assert.equal(page.calls.posted.length, 3);
});

test('a load error shows its text with «Повторить», which loads again with force', async () => {
  const page = panelPage({ me: { tabId: 7, url: panelUrl } });
  await page.settle();
  page.ctx.loadTitleData = async args => {
    page.calls.loads.push(jsonCopy(args));
    throw Object.assign(new Error('load-failed'), { code: 'load-failed' });
  };
  page.element('retry').fire('click');
  await page.settle();
  assert.equal(page.element('error-text').textContent, 'Не удалось получить данные из API.');
  assert.equal(page.element('retry').has('hidden'), false);
  assert.equal(page.element('foot').has('hidden'), true);
  assert.deepEqual(page.calls.loads.at(-1), { tabId: 7, url: panelUrl, force: true });
});

test('panel.html loads its scripts in dependency order and panel.js never reads the embedder from the address', () => {
  const html = source('src/html/panel.html');
  const scripts = [...html.matchAll(/<script src="\.\.\/([^"]+)"/g)].map(match => match[1]);
  const order = ['utils/page-call.js', 'core/api.js', 'core/chapter-range.js', 'utils/formats.js', 'core/title-loader.js', 'core/snapshot.js', 'utils/engine-client.js', 'core/site-download.js', 'core/panel.js'];
  assert.deepEqual(scripts.filter(script => order.includes(script)), order);
  assert.ok(scripts.includes('utils/title-store.js') && scripts.includes('utils/toast.js') && scripts.includes('core/theme.js'));
  assert.ok(html.includes('css/panel.css'));
  const text = source('src/core/panel.js');
  const start = text.slice(text.indexOf('function startPanel'));
  assert.doesNotMatch(start, /params\.get\('(url|parent)'\)/);
  assert.ok(start.indexOf("action: 'whoami'") > 0 && start.indexOf("action: 'whoami'") < start.indexOf('load(false)'));
  assert.match(start, /verifiedEmbedder\(me, tabParam\)/);
  assert.match(source('src/html/quick.html'), /core\/site-download\.js[\s\S]*core\/quick\.js/);
});

test('the settings window is opened from the page by the popup request, only by the extension, and the page answers true once it is open', async () => {
  const ctx = siteUiContext();
  const opened = [];
  ctx.openSettings = async section => { opened.push(section); };
  const ask = async (message, sender = { id: 'id' }) => {
    const replies = [];
    const kept = ctx.onRuntimeMessage(message, sender, value => replies.push(value));
    await settle();
    return [kept, replies];
  };
  assert.deepEqual(await ask({ action: 'libsaver:openPanel', section: 'chapters' }), [true, [true]]);
  assert.deepEqual(await ask({ action: 'libsaver:openPanel' }), [true, [true]]);
  assert.deepEqual(await ask({ action: 'libsaver:openPanel', section: { x: 1 } }), [true, [true]]);
  assert.deepEqual(await ask({ action: 'libsaver:openPanel', section: 'chapters' }, { id: 'other-extension' }), [undefined, []]);
  assert.deepEqual(await ask({ action: 'showToast' }), [undefined, []]);
  assert.deepEqual(await ask(null), [undefined, []]);
  assert.deepEqual(opened, ['chapters', undefined, undefined]);
  ctx.openSettings = async () => { throw new Error('boom'); };
  assert.deepEqual(await ask({ action: 'libsaver:openPanel' }), [true, [false]]);
});

test('background forwards the popup request to the active title tab only', async () => {
  const sent = [];
  let tabs = [{ id: 3, url: 'https://mangalib.me/ru/manga/1--a' }];
  let failSend = false;
  const page = siteUiContext();
  page.openSettings = async () => {};
  const ctx = vm.createContext({ URL, console, chrome: { tabs: {
    query: async () => tabs,
    // the page side is the real handler: like Chrome, the promise rejects when it keeps no channel open or never replies
    sendMessage: (id, message) => new Promise((resolve, reject) => {
      if (failSend) return reject(new Error('Could not establish connection'));
      sent.push([id, message]);
      let replied = false;
      const kept = page.onRuntimeMessage(message, { id: 'id' }, value => { replied = true; resolve(value); });
      if (kept !== true && !replied) reject(new Error('The message port closed before a response was received.'));
    })
  } } });
  vm.runInContext(source('src/utils/page-call.js') + functionSource('src/background.js', 'openPanelOnActiveTab') + functionSource('src/background.js', 'handleOpenPanel'), ctx);
  const ask = async (request, sender = {}) => {
    let answer;
    const kept = ctx.handleOpenPanel(request, sender, value => { answer = value; });
    if (kept === true) await settle();
    return [kept, answer];
  };
  assert.deepEqual(await ask({ action: 'openPanel' }), [true, true]);
  assert.deepEqual(await ask({ action: 'openPanel', section: 'downloads' }), [true, true]);
  assert.deepEqual(await ask({ action: 'openPanel', section: 5 }), [true, true]);
  assert.deepEqual(jsonCopy(sent), [[3, { action: 'libsaver:openPanel' }], [3, { action: 'libsaver:openPanel', section: 'downloads' }], [3, { action: 'libsaver:openPanel' }]]);
  assert.deepEqual(await ask({ action: 'openPanel' }, { tab: { id: 9 } }), [undefined, false]); // a page script cannot ask
  assert.deepEqual(await ask({ action: 'whoami' }), [undefined, undefined]);
  tabs = [{ id: 3, url: 'https://mangalib.me/ru/catalog' }];
  assert.deepEqual(await ask({ action: 'openPanel' }), [true, false]);
  tabs = [{ id: 3, url: 'https://evil.example/ru/manga/1--a?mangalib.me' }];
  assert.deepEqual(await ask({ action: 'openPanel' }), [true, false]);
  tabs = [];
  assert.deepEqual(await ask({ action: 'openPanel' }), [true, false]);
  tabs = [{ id: 3, url: 'https://mangalib.me/ru/manga/1--a' }];
  failSend = true; // no content script in the tab
  assert.deepEqual(await ask({ action: 'openPanel' }), [true, false]);
  assert.equal(sent.length, 3);
});

test('the popup asks the background for the settings window on a title page and keeps its own screen elsewhere or on failure', async () => {
  const messages = [];
  let reply = true;
  const ctx = vm.createContext({ URL, console, chrome: { runtime: { sendMessage: async message => { messages.push(message); if (reply instanceof Error) throw reply; return reply; } } } });
  vm.runInContext(source('src/utils/page-call.js') + functionSource('src/core/popup.js', 'openPanelFromPopup'), ctx);
  assert.equal(await ctx.openPanelFromPopup('https://mangalib.me/ru/manga/1--a'), true);
  assert.deepEqual(jsonCopy(messages), [{ action: 'openPanel' }]);
  assert.equal(await ctx.openPanelFromPopup('https://mangalib.me/ru/catalog'), false);
  assert.equal(await ctx.openPanelFromPopup('https://example.org/'), false);
  assert.equal(messages.length, 1); // off a title page nothing is asked
  reply = false;
  assert.equal(await ctx.openPanelFromPopup('https://mangalib.me/ru/manga/1--a'), false);
  reply = new Error('no receiver');
  assert.equal(await ctx.openPanelFromPopup('https://ranobelib.me/ru/book/7--y'), false);
});

// popup.js loadTitle над фейковой страницей: окно поверх сайта открывается первым, иначе popup говорит, куда перейти
function popupPage({ url, panelOpens }) {
  const elements = {};
  const element = id => elements[id] ||= { hidden: new Set(['hidden']), textContent: '', classList: { add: name => elements[id].hidden.add(name), remove: name => elements[id].hidden.delete(name) } };
  const calls = { closed: 0, sent: [] };
  const ctx = vm.createContext({
    URL, console,
    document: { getElementById: element, querySelector: () => element('.lib-buttons') },
    window: { close: () => { calls.closed++; }, applySiteAccent() {} },
    chrome: { tabs: { query: async () => [{ id: 4, url }] }, runtime: { sendMessage: async message => { calls.sent.push(message.action); return panelOpens; } } }
  });
  vm.runInContext(source('src/utils/page-call.js') + ['openPanelFromPopup', 'loadTitle', 'showMessage'].map(name => functionSource('src/core/popup.js', name)).join('\n'), ctx);
  const shown = id => !element(id).hidden.has('hidden');
  return { ctx, calls, element, shown };
}

test('the popup closes after opening the window on a title page and otherwise says where to go', async () => {
  const opened = popupPage({ url: 'https://mangalib.me/ru/manga/1--a', panelOpens: true });
  await opened.ctx.loadTitle();
  assert.deepEqual([opened.calls.closed, opened.calls.sent, opened.shown('error-view')], [1, ['openPanel'], false]);

  const catalog = popupPage({ url: 'https://mangalib.me/ru/catalog', panelOpens: false });
  await catalog.ctx.loadTitle();
  assert.deepEqual([catalog.calls.closed, catalog.calls.sent, catalog.element('error-text').textContent], [0, [], 'Перейдите на главную страницу нужного тайтла.']);
  assert.deepEqual(['btn-mangalib', 'btn-animelib', 'btn-reload-page'].map(catalog.shown), [true, true, false]);

  const foreign = popupPage({ url: 'https://example.org/', panelOpens: false });
  await foreign.ctx.loadTitle();
  assert.equal(foreign.element('error-text').textContent, 'Перейдите на один из поддерживаемых сайтов.');
  assert.equal(foreign.shown('btn-ranobelib'), true);

  // a title page opened before the extension was updated has no site script: the popup offers a reload instead of a dead end
  const stale = popupPage({ url: 'https://ranobelib.me/ru/book/7--y', panelOpens: false });
  await stale.ctx.loadTitle();
  assert.deepEqual([stale.calls.closed, stale.shown('btn-reload-page'), stale.shown('btn-mangalib'), stale.element('error-text').textContent], [0, true, false, 'Не удалось открыть окно LibSaver. Перезагрузите страницу.']);
});

test('the popup off a title page only points to the sites: no settings button', () => {
  assert.doesNotMatch(source('src/html/popup.html'), /btn-settings/);
  assert.doesNotMatch(source('src/core/popup.js'), /btn-settings|settings[.]html/);
  assert.doesNotMatch(source('src/css/popup.css'), /btn-settings/);
});

test('the settings tab (no ?group=) lists the sections on the left and shows only the panels of the one in the address', () => {
  const groups = ['general', 'storage', 'images', 'toc', 'cbz', 'pdf', 'txt', 'video', 'about'];
  const panels = groups.map(group => ({ dataset: { group }, classList: { toggle(name, on) { this.on = on; } } }));
  const links = [];
  const nav = { append: link => links.push(link) };
  const classes = [];
  let onHash = null;
  const element = () => ({ dataset: {}, attrs: {}, append() {}, setAttribute(name, value) { this.attrs[name] = value; }, removeAttribute(name) { delete this.attrs[name]; }, classList: { toggle(name, on) { this.on = on; } } });
  const ctx = vm.createContext({
    location: { hash: '#formats' }, settingsGroups: null,
    window: { scrollTo() {}, addEventListener: (type, fn) => { onHash = fn; } },
    document: {
      body: { classList: { add: name => classes.push(name) } },
      getElementById: id => id === 'settings-nav' ? nav : null,
      createElement: element, createTextNode: text => text,
      querySelectorAll: selector => selector === '.settings-nav a' ? links : panels
    }
  });
  vm.runInContext(between('src/core/settings.js', '// Вкладка настроек (без ?group=)', '// Отображение версии расширения'), ctx);
  assert.deepEqual(classes, ['tab-mode']);
  assert.deepEqual(links.map(link => link.href), ['#general', '#images', '#toc', '#formats', '#video', '#about']);
  const shown = () => panels.filter(panel => panel.classList.on === false).map(panel => panel.dataset.group);
  assert.deepEqual(shown(), ['cbz', 'pdf', 'txt']);
  assert.equal(links.find(link => link.attrs['aria-current'] === 'page').dataset.section, 'formats');
  ctx.location.hash = '#nonsense'; // an unknown section falls back to the first
  onHash();
  assert.deepEqual(shown(), ['general', 'storage']);
  // every panel group is in exactly one section of the tab
  assert.deepEqual(jsonCopy(vm.runInContext('TAB_SECTIONS', ctx).flatMap(section => section.groups).sort()), [...groups].sort());
});

test('storage logging never throws without getContexts (Firefox) and does not switch itself off there', async () => {
  const session = {};
  const logs = [];
  const ctx = vm.createContext({
    console: { log: message => logs.push(message) },
    disableLogging: () => logs.push('disabled'),
    chrome: { runtime: {}, storage: {
      session: { get: async () => session, set: async values => Object.assign(session, values), remove: async () => {} },
      local: { getBytesInUse: (_keys, done) => done(1048576) }
    } }
  });
  vm.runInContext(functionSource('src/background.js', 'logStorageSize'), ctx);
  await ctx.logStorageSize();
  assert.deepEqual(logs, ['[LibSaver] Storage size: 1.00 MB (1048576 bytes)']);
  // with getContexts and no windows the timer starts and later switches logging off
  ctx.chrome.runtime.getContexts = async () => [];
  await ctx.logStorageSize();
  assert.equal(typeof session.lastWindowCloseTime, 'number');
  session.lastWindowCloseTime = Date.now() - 121000;
  await ctx.logStorageSize();
  assert.equal(logs.at(-1), 'disabled');
});

test('the popup keeps no range, preparation or editor-window code', () => {
  const popup = source('src/core/popup.js');
  assert.doesNotMatch(popup, /chapter-from|chapter-to|btn-download|loadTitleData|openPopupWindow|syncOpenWindows|canOpenWindow|windowNames/);
  const html = source('src/html/popup.html');
  assert.doesNotMatch(html, /chapter-from|btn-download|title-loader|chapter-range/);
});

test('the old windows are no longer opened from the page or the background', () => {
  assert.doesNotMatch(source('src/content/site-ui.js'), /(workspace)\.html|html\/downloads\.html/);
  assert.doesNotMatch(source('src/background.js'), /(workspace)\.html/);
});

test('a third-party frame on a title page cannot use the window: the direct parent must be the site page (Chrome), whoami alone is enough where there is no ancestorOrigins (Firefox)', async () => {
  const ctx = vm.createContext({ URL, location: {} });
  vm.runInContext(source('src/utils/page-call.js'), ctx);
  const me = { tabId: 7, url: panelUrl };
  const embedder = ancestors => { ctx.location.ancestorOrigins = ancestors; return ctx.verifiedEmbedder(me, '7'); };
  assert.notEqual(embedder(['https://mangalib.me']), null);
  assert.notEqual(embedder(undefined), null);
  assert.equal(embedder(['https://ads.example']), null); // an ad iframe on the page
  assert.equal(embedder([]), null); // not framed at all
  assert.equal(embedder(['https://ads.example', 'https://mangalib.me']), null); // framed by the ad, which sits on the page
  assert.equal(embedder(['https://mangalib.me.evil.example']), null);
  assert.equal(ctx.verifiedEmbedder({ tabId: 5, url: 'https://mangalib.me/ru/catalog' }, '5', { requireTitle: false }), null);

  for (const ancestorOrigins of [['https://ads.example'], []]) {
    const page = panelPage({ me, ancestorOrigins });
    await page.settle();
    assert.equal(page.element('error').has('hidden'), false);
    page.element('retry').fire('click');
    page.element('download').fire('click');
    await page.settle();
    assert.deepEqual([page.calls.writes, page.calls.loads, page.calls.snapshots, page.calls.enqueues, page.calls.posted], [[], [], [], [], []]);
    assert.deepEqual(page.calls.messages, ['whoami']);
  }
  const ok = panelPage({ me, ancestorOrigins: ['https://mangalib.me'] });
  await ok.settle();
  assert.equal(ok.calls.loads.length, 1);

  const quick = quickPage({ me, search: '?tab=7' });
  quick.ctx.location.ancestorOrigins = ['https://ads.example']; // set before whoami answers
  await quick.settle();
  assert.deepEqual([quick.data, quick.loads, quick.posted], [{}, [], []]);
  assert.equal(quick.element('retry').classes.has('hidden'), true);
});

test('a failing refresh after a storage change is logged, not left as an unhandled rejection', () => {
  assert.match(source('src/core/panel.js'), /refresh\(\)\.catch\(/);
});

// ---- Task 11: settings by section and autosave ----

// Фейковые часы: setTimeout/clearTimeout/Date.now на виртуальном времени
function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { timers.set(++nextId, { fn, at: now + ms }); return nextId; },
    clearTimeout: handle => { timers.delete(handle); },
    now: () => now,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    }
  };
}

// autosave.js в vm: document с подписками и dispatchEvent, window с pagehide, chrome.runtime.sendMessage пишет сообщения
function autosaveContext() {
  const clock = fakeClock();
  const listeners = {};
  const windowListeners = {};
  const messages = [];
  const errors = [];
  const ctx = vm.createContext({
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, Date: { now: clock.now },
    console: { error: (...args) => errors.push(args) },
    CustomEvent: class { constructor(type) { this.type = type; } },
    document: {
      addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
      dispatchEvent(event) { for (const fn of listeners[event.type] || []) fn(event); }
    },
    window: { addEventListener: (type, fn) => { (windowListeners[type] ||= []).push(fn); } },
    chrome: { runtime: { sendMessage: message => { messages.push(message); return Promise.resolve(); } } }
  });
  vm.runInContext(source('src/utils/autosave.js'), ctx);
  const emit = type => ctx.document.dispatchEvent({ type });
  return { ctx, clock, emit, messages, errors, pagehide: () => windowListeners.pagehide.forEach(fn => fn()) };
}

test('enableAutosave: three inputs within 100 ms are one save, 400 ms after the last', async () => {
  const { ctx, clock, emit } = autosaveContext();
  let saves = 0;
  ctx.enableAutosave({ save: () => { saves++; } });
  emit('input');
  clock.advance(50);
  emit('input');
  clock.advance(50);
  emit('input');
  clock.advance(399);
  await flush();
  assert.equal(saves, 0);
  clock.advance(1);
  await flush();
  assert.equal(saves, 1);
  clock.advance(2000);
  await flush();
  assert.equal(saves, 1);
});

test('enableAutosave: change and libsaver:changed also save; a closing window saves at once and only once', async () => {
  const { ctx, clock, emit, pagehide } = autosaveContext();
  let saves = 0;
  ctx.enableAutosave({ save: () => { saves++; }, delay: 100 });
  emit('change');
  clock.advance(100);
  await flush();
  assert.equal(saves, 1);
  ctx.notifyChanged();
  clock.advance(100);
  await flush();
  assert.equal(saves, 2);
  emit('input');
  pagehide(); // окно закрывают раньше, чем истекла пауза
  await flush();
  assert.equal(saves, 3);
  clock.advance(1000);
  await flush();
  assert.equal(saves, 3);
  pagehide(); // нечего сохранять
  await flush();
  assert.equal(saves, 3);
});

test('enableAutosave: saves run one after another, even when a change comes while one is still running', async () => {
  const { ctx, clock, emit } = autosaveContext();
  const log = [];
  let release;
  ctx.enableAutosave({ save: async () => { log.push('start'); await new Promise(resolve => { release = resolve; }); log.push('end'); } });
  emit('input');
  clock.advance(400);
  await flush();
  emit('input');
  clock.advance(400);
  await flush();
  assert.deepEqual(log, ['start']); // second waits for the first
  release();
  await flush();
  release();
  await flush();
  assert.deepEqual(log, ['start', 'end', 'start', 'end']);
});

test('enableAutosave: a failed save is a toast with the error text and a console error, and the next change saves again', async () => {
  const { ctx, clock, emit, messages, errors } = autosaveContext();
  let fail = true;
  ctx.enableAutosave({ save: () => { if (fail) throw new Error('quota <b>exceeded</b>'); } });
  emit('input');
  clock.advance(400);
  await flush();
  assert.deepEqual(jsonCopy(messages), [{ action: 'showToast', message: 'Не удалось сохранить: quota <b>exceeded</b>', type: 'error', duration: 4000 }]);
  assert.equal(errors.length, 1);
  fail = false;
  emit('input');
  clock.advance(400);
  await flush();
  assert.equal(messages.at(-1).message, 'Сохранено!');
});

test('enableAutosave: «Сохранено!» is shown at most once in 5 seconds, not after every change', async () => {
  const { ctx, clock, emit, messages } = autosaveContext();
  ctx.enableAutosave({ save: () => {} });
  for (let i = 0; i < 4; i++) {
    emit('input');
    clock.advance(1000);
    await flush();
  }
  assert.equal(messages.filter(message => message.message === 'Сохранено!').length, 1);
  clock.advance(5000);
  emit('input');
  clock.advance(400);
  await flush();
  assert.equal(messages.filter(message => message.message === 'Сохранено!').length, 2);
});

test('toasts insert their text with textContent, so an error text cannot inject markup', () => {
  assert.doesNotMatch(source('src/utils/toast.js'), /innerHTML/);
  assert.match(source('src/core/panel.js'), /showToast\(message\.message, message\.type, message\.duration\)/);
});

test('there is no «Сохранить» button in settings and the editors, no window.close() after saving and no «Отменено!» on closing', () => {
  for (const page of ['settings', 'metadata', 'covers', 'chapters']) {
    assert.doesNotMatch(source(`src/html/${page}.html`), /id="btn-save"/, page);
    assert.match(source(`src/html/${page}.html`), /<script src="[.][.]\/utils\/autosave[.]js"><\/script>\s*(<script src="[.][.]\/(core|editors)\/[a-z]+[.]js"><\/script>\s*)?<script src="[.][.]\/(core|editors)\/(settings|metadata|covers|chapters)[.]js"><\/script>/, page);
  }
  for (const file of ['src/core/settings.js', 'src/editors/metadata.js', 'src/editors/covers.js', 'src/editors/chapters.js']) {
    assert.doesNotMatch(source(file), /window[.]close|wasSaved|Отменено/, file);
  }
  assert.match(source('src/core/settings.js'), /enableAutosave[(][{] save: saveSettings [}][)]/);
  assert.match(source('src/editors/metadata.js'), /enableAutosave[(][{] save: saveMetadata [}][)]/);
  assert.match(source('src/editors/covers.js'), /enableAutosave[(][{] save: saveCovers [}][)]/);
  assert.match(source('src/editors/chapters.js'), /enableAutosave[(][{] save: saveChapters [}][)]/);
});

test('covers and chapters tell autosave about changes that are not typing: dragging, uploads, deleting, resets, translator choices', () => {
  const covers = source('src/editors/covers.js');
  assert.match(functionSource('src/editors/covers.js', 'handleFileUpload'), /notifyChanged[(][)]/);
  assert.match(covers, /onEnd: function[(]evt[)] [{]\s*[^}]*updateCoversOrder[(][)];\s*notifyChanged[(][)]/);
  assert.equal(covers.match(/removeCoverItem[(]index[)];\s*notifyChanged/g).length, 2);
  const chapters = source('src/editors/chapters.js');
  assert.match(chapters, /chapterBranchOverrides\[ch[.]id\] = translatorKey;\s*notifyChanged[(][)]/);
  assert.match(functionSource('src/editors/chapters.js', 'updatePriorityFromList'), /notifyChanged[(][)]/);
});

test('metadata: the enabled fields live in the storage key metadataFields, and the panel counter follows a change made in the editor', async () => {
  const page = panelPage({ me: { tabId: 7, url: panelUrl } });
  await page.settle();
  assert.equal(page.menu()[1].note, '15'); // nothing written yet: all fields are on
  const fields = ['title-ru', 'title-en', 'title-original', 'title-alt', 'author', 'artist', 'year', 'status', 'country', 'release-format', 'publisher', 'age-restriction', 'description', 'genres', 'tags'];
  const clicks = [];
  const editor = vm.createContext({
    chrome: { storage: { local: { set: values => page.ctx.chrome.storage.local.set(values) } } },
    notifyChanged() {},
    document: { querySelectorAll: () => fields.map(fieldId => ({ getAttribute: () => fieldId, closest: () => ({ classList: { add() {}, remove() {} } }), addEventListener: (type, fn) => clicks.push(fn) })) }
  });
  vm.runInContext(`let metadataFields = ${JSON.stringify(Object.fromEntries(fields.map(field => [field, true])))};\n${functionSource('src/editors/metadata.js', 'initFieldVisibilityButtons')}\ninitFieldVisibilityButtons();`, editor);
  clicks[0]({ preventDefault() {} }); // switch «Название (RU)» off
  clicks[3]({ preventDefault() {} });
  await page.settle();
  assert.equal(page.data.metadataFields['title-ru'], false);
  assert.equal(page.menu()[1].note, '13');
  clicks[0]({ preventDefault() {} }); // and back on
  await page.settle();
  assert.equal(page.menu()[1].note, '14');
});

// settings.js: разбор ?group=, ключи по группам и сохранение раздела
const settingsGroupsLogic = () => {
  const ctx = vm.createContext({ URLSearchParams, location: { search: '' }, document: { body: { classList: { add() {} } }, querySelectorAll: () => [] } });
  vm.runInContext(between('src/core/settings.js', 'const GROUP_ALIASES', '// Дефолтные ссылки сайтов'), ctx);
  return ctx;
};
function between(file, start, end) {
  const text = source(file);
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing source boundary: ${file}: ${start}`);
  return text.slice(from, to);
}

test('settings.html?group= lists panels by data-group; «general» is «general,storage»; no group is the whole page', () => {
  const ctx = settingsGroupsLogic();
  assert.equal(ctx.settingsGroupsFromUrl(''), null);
  assert.equal(ctx.settingsGroupsFromUrl('?slug=1--a'), null);
  assert.deepEqual(jsonCopy(ctx.settingsGroupsFromUrl('?group=general')), ['general', 'storage']);
  assert.deepEqual(jsonCopy(ctx.settingsGroupsFromUrl('?group=images&slug=1--a')), ['images']);
  assert.deepEqual(jsonCopy(ctx.settingsGroupsFromUrl('?group=toc,about')), ['toc', 'about']);
  assert.deepEqual(jsonCopy(ctx.settingsGroupsFromUrl('?group=formats')), ['cbz', 'pdf', 'txt']);
});

test('group mode hides the panels outside the list and switches the page to one column without the toolbar', () => {
  const panels = ['general', 'storage', 'images', 'about'].map(group => ({ dataset: { group }, hidden: null, classList: { toggle(name, on) { this.on = on; } } }));
  const classes = [];
  const ctx = vm.createContext({ URLSearchParams, location: { search: '?group=general' }, document: { body: { classList: { add: name => classes.push(name) } }, querySelectorAll: () => panels } });
  vm.runInContext(between('src/core/settings.js', 'const GROUP_ALIASES', '// Дефолтные ссылки сайтов'), ctx);
  assert.deepEqual(classes, ['group-mode']);
  assert.deepEqual(panels.map(panel => panel.classList.on), [false, false, true, true]);
  const css = source('src/css/settings.css');
  assert.match(css, /body[.]group-mode [.]toolbar [{]\s*display: none;/);
  assert.match(css, /body[.]group-mode [.]settings-column [{]\s*display: contents;/);
});

test('every settings group of the window has a panel, every panel is in some section, and no control sits outside a panel', () => {
  const html = source('src/html/settings.html');
  const chunks = html.split('<div class="panel" data-group="').slice(1);
  const byGroup = Object.fromEntries(chunks.map(chunk => [chunk.slice(0, chunk.indexOf('"')), chunk]));
  assert.deepEqual(Object.keys(byGroup).sort(), ['about', 'cbz', 'general', 'images', 'pdf', 'storage', 'toc', 'txt', 'video']);
  const ctx = settingsGroupsLogic();
  const panelCtx = panelLogic();
  const reachable = new Set();
  for (const section of [...panelCtx.PANEL_SECTIONS(), ...panelCtx.PANEL_SECTIONS('anime')]) {
    const group = new URL(section.url, 'chrome-extension://x/').searchParams.get('group');
    if (group) for (const name of ctx.settingsGroupsFromUrl(`?group=${group}`)) reachable.add(name);
  }
  assert.deepEqual([...reachable].sort(), Object.keys(byGroup).sort());
  const outside = html.slice(0, html.indexOf('<div class="container">')) + html.slice(html.lastIndexOf('<div class="scroll-buttons"'));
  assert.doesNotMatch(outside, /<(input|select)\b/);
  // theme, colour, storage clean-up, version and update check moved from the toolbar into panels
  for (const [group, ids] of Object.entries({ general: ['theme-select', 'accent-select', 'reload-warning'], storage: ['cleanup-on-title-change', 'cleanup-old-titles', 'storage-size-display', 'btn-cleanup'], about: ['extension-version', 'btn-check-updates'] })) {
    for (const id of ids) assert.ok(byGroup[group].includes(`id="${id}"`), `${group}: ${id}`);
  }
  assert.match(byGroup.about, /class="issue-btn"/);
  assert.match(byGroup.about, /dfy-dpg[/]LibSaver"/);
});

test('every setting that is saved belongs to exactly one panel group, and each form control of a group is among its keys', () => {
  const text = source('src/core/settings.js');
  const saved = functionSource('src/core/settings.js', 'saveSettings');
  const allBlock = saved.slice(saved.indexOf('const all = {'), saved.indexOf('};', saved.indexOf('const all = {')));
  const collected = [...allBlock.matchAll(/^ {4}(\w+):/gm)].map(match => match[1]).sort();
  const keysBlock = text.slice(text.indexOf('const SETTING_KEYS_BY_GROUP'), text.indexOf('};', text.indexOf('const SETTING_KEYS_BY_GROUP')));
  const declared = [...keysBlock.matchAll(/'(\w+)'/g)].map(match => match[1]).sort();
  assert.deepEqual(declared, collected);
  assert.equal(new Set(declared).size, declared.length);
  // the group of a key is the group of the panel holding its control
  const html = source('src/html/settings.html');
  const panels = html.split('<div class="panel" data-group="').slice(1);
  const ctx = vm.createContext({});
  vm.runInContext(keysBlock + '};\nthis.keys = SETTING_KEYS_BY_GROUP;', ctx);
  const camel = id => id.replace(/-(\w)/g, (_, letter) => letter.toUpperCase());
  for (const panel of panels) {
    const group = panel.slice(0, panel.indexOf('"'));
    for (const [, id] of panel.matchAll(/<(?:input|select)\b[^>]*\bid="([\w-]+)"/g)) {
      if (id.startsWith('site-') || id.endsWith('-value')) continue;
      assert.ok(ctx.keys[group].includes(camel(id)) || (id === 'generate-comicinfo' && ctx.keys[group].includes('generateComicInfo')), `${group}: ${id}`);
    }
  }
});

// saveSettings над фейковым storage: в разделе окна пишутся только ключи своих групп
async function saveSettingsIn(settingsGroups, data) {
  const listeners = {};
  const ctx = vm.createContext({
    defaultSiteLinks: {}, settingsGroups, console,
    document: { getElementById: id => ({ value: id === 'image-quality' ? 'FHD' : id === 'toc-format' ? 'custom' : '1', checked: true }) },
    chrome: { storage: { local: { get: async keys => Object.fromEntries([].concat(keys).filter(key => key in data).map(key => [key, data[key]])), set: async values => { Object.assign(data, structuredClone(values)); }, remove: async () => {} } }, runtime: { sendMessage() {} } }
  });
  vm.runInContext(source('src/utils/title-store.js') + between('src/core/settings.js', 'const SETTING_KEYS_BY_GROUP', '// Дефолтные значения по группам') + '\nthis.saveSettings = saveSettings;', ctx);
  await ctx.saveSettings();
  return listeners;
}

test('a section of the window saves only the keys of its own groups, so a stale frame cannot overwrite another section', async () => {
  const images = { tocFormat: 'format1', pdfFont: 'lora' };
  await saveSettingsIn(['images'], images);
  assert.equal(images.imageQuality, 'FHD');
  assert.equal(images.tocFormat, 'format1');
  assert.equal(images.pdfFont, 'lora');
  assert.ok(!('cleanupOldTitles' in images) && !('enableSiteMenu' in images));

  const general = { imageQuality: 'HD' };
  await saveSettingsIn(['general', 'storage'], general);
  assert.deepEqual(Object.keys(general).sort(), ['cleanupOldTitles', 'cleanupOnTitleChange', 'customSiteLinks', 'debugLogging', 'enableSiteMenu', 'imageQuality', 'initialChapters', 'loadMoreChapters', 'updateNotifications']);
  assert.equal(general.imageQuality, 'HD');

  const whole = {};
  await saveSettingsIn(null, whole); // the old page, no ?group=
  assert.ok(['imageQuality', 'tocFormat', 'pdfFont', 'txtImageMarker', 'generateComicInfo', 'cleanupOldTitles', 'enableSiteMenu'].every(key => key in whole));
});

test('about: the version is from the manifest and the update check asks the latest GitHub release', () => {
  const settings = source('src/core/settings.js');
  assert.match(functionSource('src/core/settings.js', 'displayVersion'), /chrome[.]runtime[.]getManifest[(][)]/);
  assert.match(functionSource('src/core/settings.js', 'checkForUpdates'), /fetchLatestRelease[(][)]/);
  assert.match(source('src/core/popup.js'), /fetchLatestRelease[(][)]/);
  assert.match(settings, /getElementById[(]'btn-check-updates'[)]/);
});

// ---- Task 11, fix round: guards against data loss in autosave ----

test('the TOC reformat wipes displayTitle once per committed change (change / leaving the page), never on typing', async () => {
  const clock = fakeClock();
  const listeners = {};
  const windowListeners = {};
  const messages = [];
  const data = { 'titleData:a': { chapters: [{ displayTitle: 'Renamed by hand' }] } };
  const controls = { 'toc-format': { value: 'custom' }, 'custom-toc-format': { value: '[{num}]' }, 'hide-chapter-name': { checked: false }, 'hide-volume-number': { checked: false } };
  const ctx = vm.createContext({
    defaultSiteLinks: {}, settingsGroups: null, console,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, Date: { now: clock.now },
    CustomEvent: class { constructor(type) { this.type = type; } },
    window: { addEventListener: (type, fn) => { (windowListeners[type] ||= []).push(fn); } },
    document: { getElementById: id => controls[id] || { value: '1', checked: false }, addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); } },
    chrome: {
      storage: { local: {
        get: async keys => structuredClone(keys === null ? data : Object.fromEntries([].concat(keys).filter(key => key in data).map(key => [key, data[key]]))),
        set: async values => { Object.assign(data, structuredClone(values)); },
        remove: async () => {}
      } },
      runtime: { sendMessage: message => { messages.push(message); return Promise.resolve(); } }
    }
  });
  vm.runInContext(source('src/utils/title-store.js') + source('src/utils/autosave.js') + between('src/core/settings.js', 'const SETTING_KEYS_BY_GROUP', '// Дефолтные значения по группам'), ctx);
  vm.runInContext('appliedToc = tocSignature(readTocControls()); watchTocCommit(); enableAutosave({ save: saveSettings });', ctx);
  const emit = (type, id) => { for (const fn of listeners[type]) fn({ type, target: { id } }); };
  const reformats = () => messages.filter(message => message.action === 'reformatChapters').length;
  const settle = async ms => { clock.advance(ms); await flush(); };

  for (const typed of ['[{num}]a', '[{num}]ab', '[{num}]abc', '[{num}]abcd', '[{num}]abcde']) {
    controls['custom-toc-format'].value = typed;
    emit('input', 'custom-toc-format');
    await settle(450); // a pause: autosave writes the value
  }
  assert.equal(data.customTocFormat, '[{num}]abcde');
  assert.equal(reformats(), 0);
  assert.equal(data['titleData:a'].chapters[0].displayTitle, 'Renamed by hand');

  emit('change', 'custom-toc-format'); // blur
  await settle(450);
  assert.equal(reformats(), 1);
  assert.equal(data['titleData:a'].chapters[0].displayTitle, undefined);

  data['titleData:a'].chapters[0].displayTitle = 'Renamed again';
  emit('change', 'custom-toc-format'); // committed again, nothing changed since the last pass
  await settle(450);
  assert.equal(reformats(), 1);
  assert.equal(data['titleData:a'].chapters[0].displayTitle, 'Renamed again');

  controls['hide-chapter-name'].checked = true; // a checkbox commits with change alone
  emit('change', 'hide-chapter-name');
  await settle(450);
  assert.equal(reformats(), 2);

  controls['custom-toc-format'].value = 'last'; // closing the window with the field still focused
  emit('input', 'custom-toc-format');
  windowListeners.pagehide.forEach(fn => fn());
  await flush();
  assert.equal(reformats(), 3);
  assert.equal(data.customTocFormat, 'last');
  clock.advance(1000);
  await flush();
  assert.equal(reformats(), 3);

  emit('change', 'debug-logging'); // other fields never reformat
  await settle(450);
  assert.equal(reformats(), 3);
});

// saveChapters / saveCovers / saveMetadata над фейковым хранилищем: что и когда они пишут
function chaptersSaveContext({ slug = 's', allChapters = [{ id: 1 }], titleData = {}, selectionDirty = true, chosen = allChapters.map(ch => ch.id) } = {}) {
  const writes = [];
  const ctx = vm.createContext({
    allChapters, displayChapters: allChapters, originalChapters: allChapters, chapterBranchOverrides: {}, translatorPriority: [], chosenIds: new Set(chosen), selectionDirty,
    tocFormat: 'default', customTocFormat: '', hideChapterName: false, hideVolumeNumber: false,
    document: { querySelectorAll: () => [] },
    formatChapterTitle: () => 'T',
    getTitleStore: async () => ({ titleData, currentSlug: slug }),
    setTitleStore: async items => { writes.push(items); }
  });
  vm.runInContext(source('src/core/chapter-range.js') + functionSource('src/editors/chapters.js', 'saveChapters') +'\nthis.saveChapters = saveChapters;', ctx);
  return { ctx, writes };
}

test('saveChapters writes nothing without a slug (no titleData:undefined) and nothing when no chapters were loaded', async () => {
  const noSlug = chaptersSaveContext({ slug: '' });
  await noSlug.ctx.saveChapters();
  assert.deepEqual(noSlug.writes, []);
  const noChapters = chaptersSaveContext({ allChapters: [] }); // «Сбросить всё» / «Очистить всё» fire libsaver:changed with zero inputs
  await noChapters.ctx.saveChapters();
  assert.deepEqual(noChapters.writes, []);
  const loaded = chaptersSaveContext();
  await loaded.ctx.saveChapters();
  assert.equal(loaded.writes.length, 1);
  assert.deepEqual(Object.keys(loaded.writes[0].titleData), ['s']);
  assert.equal(loaded.writes[0].titleData.s.chapters.length, 1);
});

// ---- Task 12: раздел «Главы» ----

test('volumeState: none / some / all of the volume’s chapters are selected, other volumes do not count', () => {
  const ctx = vm.createContext({});
  vm.runInContext(functionSource('src/editors/chapters.js', 'volumeState') + '\nthis.volumeState = volumeState;', ctx);
  const chapters = [{ id: 1, volume: '1' }, { id: 2, volume: '1' }, { id: 3, volume: '1' }, { id: 4, volume: '2' }];
  assert.equal(ctx.volumeState(chapters, new Set(), '1'), 'none');
  assert.equal(ctx.volumeState(chapters, new Set([1, 3]), '1'), 'some');
  assert.equal(ctx.volumeState(chapters, [1, 2, 3], 1), 'all'); // an array of ids and a numeric volume work too
  assert.equal(ctx.volumeState(chapters, new Set([4]), '1'), 'none');
  assert.equal(ctx.volumeState(chapters, new Set([4]), '2'), 'all');
});

test('the chapters section’s selection reaches the panel and the snapshot even outside the old popup range (R24)', async () => {
  const page = panelPage({ me: { tabId: 7, url: panelUrl } }); // filteredChapters = chapters 1..24
  await page.settle();
  assert.equal(page.element('download').textContent, 'Скачать 24 главы');
  const selection = [50, 51, 100];
  const saveCtx = vm.createContext({
    allChapters: structuredClone(panelChapters), displayChapters: [], originalChapters: [], chapterBranchOverrides: {}, translatorPriority: [], chosenIds: new Set(selection), selectionDirty: true,
    tocFormat: 'default', customTocFormat: '', hideChapterName: false, hideVolumeNumber: false,
    URLSearchParams, document: { querySelectorAll: () => [] }, formatChapterTitle: () => 'T', location: { protocol: 'chrome-extension:', search: '?slug=123--title' },
    chrome: page.ctx.chrome
  });
  vm.runInContext(source('src/utils/title-store.js') + source('src/core/chapter-range.js') + functionSource('src/editors/chapters.js', 'saveChapters') + '\nthis.saveChapters = saveChapters;', saveCtx);
  await saveCtx.saveChapters();
  await page.settle();
  assert.equal(page.element('download').textContent, 'Скачать 3 главы');
  page.element('download').fire('click');
  await page.settle();
  assert.deepEqual(page.calls.snapshots[0].selectedChapterIds, selection);
  const snap = await snapshotContext(page.data).buildDownloadSnapshot({ ...page.calls.snapshots[0] });
  assert.deepEqual(snap.downloadData.chapters.map(ch => ch.id), selection); // the engine filters these by selectedChapterIds
  assert.deepEqual(snap.downloadData.selectedChapterIds, selection);
});

test('an autosave that did not touch the selection (a rename) keeps the selection set from outside; a touched selection is written', async () => {
  const chapters = [1, 2, 3, 4].map(id => ({ id, volume: '1' }));
  const titleData = { s: { chapters, selectedChapterIds: [2, 3], filteredChapters: chapters.slice(1, 3) } }; // the quick popover set 2..3 meanwhile
  const renamed = chaptersSaveContext({ allChapters: structuredClone(chapters), titleData: structuredClone(titleData), selectionDirty: false, chosen: [1, 2, 3, 4] });
  await renamed.ctx.saveChapters();
  assert.deepEqual(jsonCopy(renamed.writes[0].titleData.s.selectedChapterIds), [2, 3]);
  assert.deepEqual(renamed.writes[0].titleData.s.filteredChapters.map(ch => ch.id), [2, 3]);

  const edited = chaptersSaveContext({ allChapters: structuredClone(chapters), titleData: structuredClone(titleData), selectionDirty: true, chosen: [1, 4] });
  await edited.ctx.saveChapters();
  assert.deepEqual(jsonCopy(edited.writes[0].titleData.s.selectedChapterIds), [1, 4]);
  assert.deepEqual(edited.writes[0].titleData.s.filteredChapters.map(ch => ch.id), [1, 4]);
  assert.equal(vm.runInContext('selectionDirty', edited.ctx), false); // written: the next autosave leaves it alone
});

test('the chapters frame follows a selection changed outside while it has no unsaved selection of its own, and ignores it otherwise', () => {
  const chapters = [1, 2, 3, 4].map(id => ({ id, volume: '1' }));
  const make = dirty => {
    const refreshed = [];
    const ctx = vm.createContext({
      currentSlug: 's', uniqueChapters: chapters, chosenIds: new Set([1, 2, 3, 4]), selectionDirty: dirty,
      titleStoreKey: (kind, slug) => `${kind}:${slug}`, refreshSelectionUi: () => refreshed.push('ui'), syncRangeSelects: () => refreshed.push('range')
    });
    vm.runInContext(functionSource('src/editors/chapters.js', 'initialSelection') + functionSource('src/editors/chapters.js', 'followStoredSelection') + '\nthis.followStoredSelection = followStoredSelection;', ctx);
    return { ctx, refreshed };
  };
  const changes = { 'titleData:s': { newValue: { selectedChapterIds: [2, 3] } } };
  const idle = make(false);
  idle.ctx.followStoredSelection(changes);
  assert.deepEqual(jsonCopy([...vm.runInContext('chosenIds', idle.ctx)]), [2, 3]);
  assert.deepEqual(idle.refreshed, ['ui', 'range']);
  const busy = make(true);
  busy.ctx.followStoredSelection(changes);
  assert.deepEqual(jsonCopy([...vm.runInContext('chosenIds', busy.ctx)]), [1, 2, 3, 4]);
  idle.ctx.followStoredSelection({ 'titleData:other': changes['titleData:s'] }); // another title
  assert.deepEqual(jsonCopy([...vm.runInContext('chosenIds', idle.ctx)]), [2, 3]);
});

test('the starting selection: stored ids, else the old popup range, else everything; a stored list of only unknown ids never becomes an empty selection', () => {
  const chapters = [1, 2, 3, 4].map(id => ({ id, volume: '1' }));
  const ctx = vm.createContext({ uniqueChapters: chapters });
  vm.runInContext(functionSource('src/editors/chapters.js', 'initialSelection') + '\nthis.initialSelection = initialSelection;', ctx);
  const pick = title => jsonCopy([...ctx.initialSelection(title)]);
  assert.deepEqual(pick({ selectedChapterIds: [3, 9, 1], filteredChapters: [{ id: 2 }] }), [3, 1]);
  assert.deepEqual(pick({ selectedChapterIds: [], filteredChapters: [{ id: 2 }] }), []); // deselected on purpose
  assert.deepEqual(pick({ selectedChapterIds: [8, 9], filteredChapters: [{ id: 2 }, { id: 3 }] }), [2, 3]); // chapters were refetched
  assert.deepEqual(pick({ selectedChapterIds: [8, 9], filteredChapters: [{ id: 7 }] }), [1, 2, 3, 4]);
  assert.deepEqual(pick({ selectedChapterIds: [8, 9] }), [1, 2, 3, 4]);
  assert.deepEqual(pick({ filteredChapters: [] }), [1, 2, 3, 4]); // [] is truthy but is no range
  assert.deepEqual(pick({ filteredChapters: [{ id: 4 }] }), [4]);
  assert.deepEqual(pick({}), [1, 2, 3, 4]);
});

test('the quick range overwrites an older selection from the chapters section', async () => {
  const chapter = id => ({ id, volume: '1', number: String(id), name: '' });
  const data = { 'titleData:s': { chapters: [1, 2, 3, 4].map(chapter), selectedChapterIds: [1, 4], metadata: {} } };
  const info = { slug: 's', chapters: [1, 2, 3, 4].map(chapter), allChapters: [1, 2, 3, 4].map(chapter) };
  await quickContext(data).startQuickDownload({ info, fromIdx: 1, toIdx: 2, tabId: 1, url: 'https://mangalib.me/ru/manga/s', format: 'cbz' });
  assert.deepEqual(data['titleData:s'].selectedChapterIds, [2, 3]);
  assert.deepEqual(data['titleData:s'].filteredChapters.map(ch => ch.id), [2, 3]);
});

test('the range card selects exactly rangeChapterIds over all chapters, volume cards count all chapters of the volume', () => {
  const chapters = source('src/editors/chapters.js');
  assert.match(functionSource('src/editors/chapters.js', 'initRangeCard'), /rangeChapterIds[(]uniqueChapters/);
  assert.match(chapters, /displayChapters = allChapters;/);
  assert.doesNotMatch(chapters, /displayChapters = result[.]titleData\[currentSlug\][.]filteredChapters/);
  assert.match(functionSource('src/editors/chapters.js', 'updateVolumeHeader'), /volumeChapters[.]get[(]key[)]/); // the whole volume, not only rendered rows
  assert.match(source('src/html/chapters.html'), /id="range-from"[\s\S]*id="range-to"[\s\S]*id="translator-list"/);
});

test('the image server select lives in the images group with the preparation window’s values and storage key, for manga only', () => {
  const settings = source('src/core/settings.js');
  assert.match(settings, /images: \[[^\]]*'imageServer'/);
  const html = source('src/html/settings.html');
  assert.match(html, /<div class="panel" data-group="images">[\s\S]*id="image-server-field"[\s\S]*<option value="normal">Оригиналы<\/option>\s*<option value="compressed" selected>Сжатые<\/option>[\s\S]*data-group="toc"/);
  assert.match(html, /id="image-server-field" data-site-type="manga"/);
});

test('settings follow the site type: image server, same width and CBZ/ZIP for manga; PDF text and TXT for ranobe; all when the type is unknown', () => {
  const html = source('src/html/settings.html');
  const marked = type => [...html.matchAll(new RegExp(String.raw`data-site-type="${type}">[\s\S]*?(?:<label for="([\w-]+)"|id="([\w-]+)"|<span>([^<]+)</span>)`, 'g'))].map(m => m[1] || m[2] || m[3]);
  assert.deepEqual(marked('manga'), ['image-server', 'same-width', 'CBZ/ZIP']);
  assert.deepEqual(marked('ranobe'), ['pdf-font', 'pdf-font-size', 'pdf-page-size', 'pdf-line-spacing', 'pdf-paragraph-spacing', 'TXT']);
  const els = ['manga', 'ranobe', 'manga'].map(siteType => ({ dataset: { siteType }, classes: new Set(['hidden']), classList: { toggle(name, on) { on ? this.owner.classes.add(name) : this.owner.classes.delete(name); } } }));
  els.forEach(el => { el.classList.owner = el; });
  const ctx = vm.createContext({ document: { querySelectorAll: selector => selector === '[data-site-type]' ? els : [] } });
  vm.runInContext(functionSource('src/core/settings.js', 'applySiteFilter'), ctx);
  ctx.applySiteFilter(undefined);
  assert.deepEqual(els.map(el => el.classes.has('site-hidden')), [false, false, false]);
  ctx.applySiteFilter('ranobe');
  assert.deepEqual(els.map(el => [...el.classes]), [['hidden', 'site-hidden'], ['hidden'], ['hidden', 'site-hidden']]); // the section's own hidden is left alone
  ctx.applySiteFilter('manga');
  assert.deepEqual(els.map(el => el.classes.has('site-hidden')), [false, true, false]);
  assert.match(source('src/css/settings.css'), /\.site-hidden \{\s*display: none !important;/);
});

test('saveCovers leaves out empty covers from «Новая обложка» until a URL or a file is set, and metadata.cover follows the saved ones', async () => {
  const writes = [];
  const stored = { s: { metadata: { cover: 'old' }, covers: [] } };
  const ctx = vm.createContext({
    currentSlug: 's',
    userCovers: [{ url: 'https://x/a.jpg', type: 'url' }, { url: '', type: 'url' }, { url: 'b.png', dataUrl: 'data:image/png;base64,AA', type: 'file' }, { url: '', dataUrl: null, type: 'url' }],
    getTitleStore: async () => ({ titleData: structuredClone(stored) }),
    setTitleStore: async items => { writes.push(items); }
  });
  vm.runInContext(functionSource('src/editors/covers.js', 'saveCovers') + '\nthis.saveCovers = saveCovers;', ctx);
  await ctx.saveCovers();
  assert.deepEqual(jsonCopy(writes[0].titleData.s.covers.map(cover => cover.url)), ['https://x/a.jpg', 'b.png']);
  assert.equal(writes[0].titleData.s.metadata.cover, 'https://x/a.jpg');
  vm.runInContext("userCovers = [{ url: '', dataUrl: 'data:image/png;base64,AA', type: 'file' }, { url: '', type: 'url' }];", ctx);
  await ctx.saveCovers();
  assert.equal(writes[1].titleData.s.covers.length, 1);
  assert.equal(writes[1].titleData.s.metadata.cover, 'data:image/png;base64,AA');
});

test('saveMetadata does not write fieldLabels until they have been loaded, so a save in between cannot wipe the saved ones', async () => {
  const writes = [];
  const ctx = vm.createContext({
    currentSlug: 's', metadataFields: {}, tempFieldLabels: {}, fieldLabelsLoaded: false,
    document: { getElementById: () => ({ value: 'v' }) },
    getTitleStore: async () => ({ titleData: { s: { metadata: { cover: 'c' }, covers: [] } } }),
    setTitleStore: async items => { writes.push(items); }
  });
  vm.runInContext(functionSource('src/editors/metadata.js', 'saveMetadata') + '\nthis.saveMetadata = saveMetadata;', ctx);
  await ctx.saveMetadata();
  assert.equal(writes[0].titleData.s.metadata.titleRu, 'v'); // the typed value is still saved
  assert.equal(writes[0].titleData.s.metadata.cover, 'c');
  assert.ok(!('fieldLabels' in writes[0]));
  vm.runInContext("fieldLabelsLoaded = true; tempFieldLabels = { author: 'Автор книги' };", ctx);
  await ctx.saveMetadata();
  assert.deepEqual(jsonCopy(writes[1].fieldLabels), { author: 'Автор книги' });
  assert.match(source('src/editors/metadata.js'), /originalFieldLabels = [{] [.][.][.]\(labelResult[.]fieldLabels \|\| {}\) [}];\s*tempFieldLabels = [{] [.][.][.]originalFieldLabels [}];\s*fieldLabelsLoaded = true;/);
});

// ---- v2.0.0: обновления по релизам GitHub ----

function updateCheckContext(release, { status = 200, userAgent = 'Chrome' } = {}) {
  const calls = { tabs: [], downloads: [], fetched: [] };
  const context = vm.createContext({
    AbortController, setTimeout, clearTimeout, navigator: { userAgent },
    fetch: async url => { calls.fetched.push(url); return { ok: status === 200, status, json: async () => release }; },
    chrome: { tabs: { create: ({ url }) => calls.tabs.push(url) }, downloads: { download: async ({ url }) => { calls.downloads.push(url); } } }
  });
  vm.runInContext(source('src/utils/update-check.js'), context);
  return { ctx: context, calls };
}

test('update check: the tag of the latest release is compared with the manifest version, assets come only from the repository', async () => {
  const assets = [
    { name: 'LibSaver-v2.1.0.zip', browser_download_url: 'https://github.com/Laynholt/LibSaver/releases/download/v2.1.0/LibSaver-v2.1.0.zip' },
    { name: 'LibSaver-v2.1.0-firefox.zip', browser_download_url: 'https://github.com/Laynholt/LibSaver/releases/download/v2.1.0/LibSaver-v2.1.0-firefox.zip' },
    { name: 'evil.xpi', browser_download_url: 'https://evil.example/evil.xpi' }
  ];
  const { ctx, calls } = updateCheckContext({ tag_name: 'v2.1.0', assets });
  const release = jsonOf(await ctx.fetchLatestRelease());
  assert.equal(calls.fetched[0], 'https://api.github.com/repos/Laynholt/LibSaver/releases/latest');
  assert.deepEqual(release, { version: '2.1.0', page: 'https://github.com/Laynholt/LibSaver/releases/latest', zip: assets[0].browser_download_url });
  assert.equal(ctx.compareVersions('2.1.0', '2.0.0'), 1);
  assert.equal(ctx.compareVersions('2.0', '2.0.0'), 0);
  assert.equal(ctx.compareVersions('1.7', '2.0.0'), -1);
  ctx.openUpdate(release);
  assert.deepEqual(calls.downloads, [assets[0].browser_download_url]);
  assert.deepEqual(calls.tabs, ['https://github.com/Laynholt/LibSaver/releases/latest']);
});

test('update check: no releases or a tag that is not a version is an error, Firefox opens a signed xpi', async () => {
  await assert.rejects(updateCheckContext({}, { status: 404 }).ctx.fetchLatestRelease(), { message: 'HTTP 404' });
  await assert.rejects(updateCheckContext({ tag_name: 'nightly' }).ctx.fetchLatestRelease(), { message: 'Нет версии в релизе' });
  const xpi = 'https://github.com/Laynholt/LibSaver/releases/download/v2.1.0/libsaver.xpi';
  const { ctx, calls } = updateCheckContext({ tag_name: 'v2.1.0', assets: [{ name: 'libsaver.xpi', browser_download_url: xpi }] }, { userAgent: 'Mozilla/5.0 Firefox/130.0' });
  ctx.openUpdate(await ctx.fetchLatestRelease());
  assert.deepEqual([calls.tabs, calls.downloads], [[xpi], []]);
});

test('«Сообщить о проблеме» opens the issue form of the 2.x repository with version, title page and browser filled in', async () => {
  const ctx = vm.createContext({
    URLSearchParams, LIBSAVER_REPO: 'Laynholt/LibSaver', navigator: { userAgent: 'UA 1' },
    chrome: { storage: { local: { get: async () => ({ sourceUrl: 'https://mangalib.me/ru/manga/1--a' }) } }, runtime: { getManifest: () => ({ version: '2.0.0' }) } }
  });
  vm.runInContext(functionSource('src/core/settings.js', 'buildIssueUrl'), ctx);
  const url = new URL(await ctx.buildIssueUrl());
  assert.equal(url.origin + url.pathname, 'https://github.com/Laynholt/LibSaver/issues/new');
  assert.deepEqual(Object.fromEntries(url.searchParams), { template: 'bug_report.yml', version: '2.0.0', page: 'https://mangalib.me/ru/manga/1--a', browser: 'UA 1' });
  const form = source('.github/ISSUE_TEMPLATE/bug_report.yml');
  for (const id of ['version', 'page', 'browser']) assert.match(form, new RegExp(`id: ${id}\r?\n`));
});

test('ranobe PDF draws characters missing from the chosen font with the first fallback font that has them, embedding only the fonts it needs', async () => {
  const charsets = { 'assets/fonts/NanumGothic-Regular.ttf': '아나도,', 'assets/fonts/DroidSansFallbackFull.ttf': '中文,' };
  const fakeFont = chars => ({ chars, getCharacterSet: () => [...chars].map(char => char.codePointAt(0)), widthOfTextAtSize: (text, size) => [...text].length * size });
  const decode = bytes => new TextDecoder().decode(bytes);
  const encoded = async url => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(url).buffer });
  const fetched = [];
  const embedded = [];
  const ctx = vm.createContext({
    BaseFormatter: class { constructor(options) { this.options = options; } }, Uint8Array, chrome: { runtime: { getURL: p => p } },
    fontkit: { create: bytes => ({ characterSet: fakeFont(charsets[decode(bytes)]).getCharacterSet() }) },
    fetch: url => { fetched.push(url); return encoded(url); }
  });
  vm.runInContext(source('src/formatters/pdf.js') + ';this.Formatter = PdfFormatter;', ctx);
  const formatter = new ctx.Formatter({});
  const main = fakeFont('Ах ты~(),! ');
  /* whole font, no options: subset loses Droid's Japanese glyphs */
  const pdfDoc = { embedFont: async (bytes, options) => { assert.equal(options, undefined); embedded.push(decode(bytes)); return fakeFont(charsets[decode(bytes)]); } };
  formatter.fallbackFonts = vm.runInContext('PDF_FALLBACK_FONTS', ctx).map(path => ({ path }));
  formatter.fontChars = new Map();
  await formatter.loadFallbackFontsFor(pdfDoc, 'Ах ты~', [main], () => {});
  assert.deepEqual(fetched, []); // nothing missing - no extra font in the PDF
  await formatter.loadFallbackFontsFor(pdfDoc, 'Ах (아, 나도!)', [main], () => {});
  assert.deepEqual([fetched, embedded], [['assets/fonts/NanumGothic-Regular.ttf'], ['assets/fonts/NanumGothic-Regular.ttf']]); // Korean only: Droid is not even read
  await formatter.loadFallbackFontsFor(pdfDoc, 'Ах 中文 \u{1F600}', [main], () => {});
  assert.deepEqual(embedded, ['assets/fonts/NanumGothic-Regular.ttf', 'assets/fonts/DroidSansFallbackFull.ttf']);
  const runs = formatter.textRuns('Ах (아, 中文!) \u{1F600}', main);
  assert.deepEqual(jsonCopy(runs.map(run => [run.text, run.font.chars === main.chars ? 'main' : run.font.chars])), [['Ах (', 'main'], ['아', '아나도,'], [', ', 'main'], ['中文', '中文,'], ['!) \u{1F600}', 'main']]); // the emoji is in no font
  const drawn = [];
  formatter.drawTextRuns({ drawText: (text, options) => drawn.push([text, options.x]) }, 'Ах 아', { x: 10, size: 2, font: main });
  assert.deepEqual(jsonCopy(drawn), [['Ах ', 10], ['아', 16]]);
  assert.equal(formatter.textWidth('Ах 아', 2, main), 8);
  // a missing font file leaves those characters as before, says so in the log once, and the next font is still tried
  const logs = [];
  formatter.fallbackFonts = [{ path: 'gone.ttf' }, { path: 'assets/fonts/DroidSansFallbackFull.ttf' }];
  ctx.fetch = url => url === 'gone.ttf' ? Promise.resolve({ ok: false, status: 404 }) : encoded(url);
  await formatter.loadFallbackFontsFor(pdfDoc, '아中', [main], message => logs.push(message));
  await formatter.loadFallbackFontsFor(pdfDoc, '아', [main], message => logs.push(message));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /gone\.ttf.*HTTP 404/);
  assert.deepEqual(jsonCopy(formatter.textRuns('아中', main).map(run => run.text)), ['아', '中']);
});

test('settings tab mode stretches panels to the column even on a window from 1000px, where .container is a start-aligned grid', () => {
  const css = source('src/css/settings.css');
  assert.match(css, /@media \(min-width: 1000px\) \{\s*\.container \{[^}]*align-items: start/);
  assert.match(css, /body\.tab-mode \.container \{[^}]*align-items: stretch/);
});
