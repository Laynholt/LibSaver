// site-ui.js - кнопки «Скачать» и ⚙ под «Начать читать» на странице тайтла, окно расширения поверх сайта и плашка с ходом загрузки.
// Скрипты контента (manifest.json): core/theme.js (ACCENT_COLORS), utils/page-call.js (siteKeyOf, getSiteConfig), utils/formats.js (ключ формата), этот файл.
// Кнопки, окно и плашка живут в закрытых Shadow DOM, а действия принимают только от настоящих кликов (isTrusted):
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
// Закрытое окно ещё столько живёт скрытым: редакторы успевают дописать автосохранение (400 мс), а не теряют его вместе с фреймом
const OVERLAY_REMOVE_DELAY = 1500;

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

// Окно настроек; section - раздел, на котором открыться (id из PANEL_SECTIONS в core/panel.js)
function buildPanelUrl(pageUrl, tabId, parentOrigin, section) {
  const query = frameQuery(pageUrl, tabId, parentOrigin);
  if (section) query.set('section', section);
  return `${chrome.runtime.getURL('html/panel.html')}?${query}`;
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

let overlay = null; // { src, host, frame, overflow, onKey, onMessage }
let closingOverlay = null; // последнее закрытое окно, пока фрейм доживает: { src, host, frame, timer } (его можно открыть снова)
const closingHosts = new Set(); // все закрытые и ещё не удалённые окна: каждое удаляет свой таймер

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

function createOverlayHost(src) {
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
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop && event.isTrusted) closeOverlay();
  });
  return { host, frame };
}

