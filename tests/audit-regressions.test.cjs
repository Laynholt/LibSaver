const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
// Scripts are globals loaded by extension HTML; isolate their actual handlers without Chrome/network access.
function between(file, start, end) {
  const text = source(file);
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing source boundary: ${file}: ${start}`);
  return text.slice(from, to);
}
function functionSource(file, name) {
  const text = source(file);
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(text);
  assert.ok(match, `Missing function: ${name}`);
  return text.slice(match.index, text.indexOf('\n}', match.index) + 2);
}
// Как chrome.storage.local: отсутствующие ключи не возвращаются, get(null) отдаёт всё
function storageApi(data) {
  return {
    get: async keys => structuredClone(keys === null ? data : Object.fromEntries([].concat(keys).filter(key => key in data).map(key => [key, data[key]]))),
    set: async values => Object.assign(data, structuredClone(values)),
    remove: async keys => { for (const key of [].concat(keys)) delete data[key]; }
  };
}
const titleStore = source('src/utils/title-store.js');
function epub() {
  const context = vm.createContext({ crypto, console });
  vm.runInContext(source('src/formatters/base.js') + source('src/formatters/epub.js') + '\nthis.Formatter = EpubFormatter;', context);
  const formatter = Object.create(context.Formatter.prototype);
  formatter.options = {};
  formatter.zip = { files: {} };
  const files = {};
  const folder = { file: (name, content) => files[name] = content };
  return { formatter, files, folder };
}

for (const status of [429, 503]) {
  for (const target of ['base', 'background', 'download']) {
    test(`${target}: HTTP ${status} retries always wait and remain bounded`, async () => {
      const delays = [];
      let requests = 0;
      const context = vm.createContext({
        console: { log() {} },
        fetch: async () => { requests++; return { ok: false, status, statusText: 'test failure' }; },
        setTimeout: (fn, delay) => { delays.push(delay); fn(); },
        checkPause: async () => {}, trackRequest: async () => {}, addLog() {}, handleRateLimitError() {}
      });
      if (target === 'base') {
        vm.runInContext(source('src/formatters/base.js') + '\nthis.Formatter = BaseFormatter;', context);
        await assert.rejects(new context.Formatter({}).fetchWithRetry('https://example.invalid'));
      } else if (target === 'background') {
        vm.runInContext(functionSource('src/background.js', 'directFetch'), context);
        let result;
        await context.directFetch({ url: 'https://example.invalid' }, value => result = value);
        assert.equal(result.success, false);
      } else {
        vm.runInContext(functionSource('src/core/download.js', 'fetchWithRetry'), context);
        await assert.rejects(context.fetchWithRetry('https://example.invalid'));
      }
      assert.equal(requests, 6);
      assert.deepEqual(delays, target === 'download' ? [3000, 5000, 8000, 8000, 8000] : [5000, 10000, 15000, 15000, 15000]);
    });
  }
}

test('EPUB escapes user text in package, navigation, metadata and captions', async () => {
  const { formatter, files, folder } = epub();
  const text = 'A & B <C> "D"';
  const escaped = 'A &amp; B &lt;C&gt; &quot;D&quot;';
  const chapters = [{ file: 'chapter_1.xhtml', title: text }];
  formatter.options.fieldLabels = { author: text };
  formatter.generateOpf(folder, chapters, { titleRu: text, author: text });
  formatter.generateNcx(folder, chapters, { titleRu: text });
  formatter.addTocPage(folder, chapters);
  formatter.addInfoPage(folder, { titleRu: text, author: text, description: text + '\nSecond line' });
  for (const name of ['content.opf', 'nav.xhtml', 'toc.ncx', 'toc.xhtml', 'info.xhtml']) {
    assert.ok(files[name].includes(escaped), `${name} must escape text`);
    assert.ok(!files[name].includes(text), `${name} contains raw text`);
  }
  assert.ok(files['info.xhtml'].includes(escaped + '<br/>Second line'));
  formatter.options.quality = 'NONE';
  const caption = await formatter.convertJsonToHtml({ type: 'image', attrs: { description: text } });
  assert.ok(caption.includes(escaped));
});

test('EPUB assigns unique IDs and exactly one primary cover', () => {
  const { formatter, files, folder } = epub();
  formatter.zip.files = { 'OEBPS/images/cover-1.jpg': {}, 'OEBPS/images/cover-2.jpg': {} };
  formatter.generateOpf(folder, [], { titleRu: 'Test' });
  const items = [...files['content.opf'].matchAll(/<item id="([^"]+)"[^>]*>/g)];
  assert.equal(new Set(items.map(item => item[1])).size, items.length);
  assert.equal(items.filter(item => item[0].includes('properties="cover-image"')).length, 1);
  const mainCover = items.find(item => item[0].includes('properties="cover-image"'))[1];
  assert.ok(files['content.opf'].includes(`<meta name="cover" content="${mainCover}"`));
});

test('switching titles removes the previous title unless cleanup on title change is off', async () => {
  for (const cleanupOnTitleChange of [undefined, false]) {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const data = { currentSlug: 'old', 'titleData:old': { metadata: { titleRu: 'Edited' }, cacheTimestamp: twoHoursAgo }, 'originalTitleData:old': { chapters: [] }, 'titleData:new': { covers: ['local'] } };
    if (cleanupOnTitleChange === false) data.cleanupOnTitleChange = false;
    const before = structuredClone(data);
    const context = vm.createContext({ chrome: { storage: { local: storageApi(data) } } });
    vm.runInContext(titleStore + functionSource('src/core/title-loader.js', 'switchCurrentTitle'), context);
    await context.switchCurrentTitle('new');
    const kept = cleanupOnTitleChange === false;
    assert.deepEqual(data['titleData:old'], kept ? before['titleData:old'] : undefined);
    assert.deepEqual(data['originalTitleData:old'], kept ? before['originalTitleData:old'] : undefined);
    assert.deepEqual(data['titleData:new'], before['titleData:new']);
    assert.equal(data.currentSlug, 'new');
  }
});

test('switching titles keeps a previous title touched within the last hour (another tab may be editing it)', async () => {
  const data = { currentSlug: 'old', 'titleData:old': { metadata: { titleRu: 'Edited' }, cacheTimestamp: Date.now() - 50 * 60 * 1000 }, 'originalTitleData:old': { chapters: [] } };
  const before = structuredClone(data);
  const context = vm.createContext({ chrome: { storage: { local: storageApi(data) } } });
  vm.runInContext(titleStore + functionSource('src/core/title-loader.js', 'switchCurrentTitle'), context);
  await context.switchCurrentTitle('new');
  assert.deepEqual(data['titleData:old'], before['titleData:old']);
  assert.deepEqual(data['originalTitleData:old'], before['originalTitleData:old']);
  assert.equal(data.currentSlug, 'new');
});

test('loading a title removes titles older than 7 days unless that cleanup is off', async () => {
  for (const cleanupOldTitles of [undefined, false]) {
    const data = { 'titleData:old': { cacheTimestamp: 1 }, 'originalTitleData:old': {}, 'titleData:fresh': { cacheTimestamp: Date.now() } };
    if (cleanupOldTitles === false) data.cleanupOldTitles = false;
    const before = structuredClone(data);
    const context = vm.createContext({ console, chrome: { storage: { local: storageApi(data) } } });
    vm.runInContext(functionSource('src/core/title-loader.js', 'cleanupOldTitles'), context);
    await context.cleanupOldTitles();
    const kept = cleanupOldTitles === false;
    assert.deepEqual(data['titleData:old'], kept ? before['titleData:old'] : undefined);
    assert.deepEqual(data['originalTitleData:old'], kept ? before['originalTitleData:old'] : undefined);
    assert.deepEqual(data['titleData:fresh'], before['titleData:fresh']);
  }
});

test('saving title format clears stale generated titles and notifies consumers', async () => {
  const listeners = {};
  const timers = [];
  const messages = [];
  const data = { tocFormat: 'default', 'titleData:title': { chapters: [{ displayTitle: 'Old' }] } };
  const context = vm.createContext({
    defaultSiteLinks: {}, settingsGroups: null, console: { error() {} },
    setTimeout: fn => timers.push(fn), clearTimeout() {},
    document: { getElementById: id => ({ value: id === 'toc-format' ? 'custom' : '1', checked: false }), addEventListener: (type, fn) => (listeners[type] ||= []).push(fn) },
    window: { addEventListener() {} },
    chrome: { storage: { local: storageApi(data) }, runtime: { sendMessage: message => { messages.push(message); return Promise.resolve(); } } }
  });
  vm.runInContext(titleStore + source('src/utils/autosave.js'), context);
  vm.runInContext(between('src/core/settings.js', 'const SETTING_KEYS_BY_GROUP', '// Дефолтные значения по группам'), context);
  vm.runInContext('watchTocCommit(); enableAutosave({ save: saveSettings })', context);
  for (const fn of listeners.change) fn({ target: { id: 'toc-format' } }); // сохранение срабатывает от изменения поля, кнопки нет
  assert.equal(timers.length, 1);
  timers[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(data.tocFormat, 'custom');
  assert.equal(data['titleData:title'].chapters[0].displayTitle, undefined);
  assert.ok(messages.some(message => message.action === 'reformatChapters'));
});

function titleStoreContext(data) {
  const context = vm.createContext({ chrome: { storage: { local: storageApi(data) } } });
  vm.runInContext(titleStore, context);
  return context;
}

test('title store migrates the legacy shared objects into per-title keys', async () => {
  const data = {
    currentSlug: 'a',
    titleData: { a: { metadata: { titleRu: 'A' } }, b: { metadata: { titleRu: 'stale B' } } },
    originalTitleData: { a: { chapters: [1] } },
    'titleData:b': { metadata: { titleRu: 'newer B' } }
  };
  const result = await titleStoreContext(data).getTitleStore(['titleData', 'originalTitleData', 'currentSlug']);
  assert.deepEqual(structuredClone(result), { currentSlug: 'a', titleData: { a: { metadata: { titleRu: 'A' } } }, originalTitleData: { a: { chapters: [1] } } });
  assert.ok(!('titleData' in data) && !('originalTitleData' in data));
  assert.deepEqual(data['titleData:a'], { metadata: { titleRu: 'A' } });
  assert.deepEqual(data['titleData:b'], { metadata: { titleRu: 'newer B' } });
  assert.deepEqual(data['originalTitleData:a'], { chapters: [1] });
});

test('title store reads and writes only the requested title', async () => {
  const data = { currentSlug: 'a', 'titleData:a': { n: 1 }, 'titleData:b': { n: 2 }, siteType: 'manga' };
  const store = titleStoreContext(data);
  assert.deepEqual(structuredClone(await store.getTitleStore(['titleData', 'siteType'], 'b')), { siteType: 'manga', titleData: { b: { n: 2 } } });
  assert.deepEqual(structuredClone(await store.getTitleStore(['titleData', 'originalTitleData'])), { titleData: { a: { n: 1 } }, originalTitleData: {} });
  await store.setTitleStore({ titleData: { b: { n: 3 } }, originalTitleData: { b: { o: 1 } }, fromIdx: 4 });
  assert.deepEqual(data, { currentSlug: 'a', 'titleData:a': { n: 1 }, 'titleData:b': { n: 3 }, 'originalTitleData:b': { o: 1 }, siteType: 'manga', fromIdx: 4 });
  assert.deepEqual(structuredClone(await store.getAllTitleData()), { a: { n: 1 }, b: { n: 3 } });
  const change = { 'titleData:a': { newValue: { n: 5 } } };
  assert.equal(store.getTitleChange(change, 'titleData', 'a'), change['titleData:a']);
  assert.equal(store.getTitleChange(change, 'titleData', 'b'), undefined);
});

test('title data is only accessed through the title store, which every page using it loads', () => {
  const scripts = ['src/core/popup.js', 'src/core/panel.js', 'src/core/quick.js', 'src/core/download.js', 'src/core/settings.js',
    'src/editors/chapters.js', 'src/editors/covers.js', 'src/editors/metadata.js', 'src/formatters/cbz.js'];
  for (const file of scripts) {
    assert.doesNotMatch(source(file), /chrome\.storage\.local\.(get|set)\([^;]*\b(titleData|originalTitleData)\b/, file);
  }
  for (const page of fs.readdirSync(path.join(root, 'src/html')).filter(name => name.endsWith('.html'))) {
    const html = source(`src/html/${page}`);
    const firstUser = [...html.matchAll(/<script src="\.\.\/([^"]+)"/g)]
      .find(([, file]) => !file.includes('title-store') && /\b(getTitleStore|setTitleStore|getAllTitleData|getTitleChange)\(/.test(source(`src/${file}`)));
    if (firstUser) {
      const store = html.indexOf('utils/title-store.js');
      assert.ok(store >= 0 && store < firstUser.index, page);
    }
  }
});

test('title loader requests chapters, metadata and covers together without artificial waits', () => {
  const loader = source('src/core/title-loader.js');
  assert.match(loader, /Promise\.all\(\[\s*trackProgress\(loadChapters\(tabId\)\),\s*trackProgress\(loadMetadata\(tabId\)\),\s*trackProgress\(loadCovers\(tabId, urlSlug\)\)/);
  assert.doesNotMatch(loader, /await (loadChapters|loadMetadata|loadCovers)\(|setTimeout\(resolve|\b(fast|slowSmooth|ready|animate)Progress\(/);
  assert.doesNotMatch(source('src/core/popup.js'), /\b(loadChapters|loadMetadata|loadCovers)\(/);
});

// download.js целиком: он не трогает DOM, ход загрузки уходит событиями в listener
function downloadEvents() {
  const events = [];
  const context = vm.createContext({ console: { error() {}, log() {} }, window: {} });
  vm.runInContext(source('src/core/download.js') + '\nthis.downloadControl = downloadControl;', context);
  context.setDownloadListener(event => events.push(event));
  return { context, events };
}

for (const action of ['retry', 'skip']) {
  test(`image ${action} after a chapter error targets the image`, async () => {
    const { context } = downloadEvents();
    let decision = context.handleChapterError({ number: 1 }, new Error('chapter'), 0);
    context.downloadControl.retry();
    assert.equal((await decision).shouldRetry, true);
    decision = context.handleImageError({ number: 2 }, new Error('image'), 1, 'image');
    context.downloadControl[action]();
    assert.equal((await decision).shouldRetry, action === 'retry');
    assert.equal(vm.runInContext('skippedChapters.length', context), 0);
    decision = context.handleChapterError({ number: 3 }, new Error('chapter'), 2);
    context.downloadControl.retry();
    assert.equal((await decision).shouldRetry, true);
  });
}

function downloadHarness({ fail = false, partial = false, noDownloadData = false } = {}) {
  const timers = new Set();
  const logs = [];
  let saved = 0;
  const noop = () => {};
  // Снимок загрузки; без downloadData startDownload обязан упасть
  const snapshot = { stored: {}, titleExtras: {} };
  if (!noDownloadData) snapshot.downloadData = { slug: 'test', chapters: [{ id: 1 }, { id: 2 }], metadata: {}, selectedFormat: 'epub' };
  let thrown = null;
  const context = vm.createContext({
    console: { error: noop }, statsUpdateInterval: null, skippedChapters: [],
    resetDownloadState: noop, calculateInitialSpeed: () => 60, updateStatisticsDisplay: noop,
    formatChapterTitle: () => 'Test', trackRequest: noop, updateProgress: noop, throwIfCanceled: noop,
    handleChapterError: noop, handleImageError: noop, onTranslatorSelected: noop,
    addLog: line => logs.push(line), setExactFileSize: noop, saveAs: () => saved++,
    setInterval: () => { const id = timers.size + 1; timers.add(id); return id; }, clearInterval: id => timers.delete(id),
    getFormatter: () => ({ format: async () => {
      if (fail) throw new Error('Synthetic formatter failure');
      if (partial) context.skippedChapters.push({ number: 1 });
      return { blob: { size: 12 }, filename: 'test.epub' };
    } }),
    window: {
      setDownloadStartTime: noop,
      getStatisticsValue: name => partial && name === 'skippedImagesCount' ? 1 : 0
    }
  });
  vm.runInContext(functionSource('src/core/download.js', 'completionText') + functionSource('src/core/download.js', 'startDownload'), context);
  let result;
  return { timers, logs, run: async () => { try { result = await context.startDownload(snapshot); } catch (err) { thrown = err; } }, result: () => result, thrown: () => thrown, saved: () => saved };
}

for (const noDownloadData of [false, true]) {
  test(`failed download cleans up and rethrows without saving (${noDownloadData ? 'no snapshot data' : 'formatter'})`, async () => {
    const harness = downloadHarness({ fail: true, noDownloadData });
    await harness.run();
    assert.ok(harness.thrown());
    assert.equal(harness.timers.size, 0);
    assert.equal(harness.saved(), 0);
    assert.ok(harness.logs.some(line => /Критическая ошибка/.test(line)));
  });
}

test('partial completion reports skipped content and leaves saving to the caller', async () => {
  const harness = downloadHarness({ partial: true });
  await harness.run();
  assert.equal(harness.saved(), 0);
  assert.equal(harness.timers.size, 0);
  const { downloaded, total, skippedImages, filename } = harness.result();
  assert.deepEqual([downloaded, total, skippedImages, filename], [1, 2, 1, 'test.epub']);
  assert.ok(harness.logs.includes('Готово с пропусками: 1 / 2 глав; пропущено картинок: 1'));
});

// Раздел «Загрузки»: чистая разметка downloads-view.js (ход загрузки приходит из движка состоянием очереди)
function downloadsView() {
  const context = vm.createContext({ console, chrome: {} });
  vm.runInContext(source('src/utils/page-call.js') + source('src/core/downloads-view.js'), context);
  return context;
}
const queued = (over = {}) => ({ id: 'a', slug: 's', siteKey: 'mangalib', title: 'T', format: 'epub', status: 'running', progress: { current: 1, total: 4 }, ...over });
const commandsOf = html => [...html.matchAll(/data-cmd="([^"]+)"/g)].map(match => match[1]);

test('failed download shows exactly one error and offers only removal', () => {
  const html = downloadsView().renderQueueItem(queued({ status: 'error', error: 'boom' }));
  assert.equal((html.match(/Ошибка/g) || []).length, 1);
  assert.match(html, /Ошибка: boom/);
  assert.deepEqual(commandsOf(html), ['remove']); // ни паузы, ни повтора, ни пропуска у завершённой с ошибкой загрузки
});

test('partial completion reports skipped content instead of unconditional success', () => {
  const view = downloadsView();
  const html = view.renderQueueItem(queued({ status: 'done', progress: { current: 1, total: 2 }, filename: 'a.epub' }));
  assert.match(html, /Готово с пропусками: 1 \/ 2 глав/);
  assert.match(html, /a\.epub/);
  assert.match(view.renderStats({ skippedChapters: 1, skippedImages: 3 }), /Пропущено картинок:<\/span>\s*<span class="analysis-value">3</);
  // полная загрузка пропусков не заявляет
  assert.doesNotMatch(view.renderQueueItem(queued({ status: 'done', progress: { current: 2, total: 2 } })), /с пропусками/);
});

test('downloads view draws download events: log, progress, stats, decision buttons, pause', () => {
  const view = downloadsView();
  assert.match(view.renderLog([{ line: '[t] hi', isError: true, color: null }]), /<div class="log-entry error">\[t\] hi<\/div>/);
  const progress = view.renderQueueItem(queued({ progress: { current: 1, total: 4 } }));
  assert.match(progress, /width: 25%/);
  assert.match(progress, /1 \/ 4 глав/);
  const stats = view.renderStats({ elapsed: '5 сек', requestsPerMinute: 7, maxRequestsPerMinute: 75, errors: 2 });
  assert.match(stats, /Запросов в минуту:<\/span>\s*<span class="analysis-value">7 \(75\)</);
  assert.match(stats, /Ошибки:<\/span>\s*<span class="analysis-value">2</);
  const decision = view.renderQueueItem(queued({ status: 'waiting-decision', decision: { kind: 'chapter', chapterTitle: 'Г', message: 'm' } }));
  assert.deepEqual(commandsOf(decision), ['retry', 'skip', 'cancel']);
  assert.deepEqual(commandsOf(view.renderQueueItem(queued())), ['pause', 'cancel']);
  const paused = view.renderQueueItem(queued({ status: 'paused' }));
  assert.deepEqual(commandsOf(paused), ['resume', 'cancel']);
  assert.match(paused, /title="Продолжить"/);
});

test('a finished download can be saved again and downloaded again from the same window', () => {
  const html = downloadsView().renderQueueItem(queued({ status: 'done', progress: { current: 4, total: 4 }, filename: 'a.epub' }));
  assert.match(html, /data-cmd="saveAgain"[^>]*title="Сохранить файл ещё раз"/);
  // «Скачать N глав» остаётся в низу окна (формат и главы можно выбрать заново), отдельной кнопки возврата нет
  const handler = between('src/core/panel.js', "downloadButton.addEventListener('click'", 'backButton.addEventListener');
  assert.doesNotMatch(handler, /style\.display = 'none'|hidden/);
  assert.doesNotMatch(source('src/html/panel.html') + source('src/html/downloads.html'), /btn-new-download/);
});

test('recovery restores the download button and keeps the chapter selection', () => {
  // после отказа очереди и после исключения кнопка снова доступна: busy и disabled сбрасываются вне try/catch
  const handler = between('src/core/panel.js', "downloadButton.addEventListener('click'", 'backButton.addEventListener');
  const tail = handler.slice(handler.lastIndexOf('} catch'));
  assert.match(tail, /busy = false;\s*downloadButton\.disabled = counts\.selected === 0;/);
  // выбор глав окно не стирает: берёт сохранённый, а кнопка гаснет только при пустом выборе
  assert.match(handler, /selectedChapterIds: selectedIds\(titleData\[slug\]\)/);
  assert.doesNotMatch(handler, /selectedChapterIds[^;]*=\s*(\[\]|null)/);
});

test('format selector exposes selectable native options for each site', () => {
  const context = vm.createContext({});
  vm.runInContext(source('src/utils/formats.js'), context);
  const values = siteType => Array.from(context.formatOptionsFor(siteType), option => option.value);
  assert.equal(context.defaultFormatFor('manga'), 'cbz');
  assert.ok(values('manga').includes('pdf') && context.formatOptionsFor('manga').every(option => option.label));
  assert.equal(context.defaultFormatFor('ranobe'), 'epub');
  assert.ok(values('ranobe').includes('fb2'));
  // окно и быстрое окошко строят настоящие <option> из этого списка
  for (const file of ['src/core/panel.js', 'src/core/quick.js']) {
    assert.match(source(file), /createElement\('option'\)/, file);
    assert.match(source(file), /Options(For)?\(/, file);
  }
});

// --- Second audit pass: chapter HTML in EPUB/HTML/FB2 and 4xx retries ---

// Node has no DOM: minimal stand-ins for the DOMParser/XMLSerializer calls the formatters make.
function fakeElement(tagName, attributes = {}) {
  const el = {
    tagName, removed: false, attrs: { ...attributes },
    get attributes() { return Object.entries(el.attrs).map(([name, value]) => ({ name, value })); },
    getAttribute: name => el.attrs[name] ?? null,
    removeAttribute: name => { delete el.attrs[name]; },
    setAttribute: (name, value) => { el.attrs[name] = value; },
    remove: () => { el.removed = true; },
    replaceWith: node => { el.replacedWith = node; }
  };
  return el;
}
function fakeChapterDom({ scripts = [], elements = [], images = [] } = {}) {
  const body = {
    innerHTML: '<div>a<br>b&nbsp;</div>',
    childNodes: [{ xml: '<div xmlns="http://www.w3.org/1999/xhtml">a<br/>b </div>' }],
    querySelectorAll: selector => selector.includes('script') ? scripts : selector === '*' ? elements : selector === 'img' ? images : []
  };
  const doc = {
    body,
    querySelectorAll: selector => body.querySelectorAll(selector),
    createElement: tagName => ({ tagName, className: '', textContent: '' })
  };
  return {
    doc,
    DOMParser: class { parseFromString() { return doc; } },
    XMLSerializer: class { serializeToString(node) { return node.xml; } }
  };
}
function formatterWithDom(file, className, dom, globals = {}) {
  const context = vm.createContext({ crypto, console, DOMParser: dom.DOMParser, XMLSerializer: dom.XMLSerializer, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, ...globals });
  vm.runInContext(source('src/formatters/base.js') + source(file) + `\nthis.Formatter = ${className};`, context);
  const formatter = Object.create(context.Formatter.prototype);
  formatter.options = {};
  return formatter;
}

for (const quality of ['ORIGINAL', 'NONE']) {
  test(`EPUB writes HTML chapters as well-formed XHTML (quality ${quality})`, async () => {
    const dom = fakeChapterDom();
    const formatter = formatterWithDom('src/formatters/epub.js', 'EpubFormatter', dom);
    formatter.options.quality = quality;
    const html = await formatter.convertJsonToHtml('a<br>b&nbsp;', null);
    assert.equal(html, dom.doc.body.childNodes[0].xml);
    assert.ok(!html.includes('<br>') && !html.includes('&nbsp;'));
  });
}

test('chapter sanitizer drops scripts, event handlers and javascript: links but keeps images', () => {
  const script = fakeElement('SCRIPT');
  const frame = fakeElement('IFRAME', { srcdoc: 'x' });
  const img = fakeElement('IMG', { src: 'https://img.example/1.jpg', alt: 'x', onerror: 'alert(1)' });
  const inline = fakeElement('IMG', { src: 'data:image/png;base64,AAAA' });
  const link = fakeElement('A', { href: 'javascript:alert(1)', title: 't' });
  const tabbed = fakeElement('A', { href: ' java\tscr\nipt:alert(1)' });
  const animate = fakeElement('ANIMATE', { attributeName: 'href', to: 'javascript:alert(1)' });
  const dom = fakeChapterDom({ scripts: [script, frame, animate], elements: [img, inline, link, tabbed] });
  const formatter = formatterWithDom('src/formatters/html.js', 'HtmlFormatter', dom);
  formatter.sanitizeChapterDom(dom.doc.body);
  assert.ok(script.removed && frame.removed);
  assert.deepEqual(img.attrs, { src: 'https://img.example/1.jpg', alt: 'x' });
  assert.deepEqual(inline.attrs, { src: 'data:image/png;base64,AAAA' });
  assert.deepEqual(link.attrs, { title: 't' });
  assert.deepEqual(tabbed.attrs, {});
  assert.ok(animate.removed);
});

for (const [file, className] of [['src/formatters/epub.js', 'EpubFormatter'], ['src/formatters/html.js', 'HtmlFormatter']]) {
  test(`${className} sanitizes HTML chapters before export`, async () => {
    const script = fakeElement('SCRIPT');
    const handler = fakeElement('P', { onclick: 'steal()' });
    const dom = fakeChapterDom({ scripts: [script], elements: [handler] });
    const formatter = formatterWithDom(file, className, dom);
    formatter.options.quality = 'NONE';
    await formatter.convertJsonToHtml('<p onclick="steal()">x</p><script>steal()</script>', null);
    assert.ok(script.removed);
    assert.deepEqual(handler.attrs, {});
  });
}

test('image placeholder text is not parsed as markup', () => {
  const img = fakeElement('IMG', { alt: '<b onmouseover=x>' });
  const dom = fakeChapterDom({ images: [img] });
  const formatter = formatterWithDom('src/formatters/html.js', 'HtmlFormatter', dom);
  formatter.replaceImagesWithPlaceholders(dom.doc, true);
  assert.equal(img.replacedWith.textContent, '[Изображение пропущено: <b onmouseover=x>]');
  assert.equal(img.replacedWith.className, 'image-placeholder');
});

test('FB2 without images converts chapter markup instead of escaping tags', async () => {
  const dom = fakeChapterDom();
  const formatter = formatterWithDom('src/formatters/fb2.js', 'Fb2Formatter', dom);
  formatter.options.quality = 'NONE';
  formatter.htmlToFb2 = () => '<p>a</p>';
  assert.equal(await formatter.convertJsonToFb2Xml('<p>a</p>'), '<p>a</p>');
});

test('FB2 unwraps a chapter wrapper instead of nesting paragraphs', () => {
  const formatter = formatterWithDom('src/formatters/fb2.js', 'Fb2Formatter', fakeChapterDom());
  const text = textContent => ({ nodeType: 3, textContent });
  const el = (tagName, ...childNodes) => ({ nodeType: 1, tagName, childNodes, children: childNodes.filter(node => node.nodeType === 1), getAttribute: () => null, style: {} });
  // Глава старого формата приходит как <div><p>…</p>…</div>: раньше это давало <p><p>…</p></p>, и читалки не открывали книгу
  assert.equal(formatter.htmlToFb2(el('DIV', el('P', text('a')), text('loose'), el('P', text('b')))), '<p>a</p><p>loose</p><p>b</p>');
  assert.equal(formatter.htmlToFb2(el('P', text('x'))), '<p>x</p>');
});

test('TXT keeps paragraphs of HTML chapters apart', () => {
  const htmlToText = between('src/formatters/txt.js', '  async htmlToText(html, context = {}) {', '  generateInfoPage(metadata) {');
  assert.match(htmlToText, /querySelectorAll\('p, div[^']*'\)\.forEach\(block => block\.append\('\\n\\n'\)\)/);
  assert.match(source('src/formatters/txt.js'), /text \+= await this\.htmlToText\(chapterContent\.content, context\)/);
});

test('HTML export escapes titles, author, metadata and captions', async () => {
  const formatter = formatterWithDom('src/formatters/html.js', 'HtmlFormatter', fakeChapterDom());
  const evil = '<img src=x onerror=alert(1)> & co';
  const safe = '&lt;img src=x onerror=alert(1)&gt; &amp; co';
  const chapters = [{ volume: 1, number: 1, displayTitle: evil, htmlContent: '<p>ok</p>' }];
  const metadata = { titleRu: evil, author: evil, description: evil + '\nline 2' };
  const stats = { downloaded: 0 };
  const parts = [formatter.generateToc(chapters), await formatter.generateContent(chapters, metadata, stats), formatter.generateMetadataHTML(metadata, stats)];
  for (const part of parts) {
    assert.ok(part.includes(safe));
    assert.ok(!part.includes(evil));
  }
  assert.ok(parts[2].includes(safe + '<br/>line 2'));
  const caption = await formatter.convertJsonToHtml({ type: 'image', attrs: { description: evil } });
  assert.ok(caption.includes(safe) && !caption.includes(evil));
});

for (const status of [403, 404]) {
  for (const target of ['base', 'background', 'download']) {
    test(`${target}: HTTP ${status} fails at once without retries`, async () => {
      const delays = [];
      let requests = 0;
      const context = vm.createContext({
        console: { log() {} },
        fetch: async () => { requests++; return { ok: false, status, statusText: 'test failure' }; },
        setTimeout: (fn, delay) => { delays.push(delay); fn(); },
        checkPause: async () => {}, trackRequest: async () => {}, addLog() {}, handleRateLimitError() {}
      });
      if (target === 'base') {
        vm.runInContext(source('src/formatters/base.js') + '\nthis.Formatter = BaseFormatter;', context);
        await assert.rejects(new context.Formatter({}).fetchWithRetry('https://example.invalid'), new RegExp(`HTTP ${status}`));
      } else if (target === 'background') {
        vm.runInContext(functionSource('src/background.js', 'directFetch'), context);
        let result;
        await context.directFetch({ url: 'https://example.invalid' }, value => result = value);
        assert.equal(result.success, false);
        assert.match(result.error, new RegExp(`HTTP ${status}`));
      } else {
        vm.runInContext(functionSource('src/core/download.js', 'fetchWithRetry'), context);
        await assert.rejects(context.fetchWithRetry('https://example.invalid'), new RegExp(`HTTP ${status}`));
      }
      assert.equal(requests, 1);
      assert.deepEqual(delays, []);
    });
  }
}

// page-calls.js keeps a copy of fetchWithRetry inside every function injected into the site tab
const apiRetryCopies = source('src/core/page-calls.js').match(/async function fetchWithRetry\(url, options = \{\}, maxRetries = 3[\s\S]*?throw lastError \|\| new Error\('Max retries exceeded'\);\s*\}/g);
test('page-calls has four injected retry loops', () => assert.equal(apiRetryCopies.length, 4));
apiRetryCopies.forEach((copy, index) => {
  for (const [status, expectedRequests] of [[404, 1], [403, 1], [503, 4]]) {
    test(`page-calls retry loop #${index + 1}: HTTP ${status} makes ${expectedRequests} request(s)`, async () => {
      let requests = 0;
      const context = vm.createContext({
        fetch: async () => { requests++; return { ok: false, status }; },
        setTimeout: fn => fn()
      });
      vm.runInContext(copy, context);
      await assert.rejects(context.fetchWithRetry('https://example.invalid'));
      assert.equal(requests, expectedRequests);
    });
  }
});

