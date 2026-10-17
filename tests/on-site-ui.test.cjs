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
    items: [{ id: 'a', slug: 'a', siteKey: 'mangalib', title: 'T a', format: 'cbz', status: 'waiting-decision', progress: { current: 1, total: 2 }, decision: { kind: 'chapter', chapterTitle: 'Г1', message: 'boom' } }],
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
    'formatters/base.js', 'formatters/epub.js', 'formatters/txt.js', 'formatters/pdf.js', 'formatters/html.js', 'formatters/fb2.js', 'formatters/cbz.js', 'formatters/index.js', 'core/download.js', 'engine/queue.js', 'engine/engine.js']);
  // code only: template literals (html.js builds the reader page's script in one) and line comments are text
  const code = file => source('src/' + file).replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``').replace(/^\s*\/\/.*$/gm, '');
  for (const file of scripts.filter(file => file !== 'utils/page-call.js' && file !== 'engine/engine.js')) {
    assert.doesNotMatch(code(file), /chrome\.storage|chrome\.tabs\.|chrome\.scripting|chrome\.downloads|document\.getElementById/, file);
  }
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
    const html = view.renderQueueItem(queueItem({ status, decision: { kind: 'chapter', chapterTitle: '', message: '' } }));
    assert.deepEqual(cmds(html), commands, status);
    assert.equal((html.match(/data-id="a"/g) || []).length, commands.length, status);
  }
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
  let attempts = 0;
  const ctx = vm.createContext({
    console: { error() {}, log() {} }, setTimeout: (fn, ms) => { delays.push(ms); fn(); return 0; },
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
  return { ctx, element, ports, created, stored, delays, seenWhileRetrying, storageListeners };
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

// --- «Подготовка» as a client of the queue ---

function prepareClient({ reply, disconnectInstead = false }) {
  const calls = [];
  const toasts = [];
  const elements = {};
  const clone = value => JSON.parse(JSON.stringify(value));
  const element = id => elements[id] ||= { attrs: {}, style: {}, classes: new Set(['collapsed']), getAttribute(name) { return this.attrs[name] ?? null; }, setAttribute(name, value) { this.attrs[name] = value; }, classList: { remove: name => elements[id].classes.delete(name) } };
  const port = { posted: [], disconnected: false, disconnect() { this.disconnected = true; }, onMessage: { addListener: fn => { port.receive = fn; } }, onDisconnect: { addListener: fn => { port.drop = fn; } },
    postMessage(message) { this.posted.push(clone(message)); Promise.resolve().then(() => disconnectInstead ? port.drop() : port.receive({ type: 'enqueueResult', ...reply })); } };
  const ctx = vm.createContext({
    document: { getElementById: element },
    showToast: (message, type) => toasts.push([message, type]),
    chrome: { runtime: { sendMessage: async message => { calls.push(['sendMessage', clone(message)]); return true; }, connect: options => { calls.push(['connect', options.name]); return port; } } }
  });
  for (const name of ['enqueueSnapshot', 'showDownloadsView', 'enqueueAndShow']) vm.runInContext(functionSource('src/core/prepare.js', name), ctx);
  return { ctx, calls, toasts, port, element };
}

test('«Скачать» enqueues the snapshot in the engine and shows the downloads view', async () => {
  const { ctx, calls, toasts, port, element } = prepareClient({ reply: { ok: true } });
  await ctx.enqueueAndShow({ id: 'x' });
  assert.deepEqual(calls, [['sendMessage', { action: 'ensureEngine' }], ['connect', 'libsaver-engine']]);
  assert.deepEqual(port.posted, [{ cmd: 'enqueue', snapshot: { id: 'x' } }]);
  assert.equal(port.disconnected, true);
  assert.equal(element('downloads-frame').getAttribute('src'), 'downloads.html');
  assert.equal(element('zone-downloads').style.display, 'flex');
  assert.equal(element('zone-downloads').classes.has('collapsed'), false);
  assert.deepEqual(toasts, []);
});

test('a title that is already queued gets a toast and the downloads view is still shown', async () => {
  const { ctx, toasts, element } = prepareClient({ reply: { ok: false, reason: 'already-queued' } });
  await ctx.enqueueAndShow({ id: 'x' });
  assert.deepEqual(toasts, [['Этот тайтл уже в очереди', 'info']]);
  assert.equal(element('downloads-frame').getAttribute('src'), 'downloads.html');
});

test('other rejections and a missing engine surface as errors', async () => {
  await assert.rejects(prepareClient({ reply: { ok: false, reason: 'queue-full' } }).ctx.enqueueAndShow({ id: 'x' }), /queue-full/);
  await assert.rejects(prepareClient({ disconnectInstead: true }).ctx.enqueueAndShow({ id: 'x' }), /Движок загрузки/);
});

test('the preparation window no longer runs, renders or saves downloads itself', () => {
  assert.doesNotMatch(source('src/core/prepare.js'), /startDownload|runDownload|saveAs\(|downloadControl|setDownloadListener|addLogToContainer|renderStats/);
  const html = source('src/html/prepare.html');
  assert.doesNotMatch(html, /download\.js|formatters\/|jszip|pica|FileSaver|id="log"|id="btn-pause"|stats-time/);
  assert.match(html, /<iframe id="downloads-frame"/);
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
});

test('prepare follows the shared «Ускорить» flag and its snapshot takes the flag from storage', async () => {
  const checkbox = { checked: false };
  const ctx = vm.createContext({ document: { getElementById: id => id === 'speed-mode-checkbox' ? checkbox : null } });
  vm.runInContext(functionSource('src/core/prepare.js', 'followSpeedMode'), ctx);
  ctx.followSpeedMode({ speedMode: { newValue: true } });
  assert.equal(checkbox.checked, true);
  ctx.followSpeedMode({ imageQuality: { newValue: 'HD' } });
  assert.equal(checkbox.checked, true); // unrelated changes leave it alone
  assert.match(source('src/core/prepare.js'), /if \(areaName === 'local'\) \{\s*followSpeedMode\(changes\);/);
  // no value from the (possibly stale) checkbox: the snapshot reads storage itself
  const text = source('src/core/prepare.js');
  const handler = text.slice(text.indexOf("btnDownload.addEventListener('click'"), text.indexOf("document.querySelectorAll('.volume-header')"));
  assert.match(handler, /buildDownloadSnapshot/);
  assert.doesNotMatch(handler, /speedMode/);
  const snapshot = await snapshotContext({ speedMode: true, 'titleData:s': { metadata: { titleRu: 'T' } }, 'originalTitleData:s': { metadata: {} } })
    .buildDownloadSnapshot({ slug: 's', tabId: 5, sourceUrl: 'https://mangalib.me/ru/manga/s', selectedChapterIds: [1], format: 'cbz', imageServer: 'normal', textOnly: false });
  assert.equal(snapshot.stored.speedMode, true);
});