// Закрытое окно ещё живо и на том же адресе - открываем его же (с несохранённым состоянием), иначе убираем его сразу
function openOverlay(src) {
  if (!src.startsWith(extensionBase())) return;
  closePopover();
  closeOverlay();
  const reused = closingOverlay?.src === src && closingOverlay.host.isConnected !== false ? closingOverlay : null;
  if (reused) {
    clearTimeout(reused.timer);
    closingHosts.delete(reused);
    closingOverlay = null;
  }
  // Другое закрытое окно не трогаем: его фрейм дописывает автосохранение и удалится по своему таймеру
  const { host, frame } = reused || createOverlayHost(src);
  Object.assign(host.style, { visibility: '', pointerEvents: '' });
  host.inert = false;

  const onKey = event => {
    if (event.key !== 'Escape' || !event.isTrusted) return;
    event.stopPropagation();
    closeOverlay();
  };
  const onMessage = event => {
    if (isTrustedFrameMessage(event, frame)) frameMessageHandlers[event.data.type]?.(event.data);
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('message', onMessage);

  overlay = { src, host, frame, overflow: document.documentElement.style.overflow, onKey, onMessage };
  document.documentElement.style.overflow = 'hidden';
  if (!reused) document.documentElement.append(host);
}

// Страница могла выбросить хост окна из документа: пересоздаём его на том же адресе
function reviveOverlay() {
  if (!overlay || overlay.host.isConnected !== false) return;
  const { src } = overlay;
  closeOverlay();
  openOverlay(src);
}

// Все закрытия (Esc, фон, ✕ / postMessage 'close', SPA) идут сюда: окно пропадает сразу, а хост с фреймом удаляется через
// OVERLAY_REMOVE_DELAY - автосохранение редактора (pagehide ждёт чтения storage) не обрывается вместе с фреймом
function closeOverlay() {
  if (!overlay) return;
  const { src, host, frame, overflow, onKey, onMessage } = overlay;
  overlay = null;
  Object.assign(host.style, { visibility: 'hidden', pointerEvents: 'none' });
  host.inert = true;
  window.focus(); // фокус из скрытого фрейма - обратно странице
  if (host.isConnected !== false) { // хост, снятый самой страницей, доживать не может
    const entry = { src, host, frame }; // frame нужен, если окно откроют снова: по нему проверяются его сообщения
    entry.timer = setTimeout(() => dropClosingOverlay(entry), OVERLAY_REMOVE_DELAY);
    closingHosts.add(entry);
    closingOverlay = entry;
  } else {
    host.remove();
  }
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('message', onMessage);
  document.documentElement.style.overflow = overflow;
}

function dropClosingOverlay(entry) {
  clearTimeout(entry.timer);
  closingHosts.delete(entry);
  if (closingOverlay === entry) closingOverlay = null;
  entry.host.remove();
}

function removeClosingOverlay() {
  for (const entry of [...closingHosts]) dropClosingOverlay(entry);
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

let popover = null; // { host, anchor, slug, height, listeners: [[type, handler, capture]] }

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

// SPA перешла на другой тайтл, не заменив кнопки: окошко осталось бы от прежнего
function closePopoverOnTitleChange(url) {
  if (popover && popover.slug !== titleSlug(url)) closePopover();
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
  popover = { host, anchor, slug: titleSlug(location.href), height: POPOVER_INITIAL_HEIGHT, listeners };
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

// Перерисовщики кнопок «Скачать» на странице (по одному на хост)
const buttonPainters = new Set();

function paintButtons() {
  for (const paint of [...buttonPainters]) paint();
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
  const fill = doc.createElement('span'); // полоска хода загрузки
  fill.className = 'fill';
  const label = doc.createElement('span');
  label.textContent = 'Скачать';
  const format = doc.createElement('small');
  format.className = 'format';
  const percent = doc.createElement('span');
  percent.className = 'percent';
  download.append(fill, label, format, percent);
  const settings = createButton(doc, 'settings', 'Настройки LibSaver', ''); // fa-gear
  settings.setAttribute('title', 'Настройки LibSaver');
  download.addEventListener('click', event => { if (event.isTrusted) openQuickPopover(host); });
  settings.addEventListener('click', event => { if (event.isTrusted) openSettings(); });

  const row = doc.createElement('div');
  row.className = 'row';
  row.append(download, settings);
  shadow.append(row);

  // Ход загрузки этого тайтла: полоска и «45%» (на месте формата) или «В очереди»; адрес читаем в момент вызова - SPA меняет тайтл под тем же хостом
  const paint = () => {
    if (host.isConnected === false) { // SPA убрала кнопки
      buttonPainters.delete(paint);
      return;
    }
    const progress = buttonProgress(engine.state, siteKeyByHost(location.href), titleSlug(location.href));
    download.setAttribute('data-state', progress?.kind || '');
    fill.style.width = `${progress?.percent ?? 0}%`;
    percent.textContent = progress?.kind === 'running' ? `${progress.percent}%` : '';
    label.textContent = progress?.kind === 'queued' ? 'В очереди' : 'Скачать';
  };
  buttonPainters.add(paint);
  paint();

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
  // Формат выбирают в быстром окошке и в окне поверх сайта, акцент и тему - в настройках: подпись и цвет подхватывают сразу
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
    if (!anchor) return 'present';
    fitToAnchor(doc, existing, anchor);
    if (anchor.nextElementSibling === existing) return 'present';
    anchor.insertAdjacentElement('afterend', existing); // SPA перерисовала ряд: хост остался не на своём месте
    return 'moved';
  }
  if (!anchor) return 'no-anchor';
  const host = createButtonsHost(doc, siteKey);
  anchor.insertAdjacentElement('afterend', host);
  fitToAnchor(doc, host, anchor);
  return 'inserted';
}

// ---- Ход загрузки: состояние очереди от движка ----

const ENGINE_RETRY_MS = 1000;
const ENGINE_MAX_RETRIES = 5;
const ENGINE_STABLE_MS = 5000; // связь, продержавшаяся столько, - не мигание: счётчик неудач обнуляется
const ENGINE_PING_MS = 20000; // пока есть тайтлы в работе: фоновая страница Firefox (MV3) без входящих сообщений засыпает

// failures - подряд неудачных подключений (сбрасываются, когда связь продержалась ENGINE_STABLE_MS); после ENGINE_MAX_RETRIES ждём смены адреса
const engine = { port: null, state: null, failures: 0, connectedAt: 0, connecting: false, stopped: false, timer: 0, pingTimer: 0 };

// После перезагрузки расширения chrome.runtime в старом скрипте остаётся без id и бросает на каждый вызов
function extensionAlive() {
  try {
    return !!chrome.runtime?.id;
  } catch (e) {
    return false;
  }
}

function setEngineState(state) {
  engine.state = state;
  keepEngineAwake();
  paintButtons();
  renderPlaque();
}

// Пинг идёт, пока порт открыт и в очереди есть работа; иначе (и при остановке) таймер снят
function keepEngineAwake() {
  const active = !engine.stopped && !!engine.port && (engine.state?.items || []).some(item => ACTIVE_STATUSES.includes(item.status));
  if (active && !engine.pingTimer) {
    engine.pingTimer = setInterval(() => {
      try { engine.port?.postMessage({ cmd: 'ping' }); } catch (e) { /* порт закрыт: onDisconnect снимет таймер */ }
    }, ENGINE_PING_MS);
  } else if (!active && engine.pingTimer) {
    clearInterval(engine.pingTimer);
    engine.pingTimer = 0;
  }
}

function onEngineLost(port) {
  if (port) {
    if (engine.port !== port) return;
    engine.port = null;
    if (Date.now() - engine.connectedAt >= ENGINE_STABLE_MS) engine.failures = 0;
  }
  setEngineState(null); // чужое состояние без связи не показываем
  if (engine.stopped) return;
  if (!extensionAlive()) {
    stopSiteUi();
    return;
  }
  if (++engine.failures <= ENGINE_MAX_RETRIES) engine.timer = setTimeout(connectEngine, ENGINE_RETRY_MS);
}

async function connectEngine() {
  if (engine.port || engine.connecting || engine.stopped) return;
  if (!extensionAlive()) {
    stopSiteUi();
    return;
  }
  engine.connecting = true;
  try {
    if (!(await chrome.runtime.sendMessage({ action: 'ensureEngine' }))) throw new Error('ensureEngine');
    if (engine.stopped) return;
    const port = chrome.runtime.connect({ name: 'libsaver-engine' });
    port.onMessage.addListener(message => {
      if (message?.type !== 'state') return;
      setEngineState(message.state);
    });
    port.onDisconnect.addListener(() => onEngineLost(port));
    engine.port = port;
    engine.connectedAt = Date.now();
  } catch (e) {
    onEngineLost(null);
  } finally {
    engine.connecting = false;
  }
}

// Смена адреса даёт новые попытки подключиться тому, кто исчерпал их
function retryEngine() {
  if (engine.failures <= ENGINE_MAX_RETRIES) return;
  engine.failures = 0;
  connectEngine();
}

function stopEngineLink() {
  engine.stopped = true;
  clearTimeout(engine.timer);
  keepEngineAwake();
  const { port } = engine;
  engine.port = null;
  try { port?.disconnect(); } catch (e) { /* контекст уже недействителен */ }
}

// ---- Плашка с ходом загрузки в углу ----

const PLAQUE_MARGIN = 16;
const PLAQUE_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const PLAQUE_DRAG_THRESHOLD = 5;
const ACTIVE_STATUSES = ['queued', 'running', 'paused', 'waiting-tab', 'waiting-decision'];

let plaque = null; // { host, title, detail, bar, button, stopDrag }
let plaqueCorner = 'bottom-right';

function progressPercent(item) {
  const { current, total, part = 0 } = item.progress || {}; // part - доля текущей главы по картинкам
  return total > 0 ? Math.min(100, Math.max(0, Math.round(100 * (current + part) / total))) : 0;
}

// Что показать на кнопке «Скачать» тайтла: ход идущей загрузки, очередь или ничего
function buttonProgress(state, siteKey, slug) {
  const mine = (state?.items || []).filter(item => item.slug === slug && item.siteKey === siteKey);
  const running = mine.find(item => item.status === 'running');
  if (running) return { kind: 'running', percent: progressPercent(running) };
  return mine.some(item => item.status === 'queued') ? { kind: 'queued' } : null;
}

// Текст плашки: { title, detail, percent? } или null, если качать нечего. Главный - идущий (или ждущий) тайтл, иначе первый в очереди.
// siteKeyOfPage - сайт страницы: подсказка, какую страницу открыть, если движок не назвал сайт
function plaqueText(state, siteKeyOfPage) {
  const active = (state?.items || []).filter(item => ACTIVE_STATUSES.includes(item.status));
  if (!active.length) return null;
  const item = active.find(candidate => candidate.status !== 'queued') || active[0];
  const queued = active.filter(other => other !== item && other.status === 'queued').length;
  let detail;
  switch (item.status) {
    case 'running': {
      const eta = state.stats?.etaSeconds != null && state.stats.estimated ? ` · ≈${state.stats.estimated}` : ''; // stats - всегда идущей загрузки
      const percent = progressPercent(item);
      return { title: item.title || item.slug, detail: `${percent}%${eta}${queued ? ` · +${queued} в очереди` : ''}`, percent };
    }
    case 'waiting-tab': detail = `Откройте страницу ${SITE_NAMES[item.siteKey || siteKeyOfPage] || item.siteKey || siteKeyOfPage}, чтобы продолжить`; break;
    case 'waiting-decision': detail = `Нужно решение: ошибка ${item.decision?.kind === 'image' ? 'картинки' : 'главы'}`; break;
    case 'paused': detail = 'Пауза'; break;
    default: detail = 'В очереди';
  }
  return { title: item.title || item.slug, detail };
}

// Ближайший угол окна к точке
function snapCorner(x, y, view) {
  return `${y < view.height / 2 ? 'top' : 'bottom'}-${x < view.width / 2 ? 'left' : 'right'}`;
}

function applyCorner(host) {
  const [vertical, horizontal] = plaqueCorner.split('-');
  const edge = (side, value) => value === side ? `${PLAQUE_MARGIN}px` : 'auto';
  Object.assign(host.style, { top: edge('top', vertical), bottom: edge('bottom', vertical), left: edge('left', horizontal), right: edge('right', horizontal) });
}

// Плашка открывает окно настроек на разделе «Загрузки»
function openDownloads() {
  openSettings('downloads');
}

function saveCorner() {
  try {
    chrome.storage.local.set({ plaqueCorner }).catch(() => {});
  } catch (e) { /* контекст недействителен */ }
}

function createPlaque(doc) {
  const host = doc.createElement('div');
  host.setAttribute('data-libsaver-plaque', '');
  host.style.cssText = `position:fixed;z-index:${OVERLAY_Z_INDEX - 1};`; // ниже окна и окошка «Скачать»
  const shadow = host.attachShadow({ mode: 'closed' });
  addStyles(doc, host, shadow);

  const button = doc.createElement('button');
  button.className = 'plaque';
  button.setAttribute('type', 'button');
  const title = doc.createElement('span');
  title.className = 'plaque-title';
  const detail = doc.createElement('span');
  detail.className = 'plaque-detail';
  const bar = doc.createElement('span');
  bar.className = 'plaque-bar';
  button.append(title, detail, bar);
  shadow.append(button);

  // Перетаскивание: сдвиг меньше порога - это клик. После отпускания плашка прилипает к ближайшему углу
  let dragged = false;
  const result = { host, title, detail, bar, button, stopDrag: () => {} };
  button.addEventListener('pointerdown', event => {
    if (!event.isTrusted || event.button !== 0) return;
    if (event.pointerType === 'mouse') event.preventDefault(); // без выделения текста страницы под рукой
    result.stopDrag();
    const start = { x: event.clientX, y: event.clientY };
    const rect = host.getBoundingClientRect();
    dragged = false;
    const onMove = move => {
      if (!dragged) {
        if (Math.hypot(move.clientX - start.x, move.clientY - start.y) < PLAQUE_DRAG_THRESHOLD) return;
        dragged = true;
        try { button.setPointerCapture(event.pointerId); } catch (e) { /* указатель уже отпущен */ }
      }
      Object.assign(host.style, { left: `${rect.left + move.clientX - start.x}px`, top: `${rect.top + move.clientY - start.y}px`, right: 'auto', bottom: 'auto' });
    };
    const onEnd = end => {
      result.stopDrag();
      if (!dragged) return;
      if (end.type === 'pointerup') {
        const root = doc.documentElement;
        plaqueCorner = snapCorner(end.clientX, end.clientY, { width: root.clientWidth, height: root.clientHeight });
        saveCorner();
      }
      applyCorner(host);
      setTimeout(() => { dragged = false; }, 0); // клик после отпускания придёт раньше; позднее нажатие с клавиатуры он не проглотит
    };
    const types = [['pointermove', onMove], ['pointerup', onEnd], ['pointercancel', onEnd]];
    for (const [type, handler] of types) window.addEventListener(type, handler, true);
    result.stopDrag = () => {
      for (const [type, handler] of types) window.removeEventListener(type, handler, true);
      result.stopDrag = () => {};
    };
  });
  button.addEventListener('click', event => {
    if (!event.isTrusted) return;
    if (dragged) { // клик после перетаскивания - не открытие
      dragged = false;
      return;
    }
    openDownloads();
  });
  applyCorner(host);
  return result;
}

function removePlaque() {
  if (!plaque) return;
  const { host, stopDrag } = plaque;
  plaque = null;
  stopDrag();
  host.remove();
}

// Идемпотентно: создаёт плашку, когда есть что показать (и когда страница её выбросила), обновляет тексты, убирает, когда качать нечего
function renderPlaque(doc = document) {
  const view = plaqueText(engine.state, siteKeyByHost(location.href));
  if (!view) {
    removePlaque();
    return;
  }
  if (!plaque || plaque.host.isConnected === false) {
    removePlaque();
    plaque = createPlaque(doc);
    doc.documentElement.append(plaque.host);
  }
  plaque.title.textContent = view.title;
  plaque.detail.textContent = view.detail;
  plaque.bar.style.width = `${view.percent ?? 0}%`;
  plaque.button.setAttribute('aria-label', `${view.title}: ${view.detail}`);
}

// Угол плашки общий для вкладок: сменили в одной - переехала во всех
function onPlaqueCornerChanged(changes, area) {
  const next = changes.plaqueCorner?.newValue;
  if (area !== 'local' || !PLAQUE_CORNERS.includes(next)) return;
  plaqueCorner = next;
  if (plaque) applyCorner(plaque.host);
}

// Иконка расширения на странице тайтла: popup просит фон, фон передаёт просьбу вкладке (action 'openPanel' в background.js).
// Ответ true - окно открыто: без него promise chrome.tabs.sendMessage отклоняется и popup не закрывается
function onRuntimeMessage(message, sender, sendResponse) {
  if (message?.action !== 'libsaver:openPanel' || sender?.id !== chrome.runtime.id) return;
  Promise.resolve(openSettings(typeof message.section === 'string' ? message.section : undefined)).then(() => sendResponse(true), () => sendResponse(false));
  return true;
}

// ---- Слежение за страницей ----

// Дебаунс, но не дольше maxWait с первого вызова: на странице с постоянными изменениями DOM кнопки всё равно появятся
function createScheduler(run, delay = 200, maxWait = 1000) {
  let timer = 0;
  let first = null;
  const schedule = () => {
    const now = Date.now();
    first ??= now;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      first = null;
      run();
    }, Math.max(0, Math.min(delay, first + maxWait - now)));
  };
  schedule.cancel = () => {
    clearTimeout(timer);
    timer = 0;
    first = null;
  };
  return schedule;
}

