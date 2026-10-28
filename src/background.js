// Вызовы в странице сайта (выбор вкладки, PAGE_CALLS). В Firefox background.js - часть фоновой страницы
// engine/background-firefox.html: эти скрипты она грузит своими <script>, importScripts там нет
if (typeof importScripts === 'function') importScripts('core/page-calls.js', 'utils/page-call.js', 'utils/update-check.js', 'core/chapter-range.js');

// Обновления: раз в 6 часов фон запоминает последний релиз в lastUpdateCheck (его читают окошко и панель на сайте)
// и ставит «NEW» на иконку. GitHub API без ключа даёт 60 запросов в час - чаще не спрашиваем
const UPDATE_ALARM = 'libsaver-update-check';

async function checkUpdatesInBackground() {
  const { updateNotifications } = await chrome.storage.local.get('updateNotifications');
  if (updateNotifications === false) return;
  try {
    await chrome.storage.local.set({ lastUpdateCheck: { at: Date.now(), release: await fetchLatestRelease() } });
  } catch (e) {
    console.warn('[LibSaver] Проверка обновлений:', e.message); // нет сети или GitHub недоступен - следующая через 6 часов
  }
}

async function showUpdateBadge() {
  const release = await storedUpdate();
  await chrome.action.setBadgeText({ text: release ? 'NEW' : '' });
  await chrome.action.setTitle({ title: release ? `LibSaver - доступно обновление v${release.version}` : 'LibSaver - Скачивание тайтлов' });
  if (release) await chrome.action.setBadgeBackgroundColor({ color: '#3cce7b' });
}
const refreshUpdateBadge = () => showUpdateBadge().catch(e => console.warn('[LibSaver] Значок обновления:', e.message));

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === UPDATE_ALARM) checkUpdatesInBackground();
});
// Будильник переживает перезапуск service worker: создаём, только если его нет, иначе каждое пробуждение сдвигало бы срок
chrome.alarms.get(UPDATE_ALARM).then(alarm => {
  if (!alarm) chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 6 * 60 });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const notify = changes.updateNotifications;
  if (notify && notify.oldValue === false && notify.newValue !== false) checkUpdatesInBackground(); // включили - не ждём 6 часов
  if (changes.updateNotifications || changes.lastUpdateCheck) refreshUpdateBadge();
});

refreshUpdateBadge(); // значок не переживает перезапуск браузера, а после обновления расширения должен пропасть

// Зеркала: основной домен у пользователя бывает недоступен (блокировка, DNS), а сайт открывается с поддомена v1..v9.
// Проверяем с устройства пользователя и храним в siteMirrors { siteKey: origin } только сайты, чей основной домен не отвечает
const MIRROR_ALARM = 'libsaver-mirror-check';
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === MIRROR_ALARM) refreshMirrors().catch(e => console.warn('[LibSaver] Зеркала:', e.message));
});
chrome.alarms.get(MIRROR_ALARM).then(alarm => {
  if (!alarm) chrome.alarms.create(MIRROR_ALARM, { delayInMinutes: 1, periodInMinutes: 6 * 60 });
});

// Адрес отвечает (любой HTTP-ответ, и после переадресаций это тот же сайт) -> origin, где оказались; сеть, DNS, таймаут -> null
async function probeOrigin(url, siteKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { method: 'HEAD', cache: 'no-store', credentials: 'omit', signal: controller.signal });
    return siteKeyByHost(response.url) === siteKey ? new URL(response.url).origin : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// null - основной домен отвечает; origin зеркала; undefined - не отвечает ничего (нет сети), прежний выбор не трогаем
async function findMirror(siteKey) {
  const bases = siteLinks(siteKey);
  const firstAlive = async urls => (await Promise.all(urls.map(url => probeOrigin(url, siteKey)))).find(Boolean);
  if (await firstAlive(bases)) return null;
  return firstAlive(mirrorCandidates(siteKey).filter(url => !bases.includes(url)));
}

let mirrorCheck = null; // одна проверка за раз: будильник и ошибка вкладки могут совпасть
function refreshMirrors() {
  mirrorCheck ??= (async () => {
    const { siteMirrors = {} } = await chrome.storage.local.get('siteMirrors');
    const next = { ...siteMirrors };
    await Promise.all(Object.keys(SITE_TAB_PATTERNS).map(async siteKey => {
      const mirror = await findMirror(siteKey);
      if (mirror === null) delete next[siteKey];
      else if (mirror) next[siteKey] = mirror;
    }));
    await chrome.storage.local.set({ siteMirrors: next });
    return next;
  })().finally(() => { mirrorCheck = null; });
  return mirrorCheck;
}

