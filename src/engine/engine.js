// engine.js - фоновый движок загрузки (offscreen-документ в Chrome): очередь, события download.js, порт 'libsaver-engine'.
// В Firefox движок - сама фоновая страница (engine/background-firefox.html): chrome.downloads, chrome.tabs и chrome.scripting там есть,
// поэтому saveFile и page-call.js идут в них напрямую, без runtime.sendMessage (своё сообщение страница не получает)

const LOG_TAIL_SIZE = 500;
const TITLE_LOG_SIZE = 10000; // строк лога одного тайтла для «Логи» в истории и «Скопировать»
const STATE_INTERVAL = 250; // state уходит в порты не чаще раза в 250 мс
const TAB_POLL_INTERVAL = 2000;

const ports = new Set();
// Файл последнего готового тайтла для «Сохранить ещё раз»: { id, url, filename }. Blob держим только один -
// с готовностью следующего тайтла прежний отпускается, и у его элемента нет canSaveAgain
let lastFile = null;
let stats = null;
let logTail = [];
// Лог каждого тайтла целиком (до TITLE_LOG_SIZE строк): id -> строки. Уходит вместе с тайтлом из очереди.
// logOwner - чей лог сейчас в logTail (идущий или последний тайтл)
const titleLogs = new Map();
let logOwner = null;
let current = null; // { id, canceled, stopWait }: идущая загрузка

const canceledError = () => Object.assign(new Error('Загрузка отменена'), { canceled: true });

function post(port, message) {
  try {
    port.postMessage(message);
  } catch (e) {
    ports.delete(port); // порт уже закрыт
  }
}

const currentState = () => ({
  items: queue.items().map(item => ({ ...item, canSaveAgain: item.id === lastFile?.id || undefined, hasLog: titleLogs.get(item.id)?.length > 0 || undefined })),
  stats,
  logTail
});

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

// Chrome и Edge ставят расширение по типу файла, а не по имени: EPUB и CBZ (внутри zip) с типом application/zip сохранялись как .zip
const FILE_TYPES = { epub: 'application/epub+zip', cbz: 'application/vnd.comicbook+zip', fb2: 'application/x-fictionbook+xml' };
function typedBlob(blob, filename) {
  const type = FILE_TYPES[String(filename).split('.').pop().toLowerCase()];
  return type && blob.type !== type ? new Blob([blob], { type }) : blob;
}

// folder - папка внутри загрузок (серии аниме). Имя папки чистится как имя файла; «.dir» - чтобы её точка не сошла за расширение
async function saveFile(url, name, folder) {
  const filename = (folder ? safeDownloadFilename(`${folder}.dir`).slice(0, -4) + '/' : '') + safeDownloadFilename(name);
  if (chrome.downloads) {
    await chrome.downloads.download({ url, filename, saveAs: false });
    return;
  }
  const response = await chrome.runtime.sendMessage({ action: 'saveFile', url, filename });
  if (!response?.ok) throw new Error(response?.error || 'Не удалось сохранить файл');
}

// Главы снимка по порядку тайтла, без повторов по переводам: по ним загрузка режется на части
function snapshotChapters(snapshot) {
  const ids = snapshot.downloadData?.selectedChapterIds;
  const chosen = Array.isArray(ids) ? new Set(ids) : null;
  const byId = new Map();
  for (const chapter of snapshot.downloadData?.chapters || []) {
    if ((!chosen || chosen.has(chapter.id)) && !byId.has(chapter.id)) byId.set(chapter.id, chapter);
  }
  return [...byId.values()];
}

// Части по size глав; size 0 или глав не больше size - одна часть (null: снимок как есть)
function splitParts(chapters, size) {
  if (!(size > 0) || chapters.length <= size) return [null];
  const parts = [];
  for (let start = 0; start < chapters.length; start += size) parts.push(chapters.slice(start, start + size));
  return parts;
}

// «Тайтл.epub» -> «Тайтл - 02 (101-200).epub»: номер части с нулями впереди, чтобы читалки и проводник сортировали по порядку
function partFilename(filename, index, count, chapters) {
  const [, base, extension = ''] = String(filename).match(/^([\s\S]*?)(\.[a-z0-9]{1,5})?$/i);
  const first = chapters[0]?.number;
  const last = chapters[chapters.length - 1]?.number;
  const span = first === last ? `${first}` : `${first}-${last}`;
  return `${base} - ${String(index + 1).padStart(String(count).length, '0')} (${span})${extension}`;
}