for (const [file, className] of [['src/formatters/epub.js', 'EpubFormatter'], ['src/formatters/html.js', 'HtmlFormatter']]) {
  test(`${className} embeds an HTML-chapter image as data URL when there is no image folder`, async () => {
    const img = fakeElement('IMG', { src: 'https://img.example/1.jpg' });
    const dom = fakeChapterDom({ images: [img] });
    const FileReader = class { readAsDataURL(blob) { this.result = 'data:' + blob; this.onloadend(); } };
    const formatter = formatterWithDom(file, className, dom, { FileReader });
    formatter.downloadAndResizeImage = async () => ({ blob: 'IMAGE' });
    formatter.options.addLog = () => {};
    formatter.options.incrementErrorCount = () => {};
    let failed = 0;
    await formatter.convertJsonToHtml('<img src="https://img.example/1.jpg">', null, { onImageFailed: () => failed++ });
    assert.equal(failed, 0);
    assert.equal(img.attrs.src, 'data:IMAGE');
  });
}

test('archives deflate text but keep mimetype first and images stored', async () => {
  const JSZip = require(path.join(root, 'src/libs/jszip.min.js'));
  const context = vm.createContext({});
  vm.runInContext(source('src/formatters/base.js') + '\nthis.Formatter = BaseFormatter;', context);
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.folder('OEBPS').file('ch1.xhtml', '<p>Текст главы</p>'.repeat(500));
  zip.folder('OEBPS').folder('images').file('1.jpg', crypto.randomBytes(1000));
  const bytes = Buffer.from(await (await new context.Formatter({}).generateZip(zip)).arrayBuffer());
  const methods = {};
  for (let at = 0; bytes.readUInt32LE(at) === 0x04034b50; ) {
    const nameLength = bytes.readUInt16LE(at + 26);
    const name = bytes.toString('utf8', at + 30, at + 30 + nameLength);
    methods[name] = bytes.readUInt16LE(at + 8);
    at += 30 + nameLength + bytes.readUInt16LE(at + 28) + bytes.readUInt32LE(at + 18);
  }
  assert.equal(Object.keys(methods)[0], 'mimetype');
  assert.equal(methods.mimetype, 0);
  assert.equal(methods['OEBPS/ch1.xhtml'], 8);
  assert.equal(methods['OEBPS/images/1.jpg'], 0);
});

