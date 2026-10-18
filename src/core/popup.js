// Обработчик сообщений для toast от других окон
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'showToast') {
    showToast(request.message, request.type);
  }
});

// Сравнение версий (semver)
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  const maxLength = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLength; i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;

    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }

  return 0;
}

// Проверка обновлений в popup
async function checkForUpdatesPopup() {
  try {
    // Проверяем настройку уведомлений
    const result = await chrome.storage.local.get(['updateNotifications']);
    if (result.updateNotifications === false) {
      return;
    }

    const manifest = chrome.runtime.getManifest();
    const currentVersion = manifest.version;

    // Таймаут 30 секунд для fetch
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const response = await fetch('https://cdn.jsdelivr.net/gh/dfy-dpg/LibSaver@latest/src/manifest.json', {
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) return;

    const manifestJson = await response.json();
    if (!manifestJson || !manifestJson.version) return;

    const latestVersion = manifestJson.version;

    // Семантическое сравнение версий
    if (compareVersions(latestVersion, currentVersion) > 0) {
      console.log(`Доступно обновление: v${currentVersion} → v${latestVersion}`);
      showToast('Доступно обновление!', 'update', 8000, () => {
        chrome.tabs.create({ url: 'https://github.com/dfy-dpg/LibSaver/releases/latest' });
      });
    }
  } catch (error) {
    console.error('Ошибка проверки обновлений:', error);
  }
}

// Слушатель сообщений для обновления темы
setupThemeMessageListener();

// Функция загрузки SVG как inline
async function loadInlineSvg() {
  const logoContainers = document.querySelectorAll('.lib-logo[data-svg]');

  for (const container of logoContainers) {
    const svgPath = container.getAttribute('data-svg');
    if (!svgPath) continue;

    try {
      const response = await fetch(chrome.runtime.getURL(svgPath));
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const svgText = await response.text();
      container.innerHTML = svgText;
    } catch (error) {
      // SVG не загрузился - просто не отображаем логотип
    }
  }
}


// Запуск при открытии всплывающего окна
document.addEventListener('DOMContentLoaded', async () => {
  // Загружаем и применяем тему
  await loadAndApplyTheme();

  // Загружаем SVG логотипы как inline
  await loadInlineSvg();

  // Проверка обновлений при открытии popup (с задержкой 2 секунды)
  setTimeout(checkForUpdatesPopup, 2000);

  await loadTitle();
});

// На странице тайтла настройки открываются окном поверх сайта (фон передаёт просьбу вкладке). true - окно открыто, popup можно закрыть
async function openPanelFromPopup(url) {
  if (!siteKeyByHost(url) || !isTitlePage(url)) return false;
  try {
    return (await chrome.runtime.sendMessage({ action: 'openPanel' })) === true;
  } catch (e) {
    return false; // в странице нет нашего скрипта: остаётся прежний экран popup
  }
}

// На странице тайтла открываем окно поверх сайта и закрываем popup; на остальных страницах показываем, куда перейти
async function loadTitle() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab || !activeTab.url) {
    showMessage('Не удалось определить активную вкладку.', true, 'no_title');
    return;
  }

  const url = activeTab.url;

  if (await openPanelFromPopup(url)) {
    window.close();
    return;
  }

  // Применяем акцентный цвет по сайту
  window.applySiteAccent(url);

  if (!siteKeyByHost(url)) {
    showMessage('Перейдите на один из поддерживаемых сайтов.', false, 'not_on_site');
  } else if (!isTitlePage(url)) {
    showMessage('Перейдите на главную страницу нужного тайтла.', false, 'no_title');
  } else {
    // Страница тайтла открыта до установки или обновления расширения: скрипта сайта в ней ещё нет
    showMessage('Не удалось открыть окно LibSaver. Перезагрузите страницу.', true, 'chapters_error');
  }
}

// Функция обновления текста лоадера и прогресс-бара
function updateLoader(text, progress) {
  const loaderText = document.getElementById('loader-text');
  const loaderProgress = document.getElementById('loader-progress');
  if (loaderText) loaderText.textContent = text;
  if (loaderProgress) {
    // Плавная анимация прогресс бара
    loaderProgress.style.transition = 'width 0.3s ease';
    loaderProgress.style.width = progress + '%';
  }
}

