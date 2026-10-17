// engine.js - фоновый движок загрузки (offscreen-документ в Chrome): очередь, события download.js, порт 'libsaver-engine'

const LOG_TAIL_SIZE = 500;
const STATE_INTERVAL = 250; // state уходит в порты не чаще раза в 250 мс
const TAB_POLL_INTERVAL = 2000;

const ports = new Set();
const files = new Map(); // id -> { url, filename }: последний файл тайтла для «Сохранить ещё раз»
let stats = null;
let logTail = [];
let current = null; // { id, canceled, stopWait }: идущая загрузка

const canceledError = () => Object.assign(new Error('Загрузка отменена'), { canceled: true });

function post(port, message) {
  try {
    port.postMessage(message);
  } catch (e) {
    ports.delete(port); // порт уже закрыт
  }
}

const currentState = () => ({ items: queue.items(), stats, logTail });

let stateTimer = null;
let lastStateAt = 0;
function scheduleState() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    lastStateAt = Date.now();
    const message = { type: 'state', state: currentState() };
    for (const port of ports) post(port, message);
  }, Math.max(0, STATE_INTERVAL - (Date.now() - lastStateAt)));
}

const queue = createQueue({ run: runTitle, onChange: scheduleState });

// Поменять статус идущего тайтла, не трогая остальные поля
function updateCurrent(status, extra) {
  const item = queue.items().find(entry => entry.id === current.id);
  queue.setStatus(current.id, status || item.status, extra);
}

// chrome.downloads отвергает имена, которые принимал FileSaver: зарезервированные и управляющие символы, точки и пробелы в конце имени
function safeDownloadFilename(name) {
  const [, base, extension = ''] = String(name).match(/^([\s\S]*?)(\.[a-z0-9]{1,5})?$/i);
  const safe = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  return (safe || 'LibSaver') + extension;
}

async function saveFile(url, name) {
  const filename = safeDownloadFilename(name);
  if (chrome.downloads) {
    await chrome.downloads.download({ url, filename, saveAs: false });
    return;
  }
  const response = await chrome.runtime.sendMessage({ action: 'saveFile', url, filename });
  if (!response?.ok) throw new Error(response?.error || 'Не удалось сохранить файл');
}

async function runTitle(item, snapshot) {
  current = { id: item.id, canceled: false, stopWait: null };
  stats = null;
  logTail = [];
  try {
    const { blob, filename } = await startDownload(snapshot);
    if (current.canceled) throw canceledError();
    const url = URL.createObjectURL(blob);
    files.set(item.id, { url, filename });
    await saveFile(url, filename);
    return { filename };
  } finally {
    current = null;
  }
}

function onDownloadEvent(event) {
  if (!current || current.canceled) return; // отменённая загрузка ещё может что-то сообщить - не показываем
  if (event.type === 'log') {
    const line = { line: event.line, isError: event.isError, color: event.color };
    logTail.push(line);
    if (logTail.length > LOG_TAIL_SIZE) logTail.splice(0, logTail.length - LOG_TAIL_SIZE);
    for (const port of ports) post(port, { type: 'log', id: current.id, ...line });
    scheduleState();
  } else if (event.type === 'progress') {
    updateCurrent(null, { progress: { current: event.current, total: event.total } });
  } else if (event.type === 'stats') {
    stats = event.stats;
    scheduleState();
  } else if (event.type === 'decision') {
    updateCurrent('waiting-decision', { decision: event.decision });
  } else if (event.type === 'decisionDone') {
    updateCurrent('running', { decision: undefined });
  } else if (event.type === 'paused') {
    updateCurrent(event.paused ? 'paused' : 'running');
  }
}

// download.js зовёт листенер без try/catch: ошибка здесь не должна ронять загрузку
setDownloadListener(event => {
  try {
    onDownloadEvent(event);
  } catch (e) {
    console.error('[LibSaver engine]', e);
  }
});

// Нет вкладки сайта: тайтл ждёт в 'waiting-tab', пока она не появится (или пока его не отменят)
setNoTabHandler(async siteKey => {
  const run = current;
  if (!run || run.canceled) throw canceledError();
  updateCurrent('waiting-tab');
  try {
    for (;;) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, TAB_POLL_INTERVAL);
        run.stopWait = () => { clearTimeout(timer); reject(canceledError()); };
      });
      const tabId = await findSiteTab(siteKey);
      if (run.canceled) throw canceledError(); // отмена пришла, пока шёл поиск вкладки
      if (tabId != null) break;
    }
  } finally {
    run.stopWait = null;
  }
  if (run.canceled) throw canceledError();
  updateCurrent('running');
});

function cancel(id) {
  if (current && current.id === id) {
    current.canceled = true;
    current.stopWait?.();
    downloadControl.cancel();
  }
  queue.cancel(id);
}

function remove(id) {
  if (!queue.remove(id)) return;
  const file = files.get(id);
  if (file) URL.revokeObjectURL(file.url);
  files.delete(id);
}

function handleCommand(port, message) {
  switch (message?.cmd) {
    case 'enqueue': post(port, { type: 'enqueueResult', ...queue.enqueue(message.snapshot) }); break;
    case 'pause': if (current) downloadControl.pause(); break;
    case 'resume': if (current) downloadControl.resume(); break;
    case 'cancel': cancel(message.id); break;
    case 'remove': remove(message.id); break;
    case 'decision': if (message.choice === 'retry' || message.choice === 'skip') downloadControl[message.choice](); break;
    case 'speedMode': downloadControl.setSpeedMode(!!message.on); break;
    case 'saveAgain': {
      const file = files.get(message.id);
      if (file) saveFile(file.url, file.filename).catch(e => console.error('[LibSaver engine]', e));
      break;
    }
  }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'libsaver-engine') return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(message => handleCommand(port, message));
  post(port, { type: 'state', state: currentState() });
});