// Учёт скачанных глав пишет фон (у offscreen-документа нет chrome.storage); в Firefox фон - эта же страница, своё сообщение она не получит
async function markDownloaded(slug, chapters) {
  if (!slug || !chapters?.length) return;
  try {
    if (typeof recordDownloaded === 'function') await recordDownloaded(slug, chapters);
    else await chrome.runtime.sendMessage({ action: 'markDownloaded', slug, chapters });
  } catch (e) {
    console.error('[LibSaver engine] Учёт скачанных глав', e); // файл уже сохранён: без учёта «Выбрать новые» просто предложит эти главы снова
  }
}

async function runTitle(item, snapshot) {
  current = { id: item.id, canceled: false, stopWait: null, progressBase: 0, progressTotal: 0 };
  stats = null;
  logTail = [];
  logOwner = item.id;
  titleLogs.set(item.id, []);
  try {
    if (snapshot.siteType === 'anime') {
      downloadControl.resume(); // пауза общая с download.js (её ждёт fetchVideo): прошлая загрузка могла кончиться на паузе
      return await downloadAnime(snapshot, {
        log: (line, isError) => onDownloadEvent({ type: 'log', line, isError }),
        progress: (done, total, part) => onDownloadEvent({ type: 'progress', current: done, total, part }),
        stats: rows => onDownloadEvent({ type: 'stats', stats: rows }),
        isCanceled: () => current.canceled,
        save: saveFile
      });
    }
    const chapters = snapshotChapters(snapshot);
    const parts = splitParts(chapters, Number(snapshot.stored?.splitChapters) || 0);
    const names = [];
    releaseFile();
    current.progressTotal = parts.length > 1 ? chapters.length : 0;
    for (const [index, partChapters] of parts.entries()) {
      let partSnapshot = snapshot;
      if (partChapters) {
        partSnapshot = structuredClone(snapshot); // startDownload меняет главы снимка
        partSnapshot.downloadData.selectedChapterIds = partChapters.map(chapter => chapter.id);
        current.progressBase = index ? chapters.indexOf(partChapters[0]) : 0;
        onDownloadEvent({ type: 'log', line: `Часть ${index + 1} из ${parts.length}` });
      }
      const { blob, filename, completeChapters } = await startDownload(partSnapshot);
      if (current.canceled) throw canceledError();
      const name = partChapters ? partFilename(filename, index, parts.length, partChapters) : filename;
      const url = URL.createObjectURL(typedBlob(blob, name));
      // Прошлая часть сохранена, пока собиралась эта. shortcut: если части собираются за секунды, Chrome может не успеть прочитать отпущенный blob - тогда держать все ссылки до конца тайтла
      if (lastFile) URL.revokeObjectURL(lastFile.url);
      // «Сохранить ещё раз» - только у загрузки одним файлом: у частей сохранилась бы одна последняя
      lastFile = { id: parts.length > 1 ? null : item.id, url, filename: name };
      await saveFile(url, name);
      names.push(name);
      await markDownloaded(snapshot.slug, completeChapters);
    }
    return { filename: names.length > 1 ? `частей: ${names.length} · ${names[0]} …` : names[0] };
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
    const full = titleLogs.get(current.id);
    full?.push(line);
    if (full?.length > TITLE_LOG_SIZE) full.splice(0, full.length - TITLE_LOG_SIZE);
    for (const port of ports) post(port, { type: 'log', id: current.id, ...line });
    scheduleState();
  } else if (event.type === 'progress') {
    // Загрузка частями: счёт глав - по всему тайтлу, а не по текущей части
    const total = current.progressTotal || event.total;
    updateCurrent(null, { progress: { current: (current.progressBase || 0) + event.current, total, part: event.part || 0 } });
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

function releaseFile() {
  if (lastFile) URL.revokeObjectURL(lastFile.url);
  lastFile = null;
}

function remove(id) {
  if (!queue.remove(id)) return;
  titleLogs.delete(id);
  if (lastFile?.id === id) releaseFile();
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
    case 'saveAgain': // только для элемента с canSaveAgain: blob остальных уже отпущен
      if (lastFile?.id === message.id) saveFile(lastFile.url, lastFile.filename).catch(e => console.error('[LibSaver engine]', e));
      break;
    case 'log': { // весь лог тайтла; без id - того, что в logTail. copy возвращается как есть: окно знает, копировать или показать
      const id = message.id ?? logOwner;
      post(port, { type: 'titleLog', id, lines: titleLogs.get(id) || [], copy: !!message.copy });
      break;
    }
    case 'ping': break; // клиент будит фоновую страницу Firefox во время загрузки: важен сам факт сообщения, состояние не рассылаем
  }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'libsaver-engine') return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(message => handleCommand(port, message));
  post(port, { type: 'state', state: currentState() });
});
