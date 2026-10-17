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

test('switching titles preserves the previous title edits', async () => {
  const data = { currentSlug: 'old', 'titleData:old': { metadata: { titleRu: 'Edited' }, covers: ['local'], chapterBranchOverrides: { 1: '2_team' } }, 'originalTitleData:old': { chapters: [] } };
  const before = structuredClone(data['titleData:old']);
  const context = vm.createContext({ chaptersResult: { slug: 'new' }, currentSlug: 'old', chrome: { storage: { local: storageApi(data) } } });
  vm.runInContext(titleStore, context);
  await vm.runInContext('(async () => {' + between('src/core/popup.js', '      const newSlug = chaptersResult.slug;', '      // Загружаем приоритет переводчиков') + '})()', context);
  assert.deepEqual(data['titleData:old'], before);
  assert.equal(data.currentSlug, 'new');
});

test('opening popup preserves old saved edits even after cache expiry', async () => {
  const data = { 'titleData:old': { cacheTimestamp: 1, metadata: { titleRu: 'Edited' }, covers: ['local'] } };
  const before = structuredClone(data);
  const context = vm.createContext({ chrome: { storage: { local: storageApi(data) } } });
  const init = between('src/core/popup.js', '  // Удаляем старый downloadData', '  // Проверка обновлений при открытии popup');
  await vm.runInContext('(async () => {' + init + '})()', context);
  assert.deepEqual(data['titleData:old'], before['titleData:old']);
});