let stopSiteUi = () => {};

// SPA: следим за DOM и адресом. Якорь не появился за 10 с на этом адресе - молчим до смены адреса
function startSiteUi() {
  if (!document.body) return;
  let lastHref = '';
  let anchorDeadline = 0;
  let gaveUp = false;
  const check = () => {
    if (!extensionAlive()) { // расширение перезагрузили: этот скрипт больше ничего не может
      stopSiteUi();
      return;
    }
    if (location.href !== lastHref) {
      lastHref = location.href;
      anchorDeadline = Date.now() + ANCHOR_WAIT_MS;
      gaveUp = false;
      retryEngine();
    }
    try {
      closePopoverOnTitleChange(location.href);
      reviveOverlay();
      renderPlaque();
      paintButtons();
    } catch (e) {
      console.error('[LibSaver] site-ui', e);
    }
    if (gaveUp) return;
    try {
      const result = ensureButtons(document, location.href);
      if (['inserted', 'present', 'moved'].includes(result)) anchorDeadline = Date.now() + ANCHOR_WAIT_MS;
      else if (result === 'no-anchor' && Date.now() > anchorDeadline) gaveUp = true;
    } catch (e) {
      console.error('[LibSaver] site-ui', e);
      gaveUp = true;
    }
  };
  const schedule = createScheduler(check);
  // documentElement, а не body: окно и плашка живут в <html>, и их выбрасывание тоже надо заметить
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('resize', schedule);

  stopSiteUi = () => {
    stopSiteUi = () => {};
    observer.disconnect();
    schedule.cancel();
    window.removeEventListener('resize', schedule);
    stopEngineLink();
    try { chrome.storage.onChanged.removeListener(onPlaqueCornerChanged); } catch (e) { /* контекст недействителен */ }
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch (e) { /* контекст недействителен */ }
    document.querySelector('[data-libsaver-buttons]')?.remove();
    removePlaque();
    closePopover();
    closeOverlay();
    removeClosingOverlay(); // остановка - всё сразу, без отложенного удаления
  };

  if (siteKeyByHost(location.href)) {
    chrome.storage.onChanged.addListener(onPlaqueCornerChanged);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    chrome.storage.local.get('plaqueCorner').then(stored => onPlaqueCornerChanged({ plaqueCorner: { newValue: stored.plaqueCorner } }, 'local')).catch(() => {});
    connectEngine();
  }
  check();
}

if (typeof document !== 'undefined') startSiteUi();
