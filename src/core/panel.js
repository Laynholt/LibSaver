// panel.js - окно LibSaver поверх сайта (html/panel.html во фрейме, content/site-ui.js): меню разделов слева (на телефоне - список),
// справа один раздел, внизу формат, «Ускорить» и «Скачать N глав». Разделы - страницы расширения, каждая в своём iframe.
// Скрипты страницы: title-store.js, header.js, page-calls.js, page-call.js, api.js, chapter-range.js, formats.js, title-loader.js,
// snapshot.js, engine-client.js, site-download.js, этот файл. Сообщения странице сайта: { libsaver: true, type, ... } (content/site-ui.js).

const PANEL_PHONE_WIDTH = 768;
const DEFAULT_SECTION = 'chapters';
const ACTIVE_STATUSES = ['queued', 'running', 'paused', 'waiting-tab', 'waiting-decision']; // как в engine/queue.js
const DEFAULT_METADATA_FIELDS = 15; // metadata.js: пока пользователь не менял, включены все поля

const PANEL_GROUPS = [
  { id: 'title', title: 'Этот тайтл' },
  { id: 'build', title: 'Как собирать файл' },
  { id: 'extension', title: 'Расширение' }
];

// Свои настройки в settings.html есть только у CBZ/ZIP, PDF и TXT; у остальных форматов раздела «формат» нет
const FORMAT_SETTINGS = {
  cbz: { group: 'cbz', title: 'CBZ/ZIP' },
  zip: { group: 'cbz', title: 'CBZ/ZIP' },
  pdf: { group: 'pdf', title: 'PDF' },
  txt: { group: 'txt', title: 'TXT' }
};

// Подписи значений - как в settings.html
const IMAGE_QUALITY_LABELS = { NONE: 'Без картинок', ORIGINAL: 'Без сжатия', '2K': '1600px', QHD: '1440px', FHD: '1080px', HD: '720px', qHD: '540px', SD: '480px' };
const TOC_FORMAT_LABELS = {
  format1: 'Том X Глава Y Название', format2: 'Том X Глава Y - Название', format3: 'Том X - Глава Y - Название', format4: 'Том X / Глава Y / Название',
  default: 'Том X. Глава Y. Название', no_headers: 'Без заголовков', custom: 'Пользовательский формат'
};

// Разделы в порядке меню. group: null - «Загрузки» отдельно внизу. format - выбранный формат файла (null - без него)
function PANEL_SECTIONS(format) {
  const own = FORMAT_SETTINGS[format];
  return [
    { id: 'chapters', group: 'title', title: 'Главы', url: 'chapters.html' },
    { id: 'metadata', group: 'title', title: 'Метаданные', url: 'metadata.html' },
    { id: 'covers', group: 'title', title: 'Обложки', url: 'covers.html' },
    { id: 'images', group: 'build', title: 'Картинки', url: 'settings.html?group=images' },
    { id: 'toc', group: 'build', title: 'Оглавление', url: 'settings.html?group=toc' },
    ...(own ? [{ id: 'format', group: 'build', title: own.title, url: `settings.html?group=${own.group}` }] : []),
    { id: 'general', group: 'extension', title: 'Общие', url: 'settings.html?group=general' },
    { id: 'about', group: 'extension', title: 'О LibSaver', url: 'settings.html?group=about' },
    { id: 'downloads', group: null, title: 'Загрузки', url: 'downloads.html' }
  ];
}

// Адрес раздела во фрейме: страницы расширения берут тайтл из ?slug= (title-store.js)
function panelFrameSrc(section, slug) {
  if (!slug) return section.url;
  return `${section.url}${section.url.includes('?') ? '&' : '?'}slug=${encodeURIComponent(slug)}`;
}

// Выбранные главы: правка из раздела «Главы» (selectedChapterIds), иначе диапазон popup/быстрого окошка (filteredChapters), иначе все
function selectedIds(title) {
  if (Array.isArray(title?.selectedChapterIds)) return title.selectedChapterIds;
  return [...new Set((title?.filteredChapters ?? title?.chapters ?? []).map(chapter => chapter.id))];
}