test('saving title format clears stale generated titles and notifies consumers', async () => {
  let save;
  const messages = [];
  const data = { tocFormat: 'default', 'titleData:title': { chapters: [{ displayTitle: 'Old' }] } };
  const context = vm.createContext({
    defaultSiteLinks: {}, wasSaved: false,
    document: { getElementById: id => id === 'btn-save' ? { addEventListener: (_, fn) => save = fn } : { value: id === 'toc-format' ? 'custom' : '1', checked: false } },
    chrome: { storage: { local: storageApi(data) }, runtime: { sendMessage: message => messages.push(message) } },
    window: { close() {} }
  });
  vm.runInContext(titleStore, context);
  vm.runInContext(between('src/core/settings.js', "document.getElementById('btn-save').addEventListener", '\n});') + '\n});', context);
  await save();
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
  const scripts = ['src/core/popup.js', 'src/core/prepare.js', 'src/core/download.js', 'src/core/settings.js',
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

test('popup requests chapters, metadata and covers together without artificial waits', () => {
  const start = between('src/core/popup.js', "document.addEventListener('DOMContentLoaded'", '// Функция для открытия popup окна');
  assert.match(start, /Promise\.all\(\[\s*trackProgress\(loadChapters\(activeTab\.id\)\),\s*trackProgress\(loadMetadata\(activeTab\.id\)\),\s*trackProgress\(loadCovers\(activeTab\.id, urlSlug\)\)/);
  assert.doesNotMatch(start, /await (loadChapters|loadMetadata|loadCovers)\(|setTimeout\(resolve|\b(fast|slowSmooth|ready|animate)Progress\(/);
});

test('window detection ignores unrelated websites and recognizes own page', async () => {
  const data = {};
  let url = 'https://example.org/settings.html';
  const context = vm.createContext({ chrome: {
    windows: { getAll: async () => [{ tabs: [{ url }] }] },
    runtime: { getURL: file => 'chrome-extension://self/' + file },
    storage: { local: storageApi(data) }
  } });
  vm.runInContext(functionSource('src/core/popup.js', 'syncOpenWindows'), context);
  await context.syncOpenWindows();
  assert.equal(data.currentOpenWindow, undefined);
  url = 'chrome-extension://self/html/settings.html';
  await context.syncOpenWindows();
  assert.equal(data.currentOpenWindow, 'settings');
});

function errorHandlers() {
  const buttons = {};
  const context = vm.createContext({
    currentErrorChapter: null, currentError: null, isWaitingForUser: false,
    shouldRetryChapter: false, isPaused: false, skippedChapters: [], addLog() {}, window: {}, btnDownloadFile: null,
    document: { getElementById: id => buttons[id] = { style: {}, addEventListener: (_, fn) => buttons[id].click = fn } }
  });
  vm.runInContext(between('src/core/download.js', '// Обработчик кнопки Пауза/Возобновить', '// Функции для статистики') + '\n' + source('src/core/download.js').slice(source('src/core/download.js').indexOf('async function handleChapterError')), context);
  return { context, buttons };
}

for (const action of ['retry', 'skip']) {
  test(`image ${action} after a chapter error targets the image`, async () => {
    const { context, buttons } = errorHandlers();
    let decision = context.handleChapterError({ number: 1 }, new Error('chapter'), 0);
    buttons['btn-retry'].click();
    assert.equal((await decision).shouldRetry, true);
    decision = context.handleImageError({ number: 2 }, new Error('image'), 1, 'image');
    buttons['btn-' + action].click();
    assert.equal((await decision).shouldRetry, action === 'retry');
    assert.equal(context.skippedChapters.length, 0);
    decision = context.handleChapterError({ number: 3 }, new Error('chapter'), 2);
    buttons['btn-retry'].click();
    assert.equal((await decision).shouldRetry, true);
  });
}

function downloadHarness({ fail = false, partial = false, storageFailure = false } = {}) {
  const timers = new Set();
  const elements = {};
  const element = id => elements[id] ||= { style: {}, disabled: true, textContent: '', classList: { remove() {} } };
  const checkboxes = [element('chapter'), element('volume')];
  checkboxes.forEach(box => box.closest = () => null);
  let pending;
  let stopped = false;
  let restored = false;
  let saved = 0;
  const noop = () => {};
  const data = { downloadData: { slug: 'test', chapters: [{ id: 1 }, { id: 2 }], metadata: {}, selectedFormat: 'epub' } };
  const context = vm.createContext({
    console: { error: noop }, progressText: element('progress-text'), progressBar: element('progress-bar'),
    btnDownloadFile: element('btn-download-file'), btnPauseElement: element('btn-pause'), btnRetryElement: element('btn-retry'), btnSkipElement: element('btn-skip'),
    statsUpdateInterval: null, skippedChapters: [],
    document: { getElementById: element, querySelectorAll: () => checkboxes },
    resetDownloadState: noop, calculateInitialSpeed: () => 60, updateStatisticsDisplay: noop,
    formatChapterTitle: () => 'Test', trackRequest: noop, updateProgress: noop, getTitleStore: async () => ({ titleData: {} }),
    handleChapterError: noop, handleImageError: noop, onTranslatorSelected: noop,
    addLog: noop, setExactFileSize: noop, saveAs: () => saved++,
    setInterval: () => { const id = timers.size + 1; timers.add(id); return id; }, clearInterval: id => timers.delete(id),
    getFormatter: () => ({ format: async () => {
      if (fail) throw new Error('Synthetic formatter failure');
      if (partial) context.skippedChapters.push({ number: 1 });
      return { blob: { size: 12 }, filename: 'test.epub' };
    } }),
    chrome: { storage: { local: {
      get: (_keys, callback) => {
        if (storageFailure) throw new Error('Storage unavailable');
        if (callback) { pending = callback(data); return; }
        return Promise.resolve(data);
      }, set: noop
    } } },
    window: {
      setDownloadStartTime: noop,
      stopStatisticsUpdate: () => stopped = true,
      restoreDownloadControls: () => { restored = true; },
      getStatisticsValue: name => partial && name === 'skippedImagesCount' ? 1 : 0
    }
  });
  vm.runInContext(functionSource('src/core/download.js', 'startDownload'), context);
  return { context, timers, elements, run: async () => { await context.startDownload(); await pending; }, status: () => ({ stopped, restored, saved }) };
}

for (const storageFailure of [false, true]) {
  test(`failed download cleans up and offers another attempt (${storageFailure ? 'storage' : 'formatter'})`, async () => {
    const harness = downloadHarness({ fail: true, storageFailure });
    await harness.run();
    assert.equal(harness.timers.size, 0);
    assert.equal(harness.status().stopped, true);
    assert.equal(harness.status().restored, true);
    assert.equal(harness.status().saved, 0);
    assert.match(harness.elements['progress-text'].textContent, /Ошибка/);
  });
}

test('partial completion reports skipped content instead of unconditional success', async () => {
  const harness = downloadHarness({ partial: true });
  await harness.run();
  assert.equal(harness.status().saved, 1);
  assert.equal(harness.timers.size, 0);
  assert.match(harness.elements['progress-text'].textContent, /пропуск/i);
  assert.match(harness.elements['progress-text'].textContent, /1.*2/);
});

test('recovery restores chapter selection and the download button', () => {
  const elements = {};
  const element = id => elements[id] ||= { disabled: true, style: { display: 'none' }, classList: { remove() {} }, closest: () => null };
  const chapters = [element('chapter')];
  const volumes = [element('volume')];
  const context = vm.createContext({ document: {
    getElementById: element,
    querySelectorAll: selector => selector === '.chapter-checkbox' ? chapters : volumes
  } });
  for (const name of ['enableControls', 'enableVolumeCheckboxes', 'restoreDownloadControls']) {
    vm.runInContext(functionSource('src/core/prepare.js', name), context);
  }
  context.restoreDownloadControls();
  for (const id of ['chapter', 'volume', 'btn-start-download', 'format-select', 'server-select', 'text-only-checkbox']) {
    assert.equal(element(id).disabled, false, id);
  }
  assert.notEqual(element('btn-start-download').style.display, 'none');
});

test('format selector exposes selectable native options for each site', () => {
  const select = { options: [], value: '', appendChild(option) { this.options.push(option); },
    set innerHTML(_value) { this.options = []; } };
  const context = vm.createContext({ document: {
    getElementById: id => id === 'format-select' ? select : null,
    createElement: tag => ({ tagName: tag.toUpperCase(), value: '', textContent: '', classList: { add() {} } })
  } });
  vm.runInContext(functionSource('src/core/prepare.js', 'populateFormatSelector'), context);
  assert.equal(context.populateFormatSelector('manga'), 'cbz');
  assert.ok(select.options.some(option => option.tagName === 'OPTION' && option.value === 'pdf'));
  assert.equal(select.value, 'cbz');
  assert.equal(context.populateFormatSelector('ranobe'), 'epub');
  assert.ok(select.options.some(option => option.value === 'fb2'));
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

// api.js keeps a copy of fetchWithRetry inside every function injected into the site tab
const apiRetryCopies = source('src/core/api.js').match(/async function fetchWithRetry\(url, options = \{\}, maxRetries = 3[\s\S]*?throw lastError \|\| new Error\('Max retries exceeded'\);\s*\}/g);
test('api.js has four injected retry loops', () => assert.equal(apiRetryCopies.length, 4));
apiRetryCopies.forEach((copy, index) => {
  for (const [status, expectedRequests] of [[404, 1], [403, 1], [503, 4]]) {
    test(`api.js retry loop #${index + 1}: HTTP ${status} makes ${expectedRequests} request(s)`, async () => {
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
