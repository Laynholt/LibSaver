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
  remove: ['fa-trash', 'Убрать из очереди']
};

const STATUS_COMMANDS = {
  queued: ['cancel', 'remove'],
  running: ['pause', 'cancel'],
  paused: ['resume', 'cancel'],
  'waiting-tab': ['cancel'],
  'waiting-decision': ['retry', 'skip', 'cancel'],
  done: ['saveAgain', 'remove'],
  error: ['remove'],
  canceled: ['remove']
};

function renderCommandButton(command, id) {
  const [icon, label] = COMMAND_BUTTONS[command];
  return `<button class="dl-btn" data-cmd="${command}" data-id="${escapeHtml(id)}" title="${label}" aria-label="${label}"><i class="fa-solid ${icon}"></i><span>${label}</span></button>`;
}

function renderSiteLinks(siteKey) {
  return siteLinks(siteKey)
    .map(url => `<a href="${escapeHtml(url)}" data-url="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url.replace('https://', ''))}</a>`)
    .join(' · ');
}

function renderStatus(item) {
  const { current, total } = item.progress;
  switch (item.status) {
    case 'queued': return 'В очереди';
    case 'running': return 'Загрузка';
    case 'paused': return 'Пауза';
    case 'waiting-tab': return `Откройте страницу ${escapeHtml(SITE_NAMES[item.siteKey] || item.siteKey)}, чтобы продолжить ${renderSiteLinks(item.siteKey)}`;
    case 'waiting-decision': {
      const { kind, chapterTitle, message, imageUrl } = item.decision || {};
      const what = kind === 'image' ? 'Картинка' : 'Глава';
      return `${what} «${escapeHtml(chapterTitle)}»: ${escapeHtml(message)}${imageUrl ? `<div class="dl-decision-url">${escapeHtml(imageUrl)}</div>` : ''}`;
    }
    case 'done': {
      // Меньше глав, чем выбрано: часть пропущена (подробности - в логе и статистике)
      const text = current < total ? `Готово с пропусками: ${current} / ${total} глав` : 'Готово';
      return item.filename ? `${text} · ${escapeHtml(item.filename)}` : text;
    }
    case 'error': return `Ошибка: ${escapeHtml(item.error)}`;
    case 'canceled': return 'Отменено';
    default: return '';
  }
}

// Один элемент очереди: чистая разметка, весь текст экранируется
function renderQueueItem(item) {
  const { current, total, part = 0 } = item.progress; // part - доля текущей главы по картинкам
  const percent = total ? Math.min(100, Math.round(((current + part) / total) * 100)) : 0;
  // Файл готового тайтла движок держит только у последнего (canSaveAgain): у остальных пересохранять нечего
  const commands = (STATUS_COMMANDS[item.status] || []).filter(command => command !== 'saveAgain' || item.canSaveAgain);
  const buttons = commands.map(command => renderCommandButton(command, item.id)).join('');
  return `<div class="dl-item dl-${escapeHtml(item.status)}">` +
    `<div class="dl-item-head"><span class="dl-item-title">${escapeHtml(item.title)}</span><span class="dl-format">${escapeHtml(String(item.format ?? '').toUpperCase())}</span></div>` +
    `<div class="dl-status">${renderStatus(item)}</div>` +
    `<div class="dl-progress"><div class="progress-bar-container"><div class="progress-bar" style="width: ${percent}%"></div></div><span class="progress-counter">${current} / ${total} глав</span></div>` +
    `<div class="dl-actions">${buttons}</div>` +
    '</div>';
}

const STATS_ROWS = [
  ['Время загрузки', stats => stats.elapsed],
  ['Примерное время', stats => stats.estimated],
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
    .filter(([, value, hideEmpty]) => !hideEmpty || value(stats))
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

// --- Порт к движку ---

let enginePort = null;
let pingTimer = 0;
let autoScrollLog = true;
let finishedIds = []; // для «Очистить завершённые»: готовые, с ошибкой и отменённые из последнего состояния
const rendered = {}; // последняя разметка по id: state приходит часто, без изменений DOM не трогаем

function setHtml(id, html) {
  if (rendered[id] === html) return false;
  rendered[id] = html;
  document.getElementById(id).innerHTML = html;
  return true;
}

function renderState({ items = [], stats = null, logTail = [] }) {
  const byId = id => document.getElementById(id);
  byId('dl-empty').hidden = items.length > 0;
  finishedIds = items.filter(item => !ACTIVE_STATUSES.includes(item.status)).map(item => item.id);
  byId('dl-clear-finished').hidden = !finishedIds.length;
  setHtml('dl-list', items.map(renderQueueItem).join(''));
  byId('dl-current').hidden = !logTail.length && !stats;
  setHtml('dl-stats', renderStats(stats));
  if (setHtml('dl-log', renderLog(logTail)) && autoScrollLog) {
    const panel = byId('dl-log-panel');
    panel.scrollTop = panel.scrollHeight;
  }
}

function sendCommand(command, id) {
  let message = { cmd: command };
  if (command === 'retry' || command === 'skip') message = { cmd: 'decision', choice: command };
  else if (command === 'cancel' || command === 'remove' || command === 'saveAgain') message = { cmd: command, id };
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

  // Движок убирает по одному: те же команды remove, что и у кнопки на карточке
  byId('dl-clear-finished').addEventListener('click', () => {
    finishedIds.forEach(id => sendCommand('remove', id));
  });

  const panel = byId('dl-log-panel');
  panel.addEventListener('scroll', () => {
    autoScrollLog = panel.scrollHeight - panel.scrollTop <= panel.clientHeight + 50;
  });

  setConnection('connecting');

  const speed = byId('speed-mode-checkbox');
  // «Ускорить» - флаг speedMode в storage, по умолчанию включён; его могут сменить и в другом окне
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.speedMode) speed.checked = changes.speedMode.newValue !== false;
  });
  speed.addEventListener('change', () => {
    enginePort?.postMessage({ cmd: 'speedMode', on: speed.checked });
    chrome.storage.local.set({ speedMode: speed.checked });
  });
  speed.checked = (await chrome.storage.local.get('speedMode')).speedMode !== false;

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
