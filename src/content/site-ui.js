// site-ui.js - кнопки «Скачать» и ⚙ под «Начать читать» на странице тайтла и окно расширения поверх сайта.
// Скрипты контента (manifest.json): core/theme.js (ACCENT_COLORS), utils/page-call.js (siteKeyOf, getSiteConfig), utils/formats.js (ключ формата), этот файл.
// Кнопки и окно живут в закрытых Shadow DOM, а действия принимают только от настоящих кликов (isTrusted):
// скрипты сайта не достают до наших элементов и не запускают наши действия.

// Кнопка «Начать читать». Проверено на живых сайтах 2026-10-17 (без входа): mangalib.me, ranobelib.me и hentailib.me
// отдают одну вёрстку: a.btn.is-filled.variant-primary[href*="/read/"], классы родителя хешированные (не использовать).
// SlashLIB не проверялся: та же платформа. Ссылка чтения - /ru/<slug>/read/..., без /manga/.
const READ_BUTTON = ['a.btn.variant-primary[href*="/read/"]'];
const SITE_ANCHORS = { mangalib: READ_BUTTON, hentailib: READ_BUTTON, shlib: READ_BUTTON, ranobelib: READ_BUTTON };

// Акцент сайта - имя в ACCENT_COLORS (core/theme.js)
const SITE_ACCENT = { mangalib: 'manga', hentailib: 'hentai', shlib: 'slash', ranobelib: 'ranobe' };

const OVERLAY_Z_INDEX = 2147483000;
const ANCHOR_WAIT_MS = 10000;

const extensionBase = () => chrome.runtime.getURL('');

// Тот же slug, что берёт title-loader.js (slugPattern сайта)
function titleSlug(url) {
  const config = getSiteConfig(url);
  const match = config && new URL(url).pathname.replace(/\/$/, '').match(config.slugPattern);
  return match ? match[1] + (match[2] || '') : null;
}

// Параметры страницы расширения во фрейме: slug, вкладка сайта, адрес страницы и origin для postMessage обратно
function frameQuery(pageUrl, tabId, parentOrigin) {
  return new URLSearchParams({ slug: titleSlug(pageUrl) || '', tab: String(tabId), url: pageUrl, parent: parentOrigin });
}

// Окно настроек; section - раздел, на котором открыться. В Task 10 html/workspace.html заменится на html/panel.html - это единственное место
function buildPanelUrl(pageUrl, tabId, parentOrigin, section) {
  const query = frameQuery(pageUrl, tabId, parentOrigin);
  if (section) query.set('section', section);
  return `${chrome.runtime.getURL('html/workspace.html')}?${query}`;
}

function buildQuickUrl(pageUrl, tabId, parentOrigin) {
  return `${chrome.runtime.getURL('html/quick.html')}?${frameQuery(pageUrl, tabId, parentOrigin)}`;
}

// Цвет кнопок: принудительный акцент из настроек, иначе цвет сайта (как applySiteAccent)
function accentFor(siteKey, forcedAccent, isDark) {
  const set = ACCENT_COLORS[forcedAccent] || ACCENT_COLORS[SITE_ACCENT[siteKey]] || ACCENT_COLORS.social;
  return isDark ? { color: set.dark, hover: set.hoverDark } : { color: set.light, hover: set.hoverLight };
}

// ---- Окно поверх сайта ----

let overlay = null; // { host, frame, overflow, onKey, onMessage }

// Сообщения iframe -> страница (протокол: { libsaver: true, type, ... }). Окошко «Скачать» понимает ещё 'resize' и 'openPanel' (popoverMessageHandlers)
const frameMessageHandlers = { close: () => closeOverlay() };

// Сообщение настоящее, если пришло из нашего iframe с origin расширения
function isTrustedFrameMessage(event, frame) {
  return event.source === frame.contentWindow && event.origin === extensionBase().replace(/\/$/, '') && event.data?.libsaver === true;
}