// Показ сообщения (isError = true включает красный цвет, errorType определяет кнопку)
// errorType: 'not_on_site' - кнопки LIB сайтов
// errorType: 'no_title' - кнопки LIB сайтов
// errorType: 'chapters_error' - кнопка "Перезагрузить страницу"
// errorType: 'auth_required' - кнопки LIB сайтов для авторизации
function showMessage(text, isError = false, errorType = null) {
  document.getElementById('loader').classList.add('hidden');
  
  const errorView = document.getElementById('error-view');
  errorView.classList.remove('hidden');
  
  const msgText = document.getElementById('error-text');
  msgText.textContent = text;
  
  // Скрываем все кнопки
  document.getElementById('btn-mangalib').classList.add('hidden');
  document.getElementById('btn-hentailib').classList.add('hidden');
  document.getElementById('btn-shlib').classList.add('hidden');
  document.getElementById('btn-ranobelib').classList.add('hidden');
  document.getElementById('btn-animelib').classList.add('hidden');
  document.getElementById('btn-reload-page').classList.add('hidden');
  document.querySelector('.lib-buttons').classList.remove('hidden');
  
  // Показываем нужную кнопку в зависимости от типа ошибки
  if (errorType === 'not_on_site' || errorType === 'auth_required' || errorType === 'no_title') {
    document.getElementById('btn-mangalib').classList.remove('hidden');
    document.getElementById('btn-hentailib').classList.remove('hidden');
    document.getElementById('btn-shlib').classList.remove('hidden');
    document.getElementById('btn-ranobelib').classList.remove('hidden');
    document.getElementById('btn-animelib').classList.remove('hidden');
  } else if (errorType === 'chapters_error') {
    document.getElementById('btn-reload-page').classList.remove('hidden');
    document.querySelector('.lib-buttons').classList.add('hidden');
  }
  
  if (isError) {
    msgText.classList.add('error');
  } else {
    msgText.classList.remove('error');
  }
}

// Кнопка перезагрузки страницы
document.getElementById('btn-reload-page').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) {
    // Скрываем сообщение об ошибке и показываем loader
    document.getElementById('error-view').classList.add('hidden');
    document.getElementById('loader').classList.remove('hidden');
    updateLoader('Перезагрузка страницы...', 0);
    // Перезагружаем страницу, ждём её полной загрузки и повторяем обычную загрузку тайтла
    await new Promise(resolve => {
      const onUpdated = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.reload(tab.id);
    });
    await loadTitle();
  }
});

// Общие настройки вне страницы тайтла: полная страница настроек во вкладке (окно поверх сайта есть только на странице тайтла)
document.getElementById('btn-settings').addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('html/settings.html') });
  window.close();
});

// Кнопки открытия LIB сайтов
document.getElementById('btn-mangalib').addEventListener('click', async () => {
  await chrome.tabs.create({ url: 'https://mangalib.me' });
});

document.getElementById('btn-hentailib').addEventListener('click', async () => {
  await chrome.tabs.create({ url: 'https://hentailib.me' });
});

document.getElementById('btn-shlib').addEventListener('click', async () => {
  await chrome.tabs.create({ url: 'https://v2.shlib.life' });
});

document.getElementById('btn-ranobelib').addEventListener('click', async () => {
  await chrome.tabs.create({ url: 'https://ranobelib.me' });
});

document.getElementById('btn-animelib').addEventListener('click', async () => {
  await chrome.tabs.create({ url: 'https://animelib.org' });
});

// Секретное переключение логирования storage: 10 нажатий на текст сообщения за 8 секунд
let secretClicks = [];
const SECRET_CLICK_THRESHOLD = 10;
const SECRET_CLICK_WINDOW = 8000; // 8 секунд

document.getElementById('error-text').addEventListener('click', () => {
  const now = Date.now();

  // Удаляем клики старше 8 секунд
  secretClicks = secretClicks.filter(click => now - click < SECRET_CLICK_WINDOW);
  secretClicks.push(now);

  if (secretClicks.length >= SECRET_CLICK_THRESHOLD) {
    chrome.storage.session.get(['isLoggingEnabled'], (result) => {
      if (result.isLoggingEnabled) {
        chrome.runtime.sendMessage({ action: 'disableStorageLogging' });
      } else {
        chrome.runtime.sendMessage({ action: 'enableStorageLogging' });
      }
    });
    secretClicks = []; // Сбрасываем
  }
});
