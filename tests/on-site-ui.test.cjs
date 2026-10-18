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
  vm.runInContext(source('src/utils/engine-client.js'), ctx);
  for (const name of ['showDownloadsView', 'enqueueAndShow']) vm.runInContext(functionSource('src/core/prepare.js', name), ctx);
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
  const pages = { 'src/html/popup.html': 'src/core/popup.js', 'src/html/chapters.html': 'src/editors/chapters.js', 'src/html/prepare.html': 'src/core/prepare.js', 'src/html/quick.html': 'src/core/quick.js' };
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
  const ctx = {
    console, URL, URLSearchParams, stored, listeners,
    location: { href: 'https://mangalib.me/ru/manga/123--title', origin: 'https://mangalib.me' },
    chrome: {
      runtime: { id: 'id', getURL: file => 'chrome-extension://id/' + file, sendMessage: async () => ({}) },
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
  ctx.ensureButtons(narrow, 'https://ranobelib.me/ru/book/y');
  assert.equal(narrow.grid.children[1].style.gridColumn, '1 / -1');
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
  assert.equal(url.href.split('?')[0], 'chrome-extension://id/html/workspace.html');
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

test('site-ui content script is registered for the four sites, with its stylesheet, font and iframe pages exposed', () => {
  const manifest = JSON.parse(source('src/manifest.json'));
  const script = manifest.content_scripts[1];
  const notAnime = match => !/anilib|animelib/.test(match);
  assert.deepEqual(script.js, ['core/theme.js', 'utils/page-call.js', 'utils/formats.js', 'content/site-ui.js']);
  assert.deepEqual(script.matches, manifest.content_scripts[0].matches.filter(notAnime));
  for (const resource of ['css/site-ui.css', 'html/workspace.html', 'html/panel.html', 'html/quick.html', 'libs/fontawesome/webfonts/fa-solid-900.woff2']) {
    assert.ok(manifest.web_accessible_resources[0].resources.includes(resource), resource);
  }
});

test('whoami answers with the sender tab id and url', () => {
  const ctx = vm.createContext({ chrome: {}, console });
  vm.runInContext(functionSource('src/background.js', 'handleEngineMessage'), ctx);
  let answer;
  ctx.handleEngineMessage({ action: 'whoami' }, { tab: { id: 5, url: 'https://mangalib.me/ru/manga/x' } }, response => { answer = JSON.parse(JSON.stringify(response)); });
  assert.deepEqual(answer, { tabId: 5, url: 'https://mangalib.me/ru/manga/x' });
});

// ---- Task 8: quick «Скачать» popover ----

test('format options are one list per site type, shared by the preparation window, the quick popover and the buttons', () => {
  const ctx = vm.createContext({ console });
  vm.runInContext(['src/utils/formats.js', 'src/core/title-loader.js', 'src/core/quick.js'].map(source).join('\n'), ctx);
  const values = siteKey => Array.from(ctx.quickFormatOptions(siteKey), option => option.value);
  assert.ok(!values('ranobelib').includes('cbz'));
  assert.deepEqual(values('ranobelib'), ['epub', 'fb2', 'pdf', 'txt', 'html']);
  for (const siteKey of ['mangalib', 'hentailib', 'shlib']) {
    assert.ok(!values(siteKey).includes('fb2') && !values(siteKey).includes('txt'), siteKey);
    assert.deepEqual(values(siteKey), ['cbz', 'zip', 'pdf', 'epub', 'html']);
  }
  assert.deepEqual([ctx.defaultFormatFor('manga'), ctx.defaultFormatFor('ranobe'), ctx.defaultFormatFor('anime')], ['cbz', 'epub', 'mkv']);
  assert.deepEqual([ctx.formatKeyFor('manga'), ctx.formatKeyFor('ranobe')], ['selectedFormat_manga', 'selectedFormat_ranobe']);
  assert.doesNotMatch(source('src/core/prepare.js'), /value: 'cbz'/);
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
  vm.runInContext(['src/utils/title-store.js', 'src/utils/page-call.js', 'src/core/chapter-range.js', 'src/utils/formats.js', 'src/core/title-loader.js', 'src/core/quick.js'].map(source).join('\n'), ctx);
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

test('the quick window writes siteType and sourceUrl before loading, like popup, and forwards force', async () => {
  const data = {};
  const ctx = quickContext(data);
  const seen = [];
  ctx.loadTitleData = async args => { seen.push([data.siteType, data.sourceUrl, args.tabId, args.url, args.force]); return { slug: 's' }; };
  const url = 'https://ranobelib.me/ru/book/7--y';
  assert.deepEqual(await ctx.loadQuickTitle({ tabId: 3, url }), { slug: 's' });
  await ctx.loadQuickTitle({ tabId: 3, url, force: true });
  assert.deepEqual(seen, [['ranobe', url, 3, url, false], ['ranobe', url, 3, url, true]]);
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
  assert.deepEqual([data['titleData:7--y'].fromIdx, data['titleData:7--y'].toIdx], [1, 2]);
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
  const prepareScripts = [...source('src/html/prepare.html').matchAll(/<script src="\.\.\/([^"]+)"/g)].map(m => m[1]);
  for (const shared of ['utils/formats.js', 'utils/engine-client.js']) {
    assert.ok(prepareScripts.includes(shared) && prepareScripts.indexOf(shared) < prepareScripts.indexOf('core/prepare.js'), shared);
  }
  assert.doesNotMatch(source('src/core/prepare.js'), /function enqueueSnapshot/);
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

test('popover frame messages: «Подробнее…» closes the popover and opens the settings window on that section; resize takes numbers only', () => {
  const ctx = siteUiContext();
  const log = [];
  ctx.closePopover = () => log.push('close');
  ctx.openSettings = section => log.push(['settings', section]);
  ctx.resizePopover = height => log.push(['resize', height]);
  const handlers = vm.runInContext('popoverMessageHandlers', ctx); // const: not a property of the context
  handlers.openPanel({ section: 'chapters' });
  handlers.close();
  handlers.resize({ height: 180 });
  handlers.resize({ height: 'tall' });
  handlers.resize({});
  assert.deepEqual(log, ['close', ['settings', 'chapters'], 'close', ['resize', 180]]);
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
  const embedder = (me, tab) => JSON.parse(JSON.stringify(ctx.quickEmbedder(me, tab)));
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
  assert.match(start, /quickEmbedder\(me, params\.get\('tab'\)\)/);
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
  vm.runInContext(['src/utils/title-store.js', 'src/utils/page-call.js', 'src/core/chapter-range.js', 'src/utils/formats.js', 'src/core/title-loader.js', 'src/core/quick.js'].map(source).join('\n'), ctx);
  // startQuick is waiting for whoami: swap the loader before it answers
  ctx.loadTitleData = async args => { loads.push(JSON.parse(JSON.stringify(args))); return { chapters: [] }; };
  return { element, data, loads, posted, settle: () => new Promise(resolve => setTimeout(resolve, 5)) };
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
  assert.deepEqual(text(stateOf(queueEntry('running', { progress: { current: 9, total: 20 } }))), { title: 'Title A', detail: '45%' });
  assert.deepEqual(text(stateOf(queueEntry('running', { progress: { current: 9, total: 20 } }), queueEntry('queued', { slug: 'b' }), queueEntry('queued', { slug: 'c' }))), { title: 'Title A', detail: '45% · +2 в очереди' });
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
    const port = { name: options.name, disconnected: false, disconnect() { this.disconnected = true; }, onMessage: { addListener: fn => { port.receive = fn; } }, onDisconnect: { addListener: fn => { port.drop = fn; } } };
    link.ports.push(port);
    return port;
  };
  ctx.setTimeout = (fn, ms) => { link.timers.push({ fn, ms }); return link.timers.length; };
  ctx.clearTimeout = () => {};
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
  // a state from the engine gives a fresh count
  const healthy = engineLinkContext();
  await healthy.ctx.connectEngine();
  healthy.link.ports[0].receive({ type: 'state', state: stateOf() });
  assert.equal(healthy.link.failures(), 0);
  healthy.ctx.retryEngine(); // not exhausted: nothing happens
  assert.equal(healthy.link.messages.length, 1);
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

test('the plaque click opens the downloads page in the overlay (until the new window in Task 10)', () => {
  const ctx = siteUiContext();
  const opened = [];
  ctx.openOverlay = src => opened.push(src);
  ctx.openDownloads();
  assert.deepEqual(opened, ['chrome-extension://id/html/downloads.html']);
});

test('the site name map lives in page-call.js and the downloads view no longer carries its own copy', () => {
  assert.match(source('src/utils/page-call.js'), /const SITE_NAMES = /);
  assert.doesNotMatch(source('src/core/downloads-view.js'), /const SITE_NAMES/);
});
