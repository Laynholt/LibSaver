// quick.js - быстрое окошко «Скачать» под кнопками на странице тайтла (html/quick.html во фрейме поверх сайта).
// Скрипты страницы: title-store.js, header.js, page-calls.js, page-call.js, api.js, chapter-range.js, formats.js,
// title-loader.js, snapshot.js, engine-client.js, этот файл. Сообщения странице сайта: { libsaver: true, type, ... } (content/site-ui.js).

const QUICK_ALREADY_QUEUED = 'Этот тайтл уже в очереди';

// Те же форматы, что в окне «Подготовка» (formats.js)
function quickFormatOptions(siteKey) {
  return formatOptionsFor(siteTypeOf(siteKey));
}

// «Скачать 1 главу / 2 главы / 5 глав»
function downloadLabel(count) {
  const lastTwo = count % 100;
  const last = count % 10;
  const word = lastTwo >= 11 && lastTwo <= 14 ? 'глав' : last === 1 ? 'главу' : last >= 2 && last <= 4 ? 'главы' : 'глав';
  return `Скачать ${count} ${word}`;
}

// «До» не меньше «От» (как в popup): подтягиваем второй край, когда двигают первый
function syncRange(fromIdx, toIdx, changed) {
  if (changed === 'from' && toIdx < fromIdx) return [fromIdx, fromIdx];
  if (changed === 'to' && fromIdx > toIdx) return [toIdx, toIdx];
  return [fromIdx, toIdx];
}

// Значения по умолчанию - как у окна «Подготовка» (сервер картинок - JPEG, «только текст» выключен)
function quickSettings(stored) {
  return {
    imageServer: ['normal', 'compressed'].includes(stored.imageServer) ? stored.imageServer : 'compressed',
    textOnly: stored.textOnly === true
  };
}

// Окошко открыто на странице тайтла LIB-сайта? Кто встроил нас, знает только фон (sender.tab); параметры адреса
// подделывает любая страница, потому что html/quick.html доступна всем сайтам. null - отказ.
function quickEmbedder(me, tabParam) {
  if (typeof me?.tabId !== 'number' || typeof me.url !== 'string') return null;
  if (tabParam != null && tabParam !== String(me.tabId)) return null;
  if (!siteKeyByHost(me.url) || !isTitlePage(me.url)) return null;
  return { tabId: me.tabId, url: me.url, parentOrigin: new URL(me.url).origin };
}

function loadErrorText(error) {
  switch (error.code) {
    case 'unsupported-site': return 'Перейдите на один из поддерживаемых сайтов.';
    case 'not-title-page': return 'Перейдите на главную страницу нужного тайтла.';
    case 'load-failed': return 'Не удалось получить данные из API.';
    default: return error.message;
  }
}

// Редакторы и снимок читают siteType и sourceUrl из storage; loadTitleData их не пишет (как и в popup)
async function loadQuickTitle({ tabId, url, force = false }) {
  await chrome.storage.local.set({ siteType: siteTypeOf(siteKeyOf(url)), sourceUrl: url });
  return loadTitleData({ tabId, url, force });
}

// Снимок выбранного диапазона -> очередь движка. { ok: true } | { ok: false, message }; прочие отказы - исключение
async function startQuickDownload({ info, fromIdx, toIdx, tabId, url, format }) {
  const selectedChapterIds = rangeChapterIds(info.chapters, fromIdx, toIdx);

  // Снимок берёт главы из titleData.filteredChapters (диапазон popup): без обновления в него не попадёт выбранное здесь
  const { titleData } = await getTitleStore(['titleData'], info.slug);
  if (titleData[info.slug]) {
    const chosen = new Set(selectedChapterIds);
    titleData[info.slug].filteredChapters = info.allChapters.filter(chapter => chosen.has(chapter.id));
    titleData[info.slug].fromIdx = info.allChapters.findIndex(chapter => chosen.has(chapter.id));
    titleData[info.slug].toIdx = info.allChapters.findLastIndex(chapter => chosen.has(chapter.id));
    await setTitleStore({ titleData });
  }

  const settings = quickSettings(await chrome.storage.local.get(['imageServer', 'textOnly']));
  // «Ускорить» снимок читает из storage сам
  const snapshot = await buildDownloadSnapshot({ slug: info.slug, tabId, sourceUrl: url, selectedChapterIds, format, ...settings });
  const result = await enqueueSnapshot(snapshot);
  if (result.ok) return { ok: true };
  if (result.reason === 'already-queued') return { ok: false, message: QUICK_ALREADY_QUEUED };
  throw new Error('Очередь не приняла тайтл');
}

