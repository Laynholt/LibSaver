// downloads-view.js - раздел «Загрузки»: клиент очереди фонового движка.
// Со скачиванием дела не имеет: команды и состояние ходят только через порт 'libsaver-engine'.

const RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 10000;
// Пока в очереди есть работа, порт раз в 20 с шлёт движку ping: фоновая страница Firefox (MV3) без входящих сообщений засыпает
const PING_INTERVAL = 20000;
const ACTIVE_STATUSES = ['queued', 'running', 'paused', 'waiting-tab', 'waiting-decision']; // как в engine/queue.js

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// Кнопки: команда -> [иконка, подпись]
const COMMAND_BUTTONS = {
  pause: ['fa-pause', 'Пауза'],
  resume: ['fa-play', 'Продолжить'],
  retry: ['fa-rotate-right', 'Повторить'],
  skip: ['fa-forward-step', 'Пропустить'],
  cancel: ['fa-xmark', 'Отменить'],
  saveAgain: ['fa-download', 'Сохранить файл ещё раз'],
  log: ['fa-circle-info', 'Логи'],
  remove: ['fa-trash', 'Убрать из очереди']
};

const STATUS_COMMANDS = {
  queued: ['cancel', 'remove'],
  running: ['pause', 'cancel'],
  paused: ['resume', 'cancel'],
  'waiting-tab': ['cancel'],
  'waiting-decision': ['retry', 'skip', 'cancel'],
  done: ['log', 'saveAgain', 'remove'],
  error: ['log', 'remove'],
  canceled: ['log', 'remove']
};

const unitsOf = item => item.siteKey === 'animelib' ? 'серий' : 'глав';

function renderCommandButton(command, id) {
  const [icon, label] = COMMAND_BUTTONS[command];
  return `<button class="dl-btn" data-cmd="${command}" data-id="${escapeHtml(id)}" title="${label}" aria-label="${label}"><i class="fa-solid ${icon}"></i><span>${label}</span></button>`;
}

let siteMirrors = {}; // рабочие зеркала сайтов (фон проверяет их сам): ссылка на зеркало идёт первой
let customSiteLinks = {};
let useCustomSiteLinks = true;
let enableSiteMenu = true; // свои ссылки - часть меню сайтов: без него настройки их скрывают
let enableMirrorSearch = true;