// selected/total - главы, fields - включённые поля метаданных, covers - обложки
function panelCounts(title, metadataFields) {
  return {
    selected: selectedIds(title).length,
    total: getUniqueChapters(title?.chapters ?? []).length,
    fields: metadataFields ? Object.values(metadataFields).filter(Boolean).length : DEFAULT_METADATA_FIELDS,
    covers: (title?.covers ?? []).length
  };
}

// Подпись раздела в телефонном списке. settings - значения из storage плюс format (выбранный формат файла)
function sectionSubtitle(id, settings, counts) {
  const lastTwo = counts.fields % 100;
  const last = counts.fields % 10;
  switch (id) {
    case 'chapters': return `${counts.selected} из ${counts.total}`;
    case 'metadata': return `${counts.fields} ${lastTwo >= 11 && lastTwo <= 14 ? 'полей' : last === 1 ? 'поле' : last >= 2 && last <= 4 ? 'поля' : 'полей'}`;
    case 'covers': return String(counts.covers);
    case 'images': return IMAGE_QUALITY_LABELS[settings.imageQuality || 'ORIGINAL'] ?? '';
    case 'toc': return TOC_FORMAT_LABELS[settings.tocFormat || 'default'] ?? '';
    case 'format': return settings.format?.toUpperCase() ?? '';
    default: return '';
  }
}

// ---- Страница ----