test('image unavailable on the original server is fetched from the compressed server', async () => {
  const requested = [];
  const logs = [];
  const context = vm.createContext({ URL, chrome: { runtime: { sendMessage: (message, reply) => {
    requested.push(message.url);
    reply({ success: false, error: message.url.includes('img2.') ? 'HTTP 403: ' : 'HTTP 404: ' });
  } } } });
  vm.runInContext(source('src/formatters/base.js') + '\nthis.Formatter = BaseFormatter;', context);
  const formatter = new context.Formatter({ addLog: message => logs.push(message) });
  const url = 'https://img2.imglib.info//manga/slug/chapters/1/page.png';
  await assert.rejects(formatter.downloadAndResizeImage(url, 'ORIGINAL'));
  assert.deepEqual(requested, [url, 'https://img3.cdnlibs.org//manga/slug/chapters/1/page.png']);
  assert.equal(logs.filter(message => message.includes('403')).length, 1);
  assert.equal(formatter.compressedImageUrl('https://img3.cdnlibs.org/x.png'), null);
});

test('same-width option scales manga pages to the most common width of the first chapter', async () => {
  const canvases = [];
  let pageWidths = [800, 1000, 800, 640];
  const context = vm.createContext({
    URL,
    chrome: {
      runtime: { sendMessage: (message, reply) => reply({ success: true, data: 'data:image/png;base64,' }) }
    },
    siteKeyOfTab: async () => 'mangalib',
    pageCall: async () => ({ success: true, pages: pageWidths.map(width => ({ width })) }),
    Image: class { set src(value) { this.width = 1000; this.height = 1500; this.onload(); } },
    fetch: async () => ({ blob: async () => ({ size: 1000, type: 'image/png' }) }),
    document: { createElement: () => {
      const canvas = { getContext: () => ({ drawImage() {} }), toBlob: done => done({ size: 500 }) };
      canvases.push(canvas);
      return canvas;
    } }
  });
  vm.runInContext(source('src/formatters/base.js') + '\nthis.Formatter = BaseFormatter;', context);

  const formatter = new context.Formatter({ sameWidth: true });
  await formatter.loadMangaChapterPages(1, 1, 1, 1, 'slug');
  pageWidths = [1000, 1000];
  await formatter.loadMangaChapterPages(1, 2, 1, 2, 'slug');
  assert.equal(formatter.commonPageWidth, 800);

  await formatter.downloadAndResizeImage('https://img3.cdnlibs.org/p.png', 'ORIGINAL').catch(() => {});
  await formatter.downloadAndResizeImage('https://img3.cdnlibs.org/p.png', 'HD').catch(() => {});
  await formatter.downloadAndResizeImage('https://img3.cdnlibs.org/c.png', 'ORIGINAL', null, 'обложка').catch(() => {});
  assert.deepEqual(canvases.map(({ width, height }) => [width, height]), [[800, 1200], [720, 1080]]);

  const off = new context.Formatter({});
  await off.loadMangaChapterPages(1, 1, 1, 1, 'slug');
  assert.equal(off.commonPageWidth, undefined);
});

test('PDF libraries load lazily and fonts are embedded whole', () => {
  assert.doesNotMatch(source('src/html/panel.html'), /pdf-lib|fontkit/);
  assert.doesNotMatch(source('src/engine/engine.html'), /pdf-lib|fontkit/);
  const pdf = source('src/formatters/pdf.js');
  assert.match(between('src/formatters/pdf.js', '  async format(chapters, metadata) {', 'const { PDFDocument'), /await loadPdfLibs\(\);/);
  // subset в pdf-lib/fontkit рисует кириллицу Merriweather, Inter и Crimson Text пустыми местами
  const embeds = pdf.match(/embedFont\([^)]*\)/g);
  assert.ok(embeds.length > 0 && embeds.every(call => !call.includes('subset')), embeds.join('\n'));
});

test('reload-page button waits for the tab to finish loading and reruns the title load', () => {
  const handler = between('src/core/popup.js', "document.getElementById('btn-reload-page').addEventListener", '// Кнопки открытия LIB сайтов');
  assert.match(handler, /info\.status === 'complete'/);
  assert.match(handler, /await loadTitle\(\);/);
  assert.doesNotMatch(handler, /setTimeout|loadCovers\(/);
});
