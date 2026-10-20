// Вызовы в странице сайта (выбор вкладки, PAGE_CALLS). В Firefox background.js - часть фоновой страницы
// engine/background-firefox.html: эти скрипты она грузит своими <script>, importScripts там нет
if (typeof importScripts === 'function') importScripts('core/page-calls.js', 'utils/page-call.js');

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
