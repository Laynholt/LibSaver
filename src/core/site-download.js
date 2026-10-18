// site-download.js - общее для окон расширения поверх сайта (быстрое окошко «Скачать» и окно настроек): подпись кнопки,
// тексты ошибок, загрузка тайтла и постановка выбранных глав в очередь.
// Зависит от title-loader.js, snapshot.js, engine-client.js (и page-call.js).

const QUICK_ALREADY_QUEUED = 'Этот тайтл уже в очереди';

// «Скачать 1 главу / 2 главы / 5 глав»
function downloadLabel(count) {
  const lastTwo = count % 100;
  const last = count % 10;
  const word = lastTwo >= 11 && lastTwo <= 14 ? 'глав' : last === 1 ? 'главу' : last >= 2 && last <= 4 ? 'главы' : 'глав';
  return `Скачать ${count} ${word}`;
}

// Значения по умолчанию - как в настройках (сервер картинок - сжатые, «только текст» выключен)
function quickSettings(stored) {
  return {
    imageServer: ['normal', 'compressed'].includes(stored.imageServer) ? stored.imageServer : 'compressed',
    textOnly: stored.textOnly === true
  };
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
async function loadQuickTitle({ tabId, url, force = false, onProgress }) {
  await chrome.storage.local.set({ siteType: siteTypeOf(siteKeyOf(url)), sourceUrl: url });
  return loadTitleData({ tabId, url, force, onProgress });
}

// Снимок выбранных глав -> очередь движка. { ok: true } | { ok: false, message }; прочие отказы - исключение
async function enqueueSelection({ slug, tabId, url, selectedChapterIds, format }) {
  const settings = quickSettings(await chrome.storage.local.get(['imageServer', 'textOnly']));
  // «Ускорить» снимок читает из storage сам
  const snapshot = await buildDownloadSnapshot({ slug, tabId, sourceUrl: url, selectedChapterIds, format, ...settings });
  const result = await enqueueSnapshot(snapshot);
  if (result.ok) return { ok: true };
  if (result.reason === 'already-queued') return { ok: false, message: QUICK_ALREADY_QUEUED };
  throw new Error('Очередь не приняла тайтл');
}
