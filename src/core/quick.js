// quick.js - быстрое окошко «Скачать» под кнопками на странице тайтла (html/quick.html во фрейме поверх сайта).
// Скрипты страницы: title-store.js, header.js, page-calls.js, page-call.js, api.js, chapter-range.js, formats.js,
// title-loader.js, snapshot.js, engine-client.js, site-download.js, этот файл. Сообщения странице сайта: { libsaver: true, type, ... } (content/site-ui.js).

// Те же форматы, что в окне поверх сайта (formats.js)
function quickFormatOptions(siteKey) {
  return formatOptionsFor(siteTypeOf(siteKey));
}

// Снимок выбранного диапазона -> очередь движка. { ok: true } | { ok: false, message }; прочие отказы - исключение
async function startQuickDownload({ info, fromIdx, toIdx, tabId, url, format }) {
  const selectedChapterIds = rangeChapterIds(info.chapters, fromIdx, toIdx);

  // Снимок берёт главы из titleData.filteredChapters, панель считает по selectedChapterIds: оба поля обновляем вместе
  await updateTitleStore(['titleData'], info.slug, ({ titleData }) => {
    if (!titleData[info.slug]) return false;
    applySelectionToTitle(titleData[info.slug], info.allChapters, selectedChapterIds);
  });

  return enqueueSelection({ slug: info.slug, tabId, url, selectedChapterIds, format });
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
  const showError = (text, canRetry = true) => {
    $('error-text').textContent = text;
    $('retry').classList.toggle('hidden', !canRetry);
    show('error');
  };
  const range = () => [Number(fromSelect.value), Number(toSelect.value)];
  const updateLabel = () => {
    downloadButton.textContent = downloadLabel(rangeChapterIds(info.chapters, ...range()).length, info.siteType);
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
    if (!parentOrigin) return; // встроившего нас не опознали (whoami): ни storage, ни загрузки
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
  // Высота окошка = высота содержимого: body занимает весь фрейм и прокручивается, поэтому меряем обёртку внутри него
  const content = $('quick-content');
  new ResizeObserver(() => post({ type: 'resize', height: Math.ceil(content.getBoundingClientRect().height) })).observe(content);

  loadAndApplyTheme();
  (async () => {
    let me = null;
    try {
      me = await chrome.runtime.sendMessage({ action: 'whoami' });
    } catch (e) { /* расширение обновили */ }
    const embedder = verifiedEmbedder(me, params.get('tab'));
    if (!embedder) {
      showError('Окошко работает только на странице тайтла.', false);
      return;
    }
    ({ tabId, url, parentOrigin } = embedder);
    window.applySiteAccent(url);
    load(false);
  })();
}

if (typeof document !== 'undefined') startQuick();