function renderSiteLinks(siteKey) {
  const defaults = siteLinks(siteKey);
  let custom = enableSiteMenu && useCustomSiteLinks && customSiteLinks[siteKey]?.trim().replace(/\/+$/, '');
  if (custom && !/^https?:\/\//i.test(custom)) custom = 'https://' + custom; // в настройках можно ввести домен без https://
  if (defaults.includes(custom)) custom = null; // стандартная ссылка из настроек не перебивает зеркало
  const mirror = enableMirrorSearch && siteMirrors[siteKey];
  return [...new Set([custom, mirror, ...defaults].filter(Boolean))]
    .map(url => `<a href="${escapeHtml(url)}" data-url="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url.replace('https://', ''))}</a>`)
    .join(' · ');
}

// Скорость и оставшееся время идущей загрузки: каждое - когда движок его посчитал (speed есть, etaSeconds не null)
function liveStats(stats) {
  return [stats?.speed, stats?.etaSeconds != null && stats.estimated && `осталось ≈${stats.estimated}`].filter(Boolean).join(' · ');
}

// Ошибка загрузки -> что случилось и что сделать, простыми словами. Неизвестная ошибка - совет открыть лог
const ERROR_HELP = [
  [/HTTP 429|Rate limited/i, 'Сайт ограничил частые запросы. Подождите несколько минут, снимите «Ускорить» и запустите загрузку снова.'],
  [/HTTP 40[13]/, 'Сайт не пустил к главам. Войдите в аккаунт на сайте и запустите загрузку снова.'],
  [/HTTP 404/, 'Глава или файл удалены с сайта. Обновите страницу тайтла и выберите главы заново.'],
  [/HTTP 5\d\d|Failed to fetch|NetworkError|нет ответа/i, 'Сайт не отвечает. Проверьте интернет или откройте зеркало сайта и запустите загрузку снова.'],
  [/сохранить файл/i, 'Браузер не сохранил файл. Проверьте папку загрузок и свободное место на диске.'],
  [/Выберите хотя бы одну|Не выбрано ни одной/, 'Отметьте главы в разделе «Главы» и нажмите «Скачать».'],
  [/Данные для загрузки не найдены/, 'Откройте страницу тайтла заново и нажмите «Скачать».']
];
function errorHelp(error) {
  const found = ERROR_HELP.find(([pattern]) => pattern.test(String(error || '')));
  return found ? found[1] : 'Нажмите «Логи» - там видно, на чём остановилась загрузка. Затем запустите её снова со страницы тайтла.';
}

// stats - статистика идущей загрузки (она одна)
function renderStatus(item, stats) {
  const { current, total } = item.progress;
  switch (item.status) {
    case 'queued': return 'В очереди';
    case 'running': return liveStats(stats) ? `Загрузка · ${escapeHtml(liveStats(stats))}` : 'Загрузка';
    case 'paused': return 'Пауза';
    case 'waiting-tab': return `Откройте страницу ${escapeHtml(SITE_NAMES[item.siteKey] || item.siteKey)}, чтобы продолжить ${renderSiteLinks(item.siteKey)}`;
    case 'waiting-decision': {
      const { kind, chapterTitle, message, imageUrl } = item.decision || {};
      const what = kind === 'image' ? 'Картинка' : 'Глава';
      return `${what} «${escapeHtml(chapterTitle)}»: ${escapeHtml(message)}${imageUrl ? `<div class="dl-decision-url">${escapeHtml(imageUrl)}</div>` : ''}`;
    }
    case 'done': {
      // Меньше глав, чем выбрано: часть пропущена (подробности - в логе и статистике)
      const text = current < total ? `Готово с пропусками: ${current} / ${total} ${unitsOf(item)}` : 'Готово';
      return item.filename ? `${text} · ${escapeHtml(item.filename)}` : text;
    }
    case 'error': return `Ошибка: ${escapeHtml(item.error)}<div class="dl-error-help">${escapeHtml(errorHelp(item.error))}</div>`;
    case 'canceled': return 'Отменено';
    default: return '';
  }
}

// Один элемент очереди: чистая разметка, весь текст экранируется
function renderQueueItem(item, stats) {
  const { current, total, part = 0 } = item.progress; // part - доля текущей главы по картинкам
  const percent = total ? Math.min(100, Math.round(((current + part) / total) * 100)) : 0;
  // Файл готового тайтла движок держит только у последнего (canSaveAgain): у остальных пересохранять нечего
  // Лог есть у тайтла, который начинал качаться (hasLog): отменённый в очереди его не имеет
  const commands = (STATUS_COMMANDS[item.status] || []).filter(command => (command !== 'saveAgain' || item.canSaveAgain) && (command !== 'log' || item.hasLog));
  const buttons = commands.map(command => renderCommandButton(command, item.id)).join('');
  return `<div class="dl-item dl-${escapeHtml(item.status)}">` +
    `<div class="dl-item-head"><span class="dl-item-title">${escapeHtml(item.title)}</span><span class="dl-format">${escapeHtml(String(item.format ?? '').toUpperCase())}</span></div>` +
    `<div class="dl-status">${renderStatus(item, stats)}</div>` +
    `<div class="dl-progress"><div class="progress-bar-container"><div class="progress-bar" style="width: ${percent}%"></div></div><span class="progress-counter">${current} / ${total} ${unitsOf(item)}</span></div>` +
    `<div class="dl-actions">${buttons}</div>` +
    '</div>';
}

// Третий элемент true - строку не показываем, пока значения нет. У видео (stats.video) пустые строки не показываются вовсе
const STATS_ROWS = [
  ['Время загрузки', stats => stats.elapsed],
  ['Примерное время', stats => stats.estimated],
  ['Скорость', stats => stats.speed, true],
  ['Скачано серии', stats => stats.episodeDownloaded, true],
  ['Скачано всего', stats => stats.totalDownloaded, true],
  ['Размер файла', stats => stats.fileSize],
  ['Ошибки', stats => stats.errors],
  ['Главы старого формата', stats => stats.oldFormatChapters, true], // у манги их не бывает - строку не показываем, пока их нет
  ['Пропущено глав', stats => stats.skippedChapters],
  ['Пропущено картинок', stats => stats.skippedImages],
  ['Загружено глав', stats => stats.totalChapters],
  ['Загружено обложек', stats => stats.totalCovers],
  ['Загружено картинок', stats => stats.totalImages],
  ['Запросов в минуту', stats => stats.requestsPerMinute === undefined ? undefined : `${stats.requestsPerMinute} (${stats.maxRequestsPerMinute})`]
];

function renderStats(stats) {
  if (!stats) return '';
  return STATS_ROWS
    .filter(([, value, hideEmpty]) => !(hideEmpty || stats.video) || value(stats))
    .map(([label, value]) => `<div class="analysis-item"><span class="analysis-label">${label}:</span>\n<span class="analysis-value">${escapeHtml(value(stats) ?? '-')}</span></div>`)
    .join('');
}

const SAFE_COLOR = /^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([\d\s,.%]+\))$/i;