// Страница LIB-сайта не открылась: если её домен не отвечает, а другой адрес сайта отвечает, переводим вкладку туда с тем же путём
const mirrorRedirects = new Map(); // tabId -> время перехода: вкладку не гоняем по кругу
async function redirectToMirror(details) {
  if (details.frameId !== 0 || /ABORTED|2152398850/.test(details.error)) return; // остановка загрузки, скачивание файла
  const siteKey = siteKeyByHost(details.url);
  if (!siteKey || Date.now() - (mirrorRedirects.get(details.tabId) || 0) < 60000) return;
  mirrorRedirects.set(details.tabId, Date.now());
  const failed = new URL(details.url);
  if (await probeOrigin(failed.origin, siteKey)) return; // домен отвечает: ошибка не из-за него
  const working = (await refreshMirrors())[siteKey] || siteLinks(siteKey)[0];
  if (new URL(working).host === failed.host || !(await probeOrigin(working, siteKey))) return;
  // Хост берём только у зеркала: путь вида //evil.example как относительный адрес увёл бы вкладку на чужой сайт
  const target = new URL(working);
  target.pathname = failed.pathname;
  target.search = failed.search;
  target.hash = failed.hash;
  if (target.host !== new URL(working).host || siteKeyByHost(target.href) !== siteKey) return;
  await chrome.tabs.update(details.tabId, { url: target.href });
}
chrome.webNavigation?.onErrorOccurred.addListener(details => {
  redirectToMirror(details).catch(e => console.warn('[LibSaver] Переход на зеркало:', e.message));
});