function startPanel() {
  const params = new URLSearchParams(location.search);
  const $ = id => document.getElementById(id);
  const [titleEl, backButton, loadingEl, errorEl, mainEl, menuEl, framesEl, footEl, statusEl, formatSelect, speedBox, downloadButton] =
    ['title', 'back', 'loading', 'error', 'main', 'menu', 'frames', 'foot', 'status', 'format', 'speed', 'download'].map($);

  // Вкладка, адрес и origin страницы - от фона (whoami), не из параметров адреса
  let embedder = null;
  let single = false; // не страница тайтла: нет тайтла для загрузки, доступны только «Загрузки»
  let info = null;
  let slug = '';
  let loaded = false;
  let busy = false;
  let phone = false;
  let view = 'list'; // на телефоне: 'list' - список разделов, 'section' - раздел
  let current = DEFAULT_SECTION;
  let format = null;
  let stored = {};
  let counts = { selected: 0, total: 0, fields: DEFAULT_METADATA_FIELDS, covers: 0 };
  let active = 0; // тайтлов в работе в очереди
  let headerTitle = 'LibSaver';
  let refreshTicket = 0;
  const frames = new Map();

  const post = message => {
    if (embedder) window.parent.postMessage({ libsaver: true, ...message }, embedder.parentOrigin);
  };
  const show = name => {
    for (const [id, el] of [['loading', loadingEl], ['error', errorEl], ['main', mainEl]]) el.classList.toggle('hidden', id !== name);
  };
  const showError = (text, canRetry = true) => {
    $('error-text').textContent = text;
    $('retry').classList.toggle('hidden', !canRetry);
    footEl.classList.add('hidden');
    show('error');
  };
  const sections = () => single ? PANEL_SECTIONS(null).filter(section => section.id === 'downloads') : PANEL_SECTIONS(format);

  // Справа от пункта: на широком экране число, на телефоне подпись (для «Загрузок» - тоже число)
  const noteFor = section => {
    const count = { chapters: counts.selected, metadata: counts.fields, covers: counts.covers, downloads: active || '' }[section.id] ?? '';
    const subtitle = sectionSubtitle(section.id, { ...stored, format }, counts);
    return String(phone ? subtitle || count : count);
  };

  const createItem = section => {
    const button = document.createElement('button');
    button.setAttribute('type', 'button');
    const selected = !phone && section.id === current;
    button.className = selected ? 'pn-item on' : 'pn-item';
    if (selected) button.setAttribute('aria-current', 'page');
    const label = document.createElement('span');
    label.textContent = section.title;
    const note = document.createElement('small');
    note.textContent = noteFor(section);
    button.append(label, note);
    button.addEventListener('click', () => showSection(section.id));
    return button;
  };

  const renderMenu = () => {
    const list = sections();
    const nodes = [];
    for (const group of PANEL_GROUPS) {
      const items = list.filter(section => section.group === group.id);
      if (items.length === 0) continue;
      const heading = document.createElement('div');
      heading.className = 'pn-group';
      heading.textContent = group.title;
      nodes.push(heading, ...items.map(createItem));
    }
    const rule = document.createElement('div');
    rule.className = 'pn-rule';
    nodes.push(rule, ...list.filter(section => !section.group).map(createItem));
    menuEl.replaceChildren(...nodes);
  };

  // Esc во фрейме: до страницы сайта он не доходит
  const onEscape = event => {
    if (event.key === 'Escape' && !event.defaultPrevented) post({ type: 'close' });
  };

  // Фрейм раздела создаётся при первом открытии и живёт до закрытия окна, чтобы не терять несохранённые правки
  const mountSection = section => {
    const src = panelFrameSrc(section, slug);
    let frame = frames.get(section.id);
    if (!frame) {
      frame = document.createElement('iframe');
      frame.setAttribute('title', section.title);
      // Страницы расширения - того же origin, до их документа можно дотянуться
      frame.addEventListener('load', () => {
        try { frame.contentDocument.addEventListener('keydown', onEscape); } catch (e) { /* чужой документ */ }
      });
      frames.set(section.id, frame);
      framesEl.append(frame);
    }
    if (frame.dataset.src !== src) { // формат сменился - у раздела «формат» другая группа
      frame.dataset.src = src;
      frame.src = src;
    }
    for (const [id, other] of frames) other.classList.toggle('active', id === section.id);
  };

  // Всё, что зависит от ширины окна, выбранного раздела и данных. Идемпотентно
  function update() {
    if (!loaded) return;
    phone = window.innerWidth < PANEL_PHONE_WIDTH;
    const list = sections();
    if (!list.some(section => section.id === current)) current = single ? 'downloads' : DEFAULT_SECTION; // формат сменился, раздела больше нет
    const inSection = single || !phone || view === 'section';
    const body = document.body;
    body.classList.toggle('phone', phone);
    body.classList.toggle('in-section', inSection);
    body.classList.toggle('single', single);
    const section = list.find(candidate => candidate.id === current);
    const overList = phone && inSection && !single;
    backButton.classList.toggle('hidden', !overList);
    titleEl.textContent = overList ? section.title : headerTitle;
    footEl.classList.toggle('hidden', single);
    if (inSection) mountSection(section);
    renderMenu();
  }

  function showSection(id) {
    current = id;
    view = 'section';
    update();
  }

  // Данные тайтла и настройки из storage -> счётчики, формат, «Ускорить», кнопка «Скачать»
  async function refresh() {
    const ticket = ++refreshTicket;
    const formatKey = formatKeyFor(info.siteType);
    const [{ titleData }, values] = await Promise.all([
      getTitleStore(['titleData'], slug),
      chrome.storage.local.get(['metadataFields', 'imageQuality', 'tocFormat', 'speedMode', formatKey])
    ]);
    if (ticket !== refreshTicket) return; // пришёл более свежий ответ
    const title = titleData[slug];
    stored = values;
    counts = panelCounts(title, values.metadataFields);
    headerTitle = title?.metadata?.titleRu || info.title;
    format = formatOptionsFor(info.siteType).some(option => option.value === values[formatKey]) ? values[formatKey] : defaultFormatFor(info.siteType);
    formatSelect.value = format;
    speedBox.checked = !!values.speedMode;
    downloadButton.textContent = counts.selected > 0 ? downloadLabel(counts.selected) : 'Скачать';
    downloadButton.disabled = busy || counts.selected === 0;
    update();
  }

  // Счётчик у «Загрузок»: тайтлы в работе по состоянию очереди. Порт один; оборвался - счётчик гаснет (окно живёт недолго)
  async function watchQueue() {
    try {
      await chrome.runtime.sendMessage({ action: 'ensureEngine' });
      const port = chrome.runtime.connect({ name: 'libsaver-engine' });
      const setActive = number => {
        active = number;
        renderMenu();
      };
      port.onMessage.addListener(message => {
        if (message?.type === 'state') setActive((message.state?.items || []).filter(item => ACTIVE_STATUSES.includes(item.status)).length);
      });
      port.onDisconnect.addListener(() => setActive(0));
    } catch (e) { /* движок недоступен: счётчика не будет */ }
  }

  async function load(force) {
    if (!embedder || single) return; // встроившего нас не опознали (whoami) или это не тайтл: ни storage, ни загрузки
    show('loading');
    try {
      info = await loadQuickTitle({ tabId: embedder.tabId, url: embedder.url, force });
      slug = info.slug;
      formatSelect.replaceChildren(...formatOptionsFor(info.siteType).map(({ value, label }) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        return option;
      }));
      await refresh();
    } catch (error) {
      console.error('[LibSaver] panel', error);
      showError(loadErrorText(error));
      return;
    }
    const wanted = params.get('section');
    if (sections().some(section => section.id === wanted)) {
      current = wanted;
      view = 'section';
    }
    loaded = true;
    show('main');
    update();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && ['titleData:' + slug, 'metadataFields', 'imageQuality', 'tocFormat', 'speedMode', formatKeyFor(info.siteType)].some(key => key in changes)) refresh().catch(error => console.error('[LibSaver] panel', error));
    });
    watchQueue();
  }

  formatSelect.addEventListener('change', () => {
    if (info) chrome.storage.local.set({ [formatKeyFor(info.siteType)]: formatSelect.value });
  });
  speedBox.addEventListener('change', () => {
    if (info) chrome.storage.local.set({ speedMode: speedBox.checked });
  });
  downloadButton.addEventListener('click', async () => {
    if (!embedder || single || !info || busy) return;
    busy = true;
    downloadButton.disabled = true;
    statusEl.textContent = '';
    try {
      const { titleData } = await getTitleStore(['titleData'], slug);
      const result = await enqueueSelection({ slug, tabId: embedder.tabId, url: embedder.url, selectedChapterIds: selectedIds(titleData[slug]), format: formatSelect.value });
      if (result.ok) showSection('downloads');
      else statusEl.textContent = result.message;
    } catch (error) {
      statusEl.textContent = `Не удалось начать загрузку: ${error.message}`;
    }
    busy = false;
    downloadButton.disabled = counts.selected === 0;
  });
  backButton.addEventListener('click', () => {
    view = 'list';
    update();
  });
  $('close').addEventListener('click', () => post({ type: 'close' }));
  $('retry').addEventListener('click', () => load(true));
  document.addEventListener('keydown', onEscape);
  window.addEventListener('resize', update);
  // Редакторы после сохранения шлют toast - показываем его здесь
  chrome.runtime.onMessage.addListener(message => {
    if (message?.action === 'showToast') showToast(message.message, message.type);
  });

  loadAndApplyTheme();
  setupThemeMessageListener();
  (async () => {
    let me = null;
    try {
      me = await chrome.runtime.sendMessage({ action: 'whoami' });
    } catch (e) { /* расширение обновили */ }
    const tabParam = params.get('tab');
    embedder = verifiedEmbedder(me, tabParam);
    if (!embedder) { // не страница тайтла: плашка на каталоге открывает только «Загрузки»
      embedder = verifiedEmbedder(me, tabParam, { requireTitle: false });
      single = !!embedder;
    }
    if (!embedder) {
      showError('Окно работает только на страницах поддерживаемых сайтов.', false);
      return;
    }
    window.applySiteAccent(embedder.url);
    if (single) {
      current = 'downloads';
      loaded = true;
      headerTitle = 'Загрузки';
      show('main');
      update();
    } else {
      load(false);
    }
  })();
}

if (typeof document !== 'undefined') startPanel();