function renderLog(logTail) {
  return logTail.map(({ line, isError, color }) => {
    const style = color && SAFE_COLOR.test(color) ? ` style="color: ${color}"` : '';
    return `<div class="log-entry${isError ? ' error' : ''}"${style}>${escapeHtml(line)}</div>`;
  }).join('');
}

// Текст для буфера обмена: версия и тайтл сверху - чтобы лог можно было сразу приложить к issue
function logText(item, lines) {
  const version = globalThis.chrome?.runtime?.getManifest?.().version;
  const head = [`LibSaver ${version || ''}`.trim(), item && `${item.title} (${String(item.format ?? '').toUpperCase()})`].filter(Boolean);
  return [...head, '', ...lines.map(entry => entry.line)].join('\n');
}

// navigator.clipboard в iframe работает, только если сайт не запретил clipboard-write; иначе - старый execCommand
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;opacity:0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function flashCopied(button, ok) {
  const icon = button.querySelector('i');
  button.classList.toggle('copied', ok);
  icon.className = ok ? 'fa-solid fa-check' : 'fa-solid fa-triangle-exclamation';
  setTimeout(() => {
    button.classList.remove('copied');
    icon.className = 'fa-solid fa-copy';
  }, 1500);
}

// --- Порт к движку ---

let enginePort = null;
let pingTimer = 0;
let autoScrollLog = true;
let finishedIds = []; // для «Очистить историю»: готовые, с ошибкой и отменённые из последнего состояния
let view = 'queue'; // вкладка: 'queue' - очередь и идущая загрузка, 'history' - завершённые
let lastState = null; // для перерисовки при смене вкладки; до первого состояния от движка рисовать нечего
let sourceUrl = ''; // сайт, над которым открыто окно
let titleLog = null; // { id, lines }: лог тайтла, открытый из «Истории»
const rendered = {}; // последняя разметка по id: state приходит часто, без изменений DOM не трогаем

function setHtml(id, html) {
  if (rendered[id] === html) return false;
  rendered[id] = html;
  document.getElementById(id).innerHTML = html;
  return true;
}

// Карточки очереди приходят до 4 раз в секунду: меняем только изменившиеся элементы. Кнопку, пересозданную между
// нажатием и отпусканием мыши, браузер не засчитывал за click - «Отменить» срабатывало не с первого раза
function patchChildren(parent, nodes) {
  while (parent.children.length > nodes.length) parent.lastElementChild.remove();
  nodes.forEach((node, i) => {
    const old = parent.children[i];
    if (!old) parent.append(node);
    else if (old.outerHTML === node.outerHTML) return;
    // Та же обёртка из одних элементов (карточка, строка кнопок) - сверяем её детей, иначе (текст, атрибуты) - заменяем
    else if (old.cloneNode(false).outerHTML === node.cloneNode(false).outerHTML && [...node.childNodes].every(child => child.nodeType === 1)) patchChildren(old, [...node.children]);
    else old.replaceWith(node);
  });
}

function setListHtml(html) {
  if (rendered['dl-list'] === html) return;
  rendered['dl-list'] = html;
  const list = document.getElementById('dl-list');
  if (!html || !list.firstElementChild) { // список был или стал пустым - нажимать нечего, просто заменяем
    list.innerHTML = html;
    return;
  }
  const fresh = document.createElement('template');
  fresh.innerHTML = html;
  patchChildren(list, [...fresh.content.children]);
}