// Прямой fetch с заголовками (declarativeNetRequest добавит Referer, User-Agent, sec-ch-ua через rules.json)
async function directFetch(request, sendResponse) {
  const delays = [5000, 10000, 15000];
  const maxRetries = 5;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(request.url, {});
      
      if (response.ok) {
        const blob = await response.blob();
        const reader = new FileReader();
        const data = await new Promise((resolve, reject) => {
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('FileReader error'));
          reader.readAsDataURL(blob);
        });
        sendResponse({ success: true, data });
        return;
      }

      // Обработка 429 - Too Many Requests
      if (response.status === 429) {
        if (attempt < maxRetries) {
          const delay = delays[Math.min(attempt, delays.length - 1)];
          console.log(`Rate limited (429) for image, waiting ${delay/1000}s before retry ${attempt + 1}/${maxRetries + 1}`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        } else {
          throw new Error('Rate limited after 5 retry attempts (5s, 10s, 15s)');
        }
      }

      // Другие ошибки сервера
      if (response.status >= 500) {
        if (attempt < maxRetries) {
          const delay = delays[Math.min(attempt, delays.length - 1)];
          console.log(`Server error (${response.status}) for image, retrying in ${delay/1000}s (attempt ${attempt + 1}/${maxRetries + 1})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }

      // 404/403 и прочие 4xx повтор не исправит — не ждём зря (кроме 408 Request Timeout)
      if (response.status === 408 && attempt < maxRetries) {
        const delay = delays[Math.min(attempt, delays.length - 1)];
        console.log(`Request failed (${response.status}) for image, retrying in ${delay/1000}s (attempt ${attempt + 1}/${maxRetries + 1})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      throw Object.assign(new Error(`HTTP ${response.status}: ${response.statusText}`), { noRetry: true });
    } catch (error) {
      lastError = error;
      if (error.noRetry) break;
      if (attempt < maxRetries) {
        const delay = delays[Math.min(attempt, delays.length - 1)];
        console.log(`Network error (${error.message}) for image, retrying in ${delay/1000}s (attempt ${attempt + 1}/${maxRetries + 1})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  sendResponse({ success: false, error: lastError?.message || 'Max retries exceeded' });
}

// Функция для случайной задержки
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Функция для последовательной перезагрузки вкладок со случайной задержкой
async function reloadTabsSequentially(tabs) {
  for (const tab of tabs) {
    await chrome.tabs.reload(tab.id);
    // Случайная задержка от 500ms до 1800ms между перезагрузками
    const delay = randomDelay(500, 1800);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

// После установки, обновления и запуска браузера в уже открытых вкладках тайтлов нет content script - перезагружаем их
async function reloadTitleTabs() {
  const tabs = await chrome.tabs.query({ url: Object.values(SITE_TAB_PATTERNS).flat() });
  await reloadTabsSequentially(tabs.filter(tab => isTitlePage(tab.url)));
}

chrome.runtime.onInstalled.addListener(async () => {
  // Включаем declarativeNetRequest rules для manga CDN
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: ['manga_headers']
  });
  await reloadTitleTabs();
});

chrome.runtime.onStartup.addListener(reloadTitleTabs);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'fetchImage') {
    // Все image запросы идут через directFetch с declarativeNetRequest (rules.json)
    directFetch(request, sendResponse);
    return true;
  }
});

// Вызовы в странице сайта для контекстов без chrome.tabs/scripting (см. utils/page-call.js)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const run = request.action === 'pageCall:findTab' ? () => findSiteTab(request.siteKey, request.preferredTabId)
    : request.action === 'pageCall:exec' ? () => execPageCall(request.tabId, request.name, request.args)
    : request.action === 'pageCall:siteKey' ? () => siteKeyOfTab(request.tabId)
    : null;
  if (!run) return;
  run().then(
    result => sendResponse({ ok: true, result }),
    error => sendResponse({ ok: false, error: error.message, tabGone: !!error.tabGone })
  );
  return true;
});

// Иконка расширения на странице тайтла: popup просит открыть окно настроек поверх сайта, а оно живёт в content script (content/site-ui.js).
// true - вкладка приняла просьбу; false - не страница тайтла или скрипта в ней нет (popup тогда остаётся)
async function openPanelOnActiveTab(section) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.url || !siteKeyByHost(tab.url) || !isTitlePage(tab.url)) return false;
    await chrome.tabs.sendMessage(tab.id, { action: 'libsaver:openPanel', section });
    return true;
  } catch (e) {
    return false;
  }
}

function handleOpenPanel(request, sender, sendResponse) {
  if (request.action !== 'openPanel') return;
  if (sender.tab) { // просит только popup; страница сайта окно по своей воле не открывает
    sendResponse(false);
    return;
  }
  openPanelOnActiveTab(typeof request.section === 'string' ? request.section : undefined).then(sendResponse);
  return true;
}
chrome.runtime.onMessage.addListener(handleOpenPanel);

// Фоновый движок загрузки (engine/engine.html). Одновременные вызовы делят одно создание документа.
// В Firefox chrome.offscreen нет: движок уже работает в этой же фоновой странице, ответ сразу true
let engineReady = null;
function ensureEngine() {
  engineReady ??= (async () => {
    if (chrome.offscreen && !(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({ url: 'engine/engine.html', reasons: ['DOM_PARSER', 'BLOBS'], justification: 'Фоновая сборка файлов LibSaver' });
    }
    return true;
  })().finally(() => { engineReady = null; });
  return engineReady;
}

// Главы, вошедшие в файл целиком (chapterKey), дописываются к учёту тайтла: по нему раздел «Главы» предлагает «Выбрать новые».
// Записи идут по очереди: части одного тайтла сохраняются одна за другой и не должны затереть друг друга
let downloadedWrites = Promise.resolve();
function recordDownloaded(slug, chapters) {
  const key = downloadedStoreKey(slug);
  downloadedWrites = downloadedWrites.catch(() => {}).then(async () => {
    const { [key]: previous } = await chrome.storage.local.get(key);
    await chrome.storage.local.set({ [key]: mergeDownloaded(previous, chapters) });
  });
  return downloadedWrites;
}

// Движку: поднять offscreen-документ; сохранить собранный им файл (в offscreen нет chrome.downloads)
function handleEngineMessage(request, sender, sendResponse) {
  if (request.action === 'ensureEngine') {
    ensureEngine().then(sendResponse, error => { console.error('[LibSaver] ensureEngine', error); sendResponse(false); });
    return true;
  }
  if (request.action === 'whoami') {
    // Скрипту на странице сайта: в какой он вкладке (нужно окну расширения поверх сайта)
    sendResponse({ tabId: sender.tab?.id, url: sender.tab?.url });
    return;
  }
  if (request.action === 'markDownloaded') {
    // Как saveFile: учёт скачанных глав пишет только движок, не страница сайта
    if (sender.tab || typeof request.slug !== 'string' || !Array.isArray(request.chapters)) {
      sendResponse(false);
      return;
    }
    recordDownloaded(request.slug, request.chapters).then(() => sendResponse(true), error => {
      console.error('[LibSaver] markDownloaded', error);
      sendResponse(false);
    });
    return true;
  }
  if (request.action === 'saveFile') {
    // Движок живёт в offscreen без вкладки; скрипт страницы сайта не должен тихо качать произвольный URL
    if (sender.tab) {
      sendResponse({ ok: false, error: 'saveFile доступен только фоновому движку' });
      return;
    }
    downloadNames.set(request.url, request.filename);
    chrome.downloads.download({ url: request.url, filename: request.filename, saveAs: false }).then(
      () => sendResponse({ ok: true }),
      error => {
        downloadNames.delete(request.url);
        sendResponse({ ok: false, error: error.message });
      }
    );
    return true;
  }
}
chrome.runtime.onMessage.addListener(handleEngineMessage);

// Chrome теряет filename у blob-ссылки из offscreen-документа: файл получает имя-GUID и расширение по MIME (.zip вместо .epub).
// Имя, переданное в download, ставим ещё раз, когда Chrome выбирает имя файла. Чужие загрузки не трогаем
const downloadNames = new Map(); // url -> filename
function suggestDownloadName(item, suggest) {
  const filename = downloadNames.get(item.url);
  if (!filename) return;
  downloadNames.delete(item.url);
  suggest({ filename, conflictAction: 'uniquify' });
}
chrome.downloads.onDeterminingFilename?.addListener(suggestDownloadName); // в Firefox события нет, имя там не теряется
