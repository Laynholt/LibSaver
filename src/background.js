// Вызовы в странице сайта (выбор вкладки, PAGE_CALLS)
if (typeof importScripts === 'function') importScripts('core/page-calls.js', 'utils/page-call.js');

// Хранилище auth токенов с TTL
const authTokens = {};
const TOKEN_TTL = 3600000; // 1 час в миллисекундах

// Очистка истекших токенов
function cleanupExpiredTokens() {
  const now = Date.now();
  for (const key in authTokens) {
    if (authTokens[key].timestamp && (now - authTokens[key].timestamp > TOKEN_TTL)) {
      delete authTokens[key];
    }
  }
}

// Периодическая очистка токенов (каждые 30 минут)
setInterval(cleanupExpiredTokens, 1800000);

// Флаг для включения логирования (хранится в chrome.storage.session - переживает засыпание service worker)
let loggingInterval = null;

// Автоматическое восстановление логирования при пробуждении Service Worker
async function restoreLoggingIfNeeded() {
  const result = await chrome.storage.session.get(['isLoggingEnabled']);
  if (result.isLoggingEnabled && !loggingInterval) {
    console.log('[LibSaver] Storage logging restored after Service Worker wakeup');
    logStorageSize(); // Лог сразу
    loggingInterval = setInterval(logStorageSize, 10000);
  }
}

// Проверяем при запуске
restoreLoggingIfNeeded();

// Логирование размера storage каждые 10 секунд
async function logStorageSize() {
  // Окна расширения (popup, окно поверх сайта) показывает getContexts; без них идёт отсчёт до выключения
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB', 'POPUP'] });
  if (contexts.length === 0) {
    // Если нет открытых окон - проверяем время закрытия
    const sessionResult = await chrome.storage.session.get(['lastWindowCloseTime']);
    if (!sessionResult.lastWindowCloseTime) {
      // Первое закрытие окна - записываем время
      await chrome.storage.session.set({ lastWindowCloseTime: Date.now() });
      return;
    }

    // Проверяем прошло ли 2 минуты (120000 мс)
    const timeSinceClose = Date.now() - sessionResult.lastWindowCloseTime;
    if (timeSinceClose > 120000) {
      // Прошло больше 2 минут - выключаем логирование
      disableLogging();
      await chrome.storage.session.remove(['lastWindowCloseTime']);
    }
    return;
  }

  // Если есть открытое окно - сбрасываем таймер закрытия
  await chrome.storage.session.remove(['lastWindowCloseTime']);

  chrome.storage.local.getBytesInUse(null, (bytes) => {
    const mb = (bytes / (1024 * 1024)).toFixed(2);
    console.log(`[LibSaver] Storage size: ${mb} MB (${bytes} bytes)`);
  });
}

// Включение логирования
async function enableLogging() {
  const result = await chrome.storage.session.get(['isLoggingEnabled']);
  if (!result.isLoggingEnabled) {
    await chrome.storage.session.set({ isLoggingEnabled: true });
    await chrome.storage.session.remove(['lastWindowCloseTime']); // Сбрасываем таймер закрытия
    console.log('[LibSaver] Storage logging ENABLED');
    logStorageSize(); // Лог сразу
    loggingInterval = setInterval(logStorageSize, 10000);
  }
}

// Выключение логирования
async function disableLogging() {
  const result = await chrome.storage.session.get(['isLoggingEnabled']);
  if (result.isLoggingEnabled) {
    await chrome.storage.session.set({ isLoggingEnabled: false });
    console.log('[LibSaver] Storage logging DISABLED');
    if (loggingInterval) {
      clearInterval(loggingInterval);
      loggingInterval = null;
    }
  }
}

// Слушатель сообщений для управления логированием
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'enableStorageLogging') {
    enableLogging();
  } else if (message.action === 'disableStorageLogging') {
    disableLogging();
  }
});

// Общая функция для fetch с заголовками
async function fetchWithHeaders(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  const blob = await response.blob();
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
}

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

// Перехватываем auth токены из запросов к API
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.url.startsWith('https://api.cdnlibs.org/')) {
      const authHeader = details.requestHeaders?.find(h => h.name.toLowerCase() === 'authorization');
      if (authHeader?.value?.startsWith('Bearer ')) {
        const newToken = authHeader.value.substring(7);
        if (authTokens['ranobelib']?.token !== newToken) {
          authTokens['ranobelib'] = { token: newToken, timestamp: Date.now() };
        }
      }
    }
  },
  { urls: ['https://api.cdnlibs.org/*'] },
  ['requestHeaders']
);

// Инжектируем auth токены в запросы от расширения
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId === -1 && details.url.startsWith('https://api.cdnlibs.org/')) {
      if (authTokens['ranobelib']?.token) {
        const headers = details.requestHeaders || [];
        const authIdx = headers.findIndex(h => h.name.toLowerCase() === 'authorization');
        const authValue = `Bearer ${authTokens['ranobelib'].token}`;
        if (authIdx !== -1) {
          headers[authIdx].value = authValue;
        } else {
          headers.push({ name: 'Authorization', value: authValue });
        }
        return { requestHeaders: headers };
      }
    }
  },
  { urls: ['https://api.cdnlibs.org/*'] },
  ['requestHeaders']
);

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

chrome.runtime.onInstalled.addListener(async () => {
  // Включаем declarativeNetRequest rules для manga CDN
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: ['manga_headers']
  });

  // При установке или обновлении расширения перезагружаем вкладки LIB сайтов последовательно
  const patterns = [
    '*://*.ranobelib.me/*/book/*',
    '*://*.mangalib.me/*/manga/*',
    '*://*.hentailib.me/*/manga/*',
    '*://*.shlib.life/*/manga/*',
    '*://*.animelib.org/*/anime/*'
  ];
  
  for (const pattern of patterns) {
    const tabs = await chrome.tabs.query({ url: pattern });
    await reloadTabsSequentially(tabs);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  // При запуске браузера перезагружаем вкладки LIB сайтов последовательно
  const patterns = [
    '*://*.ranobelib.me/*/book/*',
    '*://*.mangalib.me/*/manga/*',
    '*://*.hentailib.me/*/manga/*',
    '*://*.shlib.life/*/manga/*',
    '*://*.animelib.org/*/anime/*'
  ];

  for (const pattern of patterns) {
    const tabs = await chrome.tabs.query({ url: pattern });
    await reloadTabsSequentially(tabs);
  }
});

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

// Фоновый движок загрузки (engine/engine.html). Одновременные вызовы делят одно создание документа
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
    chrome.downloads.download({ url: request.url, filename: request.filename, saveAs: false }).then(
      () => sendResponse({ ok: true }),
      error => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }
}
chrome.runtime.onMessage.addListener(handleEngineMessage);