function renderState(state) {
  lastState = state;
  const { items = [], stats = null, logTail = [] } = state;
  const byId = id => document.getElementById(id);
  const active = items.filter(item => ACTIVE_STATUSES.includes(item.status));
  const finished = items.filter(item => !ACTIVE_STATUSES.includes(item.status));
  const history = view === 'history';
  const shown = history ? finished : active;
  finishedIds = finished.map(item => item.id);
  byId('dl-count-queue').textContent = active.length || '';
  byId('dl-count-history').textContent = finished.length || '';
  byId('dl-empty').innerHTML = history
    ? '<b>История пуста</b><br>Здесь появятся готовые, отменённые и неудачные загрузки - с логом и кнопкой «Сохранить ещё раз».'
    : '<b>Очередь пуста</b><br>Откройте тайтл на сайте, отметьте главы и нажмите «Скачать» - загрузка появится здесь.';
  byId('dl-empty').hidden = shown.length > 0;
  byId('dl-clear-finished').hidden = !history || !finishedIds.length;
  setListHtml(shown.map(item => renderQueueItem(item, stats)).join(''));
  // «Ускорить» - про главы и картинки: над AnimeLIB прячем, пока в очереди нет глав
  byId('speed-mode').hidden = history || (/animelib\./.test(sourceUrl) && !active.some(item => item.siteKey !== 'animelib'));
  // Лог и статистика текущего или последнего тайтла - на вкладке очереди
  byId('dl-current').hidden = history || (!logTail.length && !stats);
  // Открытый лог тайтла живёт на вкладке «История», пока тайтл в ней есть
  if (titleLog && (!history || !finished.some(item => item.id === titleLog.id))) closeTitleLog();
  setHtml('dl-stats', renderStats(stats));
  if (setHtml('dl-log', renderLog(logTail)) && autoScrollLog) {
    const panel = byId('dl-log-panel');
    panel.scrollTop = panel.scrollHeight;
  }
}

function closeTitleLog() {
  titleLog = null;
  document.getElementById('dl-title-log').hidden = true;
  document.getElementById('dl-title-log-body').innerHTML = '';
}

// Ответ движка на { cmd: 'log' }: copy - сразу в буфер (кнопка у «Логов»), иначе - показать под списком истории
function handleTitleLog({ id, lines = [], copy }) {
  const byId = name => document.getElementById(name);
  const item = lastState?.items?.find(entry => entry.id === id);
  if (copy) {
    copyText(logText(item, lines)).then(ok => flashCopied(byId('dl-log-copy'), ok));
    return;
  }
  if (view !== 'history' || !item) return; // пока ответ шёл, вкладку сменили или тайтл убрали
  titleLog = { id, lines };
  byId('dl-title-log-name').textContent = `${item.title} · ${String(item.format ?? '').toUpperCase()}`;
  byId('dl-title-log-body').innerHTML = renderLog(lines) || '<div class="log-entry">Лог пуст</div>';
  byId('dl-title-log').hidden = false;
  byId('dl-title-log').scrollIntoView({ block: 'nearest' });
}

function sendCommand(command, id) {
  let message = { cmd: command };
  if (command === 'retry' || command === 'skip') message = { cmd: 'decision', choice: command };
  else if (command === 'cancel' || command === 'remove' || command === 'saveAgain' || command === 'log') message = { cmd: command, id };
  enginePort?.postMessage(message);
}

// Пинг идёт, пока есть порт и тайтлы в работе; без них таймер останавливается
function keepEngineAwake(items) {
  const active = !!enginePort && items.some(item => ACTIVE_STATUSES.includes(item.status));
  if (active && !pingTimer) pingTimer = setInterval(() => enginePort?.postMessage({ cmd: 'ping' }), PING_INTERVAL);
  else if (!active && pingTimer) {
    clearInterval(pingTimer);
    pingTimer = 0;
  }
}

const CONNECTION_TEXT = { connecting: 'Подключаюсь…', lost: 'Нет связи с движком, переподключаюсь…' };

// status: 'connecting' (ждём первое состояние), 'lost' (порт закрыт или движок недоступен), 'ok'; без связи кнопки команд не работают
function setConnection(status) {
  const byId = id => document.getElementById(id);
  const notice = byId('dl-connection');
  notice.hidden = status === 'ok';
  if (status !== 'ok') {
    notice.textContent = CONNECTION_TEXT[status];
    byId('dl-empty').hidden = true; // «Очередь пуста» говорить без связи нельзя
  }
  byId('dl-list').classList.toggle('dl-offline', status !== 'ok');
}