// ---- Страница ----

function startQuick() {
  const params = new URLSearchParams(location.search);
  // Вкладка, адрес и origin страницы - от фона (whoami), не из параметров адреса
  let tabId = null;
  let url = '';
  let parentOrigin = null;
  const post = message => {
    if (parentOrigin) window.parent.postMessage({ libsaver: true, ...message }, parentOrigin);
  };
  const $ = id => document.getElementById(id);
  const [fromSelect, toSelect, formatSelect, downloadButton, status] = ['from', 'to', 'format', 'download', 'status'].map($);
  let info = null;

  const show = view => {
    for (const id of ['loading', 'error', 'form']) $(id).classList.toggle('hidden', id !== view);
  };
  const showError = text => {
    $('error-text').textContent = text;
    show('error');
  };
  const range = () => [Number(fromSelect.value), Number(toSelect.value)];
  const updateLabel = () => {
    downloadButton.textContent = downloadLabel(rangeChapterIds(info.chapters, ...range()).length);
    status.textContent = '';
  };

  const fillChapters = select => {
    select.replaceChildren(...info.chapters.map((chapter, index) => {
      const option = document.createElement('option');
      option.value = index;
      option.textContent = chapterLabel(chapter);
      return option;
    }));
  };

  async function fillFormats() {
    const options = quickFormatOptions(info.siteKey);
    formatSelect.replaceChildren(...options.map(({ value, label }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }));
    const formatKey = formatKeyFor(info.siteType);
    const saved = (await chrome.storage.local.get(formatKey))[formatKey];
    formatSelect.value = options.some(option => option.value === saved) ? saved : defaultFormatFor(info.siteType);
  }

  async function load(force) {
    show('loading');
    try {
      info = await loadQuickTitle({ tabId, url, force });
      if (info.chapters.length === 0) throw new Error('В тайтле нет глав.');
      fillChapters(fromSelect);
      fillChapters(toSelect);
      toSelect.value = info.chapters.length - 1;
      await fillFormats();
    } catch (error) {
      console.error('[LibSaver] quick', error);
      showError(loadErrorText(error));
      return;
    }
    updateLabel();
    show('form');
  }

  fromSelect.addEventListener('change', () => {
    [fromSelect.value, toSelect.value] = syncRange(...range(), 'from');
    updateLabel();
  });
  toSelect.addEventListener('change', () => {
    [fromSelect.value, toSelect.value] = syncRange(...range(), 'to');
    updateLabel();
  });
  formatSelect.addEventListener('change', () => chrome.storage.local.set({ [formatKeyFor(info.siteType)]: formatSelect.value }));
  $('retry').addEventListener('click', () => load(true));
  $('more').addEventListener('click', event => {
    event.preventDefault();
    post({ type: 'openPanel', section: 'chapters' });
  });
  $('form').addEventListener('submit', async event => {
    event.preventDefault();
    downloadButton.disabled = true;
    status.textContent = '';
    try {
      const result = await startQuickDownload({ info, fromIdx: Number(fromSelect.value), toIdx: Number(toSelect.value), tabId, url, format: formatSelect.value });
      if (result.ok) {
        post({ type: 'close' });
        return;
      }
      status.textContent = result.message;
    } catch (error) {
      status.textContent = `Не удалось начать загрузку: ${error.message}`;
    }
    downloadButton.disabled = false;
  });
  // Фокус во фрейме: Esc до страницы сайта не доходит
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') post({ type: 'close' });
  });
  // Высота окошка = высота содержимого (scrollHeight у html не уменьшается ниже высоты фрейма)
  new ResizeObserver(() => post({ type: 'resize', height: Math.ceil(document.body.getBoundingClientRect().height) })).observe(document.body);

  loadAndApplyTheme();
  (async () => {
    let me = null;
    try {
      me = await chrome.runtime.sendMessage({ action: 'whoami' });
    } catch (e) { /* расширение обновили */ }
    const embedder = quickEmbedder(me, params.get('tab'));
    if (!embedder) {
      showError('Окошко работает только на странице тайтла.');
      return;
    }
    ({ tabId, url, parentOrigin } = embedder);
    window.applySiteAccent(url);
    load(false);
  })();
}

if (typeof document !== 'undefined') startQuick();