// Пока стили расширения не загрузились, элемент скрыт: без вспышки голой вёрстки (и без неё вовсе, если стили заблокированы)
function addStyles(doc, host, shadow) {
  const link = doc.createElement('link');
  link.setAttribute('rel', 'stylesheet');
  link.setAttribute('href', chrome.runtime.getURL('css/site-ui.css'));
  link.addEventListener('load', () => { host.style.display = ''; });
  host.style.display = 'none';
  shadow.append(link);
}

function openOverlay(src) {
  if (!src.startsWith(extensionBase())) return;
  closePopover();
  closeOverlay();
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;inset:0;z-index:${OVERLAY_Z_INDEX};`;
  const shadow = host.attachShadow({ mode: 'closed' });
  addStyles(document, host, shadow);
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const frame = document.createElement('iframe');
  frame.className = 'frame';
  frame.setAttribute('title', 'LibSaver');
  frame.src = src;
  backdrop.append(frame);
  shadow.append(backdrop);

  const onKey = event => {
    if (event.key !== 'Escape' || !event.isTrusted) return;
    event.stopPropagation();
    closeOverlay();
  };
  const onMessage = event => {
    if (isTrustedFrameMessage(event, frame)) frameMessageHandlers[event.data.type]?.(event.data);
  };
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop && event.isTrusted) closeOverlay();
  });
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('message', onMessage);

  overlay = { host, frame, overflow: document.documentElement.style.overflow, onKey, onMessage };
  document.documentElement.style.overflow = 'hidden';
  document.documentElement.append(host);
}

function closeOverlay() {
  if (!overlay) return;
  const { host, overflow, onKey, onMessage } = overlay;
  overlay = null;
  host.remove();
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('message', onMessage);
  document.documentElement.style.overflow = overflow;
}

// ---- Кнопки под «Начать читать» ----

async function whoami() {
  try {
    return await chrome.runtime.sendMessage({ action: 'whoami' });
  } catch (e) {
    return null; // расширение обновили, пока страница была открыта
  }
}

async function openSettings(section) {
  const me = await whoami();
  if (me?.tabId == null) return;
  openOverlay(buildPanelUrl(location.href, me.tabId, location.origin, section));
}

// ---- Быстрое окошко «Скачать» под кнопками ----

const POPOVER_MIN_WIDTH = 280;
const POPOVER_GAP = 6;
const POPOVER_MARGIN = 8;
const POPOVER_INITIAL_HEIGHT = 96; // до первого resize от окошка

let popover = null; // { host, anchor, height, listeners: [[type, handler, capture]] }

// Ширина - как у ряда кнопок (не меньше 280px). Под рядом, если там хватает места, иначе над ним; высота урезается до места.
// rect - ряд кнопок, view - размер окна страницы
function popoverPlacement(rect, height, view) {
  const width = Math.min(Math.max(rect.width, POPOVER_MIN_WIDTH), view.width - 2 * POPOVER_MARGIN);
  const left = Math.min(Math.max(rect.left, POPOVER_MARGIN), view.width - width - POPOVER_MARGIN);
  const below = view.height - rect.bottom - POPOVER_GAP - POPOVER_MARGIN;
  const above = rect.top - POPOVER_GAP - POPOVER_MARGIN;
  if (height <= below || below >= above) return { left, top: rect.bottom + POPOVER_GAP, width, height: Math.min(height, below) };
  const fitted = Math.min(height, above);
  return { left, top: rect.top - POPOVER_GAP - fitted, width, height: fitted };
}

function placePopover() {
  if (!popover) return;
  const { host, anchor, height } = popover;
  if (anchor.isConnected === false) { // SPA убрала кнопки
    closePopover();
    return;
  }
  const root = document.documentElement;
  const place = popoverPlacement(anchor.getBoundingClientRect(), height, { width: root.clientWidth, height: root.clientHeight });
  Object.assign(host.style, { left: `${place.left}px`, top: `${place.top}px`, width: `${place.width}px`, height: `${place.height}px` });
}

function resizePopover(height) {
  if (!popover) return;
  popover.height = height;
  placePopover();
}

// Сообщения окошка -> страница. «Подробнее…» открывает окно расширения на нужном разделе
const popoverMessageHandlers = {
  close: () => closePopover(),
  resize: ({ height }) => {
    if (Number.isFinite(height)) resizePopover(height);
  },
  openPanel: ({ section }) => {
    closePopover();
    openSettings(typeof section === 'string' ? section : undefined);
  }
};

function closePopover() {
  if (!popover) return;
  const { host, listeners } = popover;
  popover = null;
  host.remove();
  for (const [type, handler, capture] of listeners) window.removeEventListener(type, handler, capture);
}

// Повторный клик «Скачать» закрывает окошко. anchor - хост кнопок: клики по нему окошко не закрывают само, их разбирают кнопки
async function openQuickPopover(anchor) {
  if (popover) {
    closePopover();
    return;
  }
  const me = await whoami();
  if (me?.tabId == null || popover) return;

  const host = document.createElement('div');
  host.style.cssText = `position:fixed;z-index:${OVERLAY_Z_INDEX};`;
  const shadow = host.attachShadow({ mode: 'closed' });
  addStyles(document, host, shadow);
  const frame = document.createElement('iframe');
  frame.className = 'popover-frame';
  frame.setAttribute('title', 'LibSaver');
  frame.src = buildQuickUrl(location.href, me.tabId, location.origin);
  shadow.append(frame);

  const listeners = [
    ['keydown', event => { if (event.key === 'Escape' && event.isTrusted) closePopover(); }, true],
    ['pointerdown', event => { if (event.isTrusted && event.target !== host && event.target !== anchor) closePopover(); }, true],
    ['message', event => {
      const type = event.data?.type;
      if (isTrustedFrameMessage(event, frame) && Object.hasOwn(popoverMessageHandlers, type)) popoverMessageHandlers[type](event.data);
    }, false],
    ['resize', placePopover, false],
    ['scroll', placePopover, true]
  ];
  for (const [type, handler, capture] of listeners) window.addEventListener(type, handler, capture);
  popover = { host, anchor, height: POPOVER_INITIAL_HEIGHT, listeners };
  placePopover();
  document.documentElement.append(host);
}

// Иконки - Font Awesome из расширения; @font-face внутри Shadow DOM не работает, поэтому шрифт объявляется в документе под своим именем
function ensureIconFont(doc) {
  if (doc.querySelector('style[data-libsaver-font]')) return;
  const style = doc.createElement('style');
  style.setAttribute('data-libsaver-font', '');
  style.textContent = `@font-face{font-family:"LibSaver FA";font-weight:900;src:url("${chrome.runtime.getURL('libs/fontawesome/webfonts/fa-solid-900.woff2')}") format("woff2");}`;
  (doc.head || doc.documentElement).append(style);
}

function createButton(doc, className, label, icon) {
  const button = doc.createElement('button');
  button.className = className;
  button.setAttribute('type', 'button');
  button.setAttribute('aria-label', label);
  const glyph = doc.createElement('i');
  glyph.className = 'icon';
  glyph.textContent = icon;
  button.append(glyph);
  return button;
}

function createButtonsHost(doc, siteKey) {
  ensureIconFont(doc);
  const host = doc.createElement('div');
  host.setAttribute('data-libsaver-buttons', '');
  const shadow = host.attachShadow({ mode: 'closed' });
  addStyles(doc, host, shadow);

  const download = createButton(doc, 'download', 'Скачать', ''); // fa-download
  const label = doc.createElement('span');
  label.textContent = 'Скачать';
  const format = doc.createElement('small');
  format.className = 'format';
  download.append(label, format);
  const settings = createButton(doc, 'settings', 'Настройки LibSaver', ''); // fa-gear
  settings.setAttribute('title', 'Настройки LibSaver');
  download.addEventListener('click', event => { if (event.isTrusted) openQuickPopover(host); });
  settings.addEventListener('click', event => { if (event.isTrusted) openSettings(); });

  const row = doc.createElement('div');
  row.className = 'row';
  row.append(download, settings);
  shadow.append(row);

  const siteType = siteKey === 'ranobelib' ? 'ranobe' : 'manga';
  const formatKey = formatKeyFor(siteType);
  const refresh = () => chrome.storage.local.get(['accentColor', 'theme', formatKey]).then(stored => {
    const isDark = stored.theme === 'light' ? false : stored.theme === 'system' ? doc.defaultView.matchMedia('(prefers-color-scheme: dark)').matches : true;
    const accent = accentFor(siteKey, stored.accentColor, isDark);
    host.style.setProperty('--ls-accent', accent.color);
    host.style.setProperty('--ls-accent-hover', accent.hover);
    format.textContent = (stored[formatKey] || defaultFormatFor(siteType)).toUpperCase();
  }).catch(() => {});
  refresh();
  // Формат выбирают в быстром окошке и в окне «Подготовка», акцент и тему - в настройках: подпись и цвет подхватывают сразу
  const onChanged = (changes, area) => {
    if (host.isConnected === false) { // SPA убрала кнопки
      chrome.storage.onChanged.removeListener(onChanged);
      return;
    }
    if (area === 'local' && ['accentColor', 'theme', formatKey].some(key => key in changes)) refresh();
  };
  chrome.storage.onChanged.addListener(onChanged);
  return host;
}

// Размер и радиус - как у «Начать читать»; в узкой сетке (две колонки) занимаем свою строку целиком
function fitToAnchor(doc, host, anchor) {
  const own = doc.defaultView.getComputedStyle(anchor);
  host.style.setProperty('--ls-height', own.height);
  host.style.setProperty('--ls-radius', own.borderRadius);
  host.style.setProperty('--ls-width', own.width);
  const columns = doc.defaultView.getComputedStyle(anchor.parentElement).gridTemplateColumns || '';
  host.style.gridColumn = columns.trim().split(/\s+/).length > 1 ? '1 / -1' : '';
}

// Идемпотентно: вызывается после каждого изменения страницы. Что открывать по клику, кнопки узнают в момент клика
// (location.href), поэтому при переходе на другой тайтл без пересоздания хоста slug не устаревает.
function ensureButtons(doc, url) {
  const existing = doc.querySelector('[data-libsaver-buttons]');
  if (!isTitlePage(url)) {
    existing?.remove();
    return 'not-title';
  }
  const siteKey = siteKeyOf(url);
  const anchor = (SITE_ANCHORS[siteKey] || []).map(selector => doc.querySelector(selector)).find(Boolean);
  if (existing) {
    if (anchor) fitToAnchor(doc, existing, anchor);
    return 'present';
  }
  if (!anchor) return 'no-anchor';
  const host = createButtonsHost(doc, siteKey);
  anchor.insertAdjacentElement('afterend', host);
  fitToAnchor(doc, host, anchor);
  return 'inserted';
}

// SPA: следим за DOM и адресом. Якорь не появился за 10 с на этом адресе - молчим до смены адреса
function startSiteUi() {
  if (!document.body) return;
  let lastHref = '';
  let anchorDeadline = 0;
  let gaveUp = false;
  let timer = 0;
  const check = () => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      anchorDeadline = Date.now() + ANCHOR_WAIT_MS;
      gaveUp = false;
    }
    if (gaveUp) return;
    try {
      const result = ensureButtons(document, location.href);
      if (result === 'inserted' || result === 'present') anchorDeadline = Date.now() + ANCHOR_WAIT_MS;
      else if (result === 'no-anchor' && Date.now() > anchorDeadline) gaveUp = true;
    } catch (e) {
      console.error('[LibSaver] site-ui', e);
      gaveUp = true;
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(check, 200);
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', schedule);
  check();
}

if (typeof document !== 'undefined') startSiteUi();