// Подключается, пока не получится: service worker или offscreen-документ могут быть в середине перезапуска
async function connectEngine() {
  for (let delay = RECONNECT_DELAY; ; delay = Math.min(delay * 2, MAX_RECONNECT_DELAY)) {
    try {
      await chrome.runtime.sendMessage({ action: 'ensureEngine' });
      const port = chrome.runtime.connect({ name: 'libsaver-engine' });
      enginePort = port;
      setConnection('connecting');
      port.onMessage.addListener(message => {
        if (message.type === 'titleLog') handleTitleLog(message);
        if (message.type !== 'state') return;
        setConnection('ok');
        renderState(message.state);
        keepEngineAwake(message.state?.items || []);
      });
      port.onDisconnect.addListener(() => {
        enginePort = null;
        keepEngineAwake([]);
        setConnection('lost');
        setTimeout(connectEngine, RECONNECT_DELAY);
      });
      return;
    } catch (error) {
      console.error('[LibSaver downloads]', error);
      setConnection('lost');
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function initDownloadsView() {
  const byId = id => document.getElementById(id);

  byId('dl-list').addEventListener('click', event => {
    const link = event.target.closest('a[data-url]');
    if (link) {
      if (chrome.tabs?.create) {
        event.preventDefault();
        chrome.tabs.create({ url: link.dataset.url });
      }
      return;
    }
    const button = event.target.closest('[data-cmd]');
    if (button && enginePort) sendCommand(button.dataset.cmd, button.dataset.id);
  });

  for (const [id, name] of [['dl-tab-queue', 'queue'], ['dl-tab-history', 'history']]) {
    byId(id).addEventListener('click', () => {
      view = name;
      for (const tab of ['dl-tab-queue', 'dl-tab-history']) {
        byId(tab).classList.toggle('on', tab === id);
        byId(tab).setAttribute('aria-selected', String(tab === id));
      }
      if (lastState) renderState(lastState);
    });
  }

  // Движок убирает по одному: те же команды remove, что и у кнопки на карточке
  byId('dl-clear-finished').addEventListener('click', () => {
    finishedIds.forEach(id => sendCommand('remove', id));
  });

  // Кнопка в заголовке <details>: без preventDefault клик ещё и сворачивал бы логи
  byId('dl-log-copy').addEventListener('click', event => {
    event.preventDefault();
    enginePort?.postMessage({ cmd: 'log', copy: true });
  });
  byId('dl-title-log-copy').addEventListener('click', () => {
    if (!titleLog) return;
    const item = lastState?.items?.find(entry => entry.id === titleLog.id);
    copyText(logText(item, titleLog.lines)).then(ok => flashCopied(byId('dl-title-log-copy'), ok));
  });
  byId('dl-title-log-close').addEventListener('click', closeTitleLog);

  const panel = byId('dl-log-panel');
  panel.addEventListener('scroll', () => {
    autoScrollLog = panel.scrollHeight - panel.scrollTop <= panel.clientHeight + 50;
  });

  setConnection('connecting');

  const speed = byId('speed-mode-checkbox');
  // «Ускорить» - флаг speedMode в storage, по умолчанию включён; его могут сменить и в другом окне
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.speedMode) speed.checked = changes.speedMode.newValue !== false;
    if (area === 'local' && changes.siteMirrors) siteMirrors = changes.siteMirrors.newValue || {};
    if (area === 'local' && changes.customSiteLinks) customSiteLinks = changes.customSiteLinks.newValue || {};
    if (area === 'local' && changes.useCustomSiteLinks) useCustomSiteLinks = changes.useCustomSiteLinks.newValue !== false;
    if (area === 'local' && changes.enableSiteMenu) enableSiteMenu = changes.enableSiteMenu.newValue !== false;
    if (area === 'local' && changes.enableMirrorSearch) enableMirrorSearch = changes.enableMirrorSearch.newValue !== false;
  });
  speed.addEventListener('change', () => {
    enginePort?.postMessage({ cmd: 'speedMode', on: speed.checked });
    chrome.storage.local.set({ speedMode: speed.checked });
  });
  const stored = await chrome.storage.local.get(['speedMode', 'sourceUrl', 'siteMirrors', 'customSiteLinks', 'useCustomSiteLinks', 'enableSiteMenu', 'enableMirrorSearch']);
  speed.checked = stored.speedMode !== false;
  siteMirrors = stored.siteMirrors || {};
  customSiteLinks = stored.customSiteLinks || {};
  useCustomSiteLinks = stored.useCustomSiteLinks !== false;
  enableSiteMenu = stored.enableSiteMenu !== false;
  enableMirrorSearch = stored.enableMirrorSearch !== false;
  sourceUrl = stored.sourceUrl || '';

  await connectEngine();
}

async function initDownloadsTheme() {
  setupThemeMessageListener();
  await loadAndApplyTheme();
  const { sourceUrl } = await chrome.storage.local.get('sourceUrl');
  if (sourceUrl) window.applySiteAccent(sourceUrl);
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    initDownloadsTheme().catch(error => console.error('[LibSaver downloads]', error));
    initDownloadsView().catch(error => console.error('[LibSaver downloads]', error));
  });
}
