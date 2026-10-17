let allChapters = []; // Все главы из API

// Загрузка сохраненных настроек
let savedQuality = 'ORIGINAL'; // По умолчанию без сжатия
let savedCoverQuality = 'ORIGINAL'; // По умолчанию без сжатия
let resizeMethod = 'MIN_SIDE'; // По умолчанию по меньшей стороне
let adaptiveRatio = 3; // По умолчанию 3:1
let jpegQuality = 1.0; // По умолчанию максимальное качество
let imageFormat = 'original'; // По умолчанию оригинальный формат
let pdfImageFormat = 'original-png'; // По умолчанию Исходный, иначе PNG для PDF
let pdfJpegQuality = 1.0; // По умолчанию максимальное качество для PDF
let disableToc = false;

// Обработчик сообщений для toast от других окон
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'showToast') {
    showToast(request.message, request.type);
  }
  if (request.action === 'checkWindowOpen') {
    sendResponse({ windowOpen: true, windowType: 'popup' });
  }
});

// Маппинг типов окон в понятные названия
const windowNames = {
  'settings': 'Настройки',
  'prepare': 'Окно подготовки',
  'chapters': 'Редактор оглавления',
  'metadata': 'Редактор метаданных',
  'covers': 'Редактор обложек',
  'workspace': 'Окно редакторов и настроек'
};

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

// Функция для сканирования реально открытых окон и обновления storage
async function syncOpenWindows() {
  const windows = await chrome.windows.getAll({ populate: true });
  let foundWindow = null;

  for (const win of windows) {
    for (const tab of win.tabs) {
      if (tab.url) {
        if (tab.url === chrome.runtime.getURL('html/settings.html')) {
          foundWindow = 'settings';
          break;
        } else if (tab.url === chrome.runtime.getURL('html/prepare.html')) {
          foundWindow = 'prepare';
          break;
        } else if (tab.url === chrome.runtime.getURL('html/chapters.html')) {
          foundWindow = 'chapters';
          break;
        } else if (tab.url === chrome.runtime.getURL('html/metadata.html')) {
          foundWindow = 'metadata';
          break;
        } else if (tab.url === chrome.runtime.getURL('html/covers.html')) {
          foundWindow = 'covers';
          break;
        } else if (tab.url.startsWith(chrome.runtime.getURL('html/workspace.html'))) {
          foundWindow = 'workspace';
          break;
        }
      }
    }
    if (foundWindow) break;
  }

  if (foundWindow) {
    await chrome.storage.local.set({ currentOpenWindow: foundWindow });
  } else {
    await chrome.storage.local.remove('currentOpenWindow');
  }
}

// Синхронизируем при загрузке popup
syncOpenWindows();

// Функция для проверки открытого окна перед открытием нового
async function canOpenWindow(windowType) {
  const result = await chrome.storage.local.get(['currentOpenWindow']);
  if (result.currentOpenWindow) {
    // Если открываем окно того же типа - разрешаем (для фокусировки)
    if (result.currentOpenWindow === windowType) {
      return true;
    }
    // Если другой тип - блокируем
    const windowName = windowNames[result.currentOpenWindow] || result.currentOpenWindow;
    showToast(`Закройте: ${windowName}`, 'error');
    return false;
  }
  return true;
}

// Глобальные переменные для настроек
let tocFormat = 'default';
let customTocFormat = '';
let hideChapterName = false;
let hideVolumeNumber = false;

chrome.storage.local.get(['imageQuality', 'coverQuality', 'resizeMethod', 'adaptiveRatio', 'jpegQuality', 'imageFormat', 'pdfImageFormat', 'pdfJpegQuality', 'disableToc', 'tocFormat', 'customTocFormat', 'hideChapterName', 'hideVolumeNumber'], (result) => {
  if (result.imageQuality) {
    savedQuality = result.imageQuality;
  }
  if (result.coverQuality) {
    savedCoverQuality = result.coverQuality;
  }
  if (result.resizeMethod) {
    resizeMethod = result.resizeMethod;
  }
  if (result.adaptiveRatio) {
    adaptiveRatio = result.adaptiveRatio;
  }
  if (result.jpegQuality !== undefined) {
    jpegQuality = result.jpegQuality;
  }
  if (result.imageFormat) {
    imageFormat = result.imageFormat;
  }
  if (result.pdfImageFormat) {
    pdfImageFormat = result.pdfImageFormat;
  }
  if (result.pdfJpegQuality !== undefined) {
    pdfJpegQuality = result.pdfJpegQuality;
  }
  if (result.disableToc !== undefined) {
    disableToc = result.disableToc;
  }
  if (result.tocFormat) {
    tocFormat = result.tocFormat;
  }
  if (result.customTocFormat) {
    customTocFormat = result.customTocFormat;
  }
  if (result.hideChapterName !== undefined) {
    hideChapterName = result.hideChapterName;
  }
  if (result.hideVolumeNumber !== undefined) {
    hideVolumeNumber = result.hideVolumeNumber;
  }
});

// Слушаем изменения в storage для обновления списков глав и метаданных
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    // Обновление качества картинок и обложек в реальном времени
    if (changes.imageQuality) {
      savedQuality = changes.imageQuality.newValue;
    }
    if (changes.coverQuality) {
      savedCoverQuality = changes.coverQuality.newValue;
    }
    if (changes.resizeMethod) {
      resizeMethod = changes.resizeMethod.newValue;
    }
    if (changes.adaptiveRatio) {
      adaptiveRatio = changes.adaptiveRatio.newValue;
    }
    if (changes.jpegQuality !== undefined) {
      jpegQuality = changes.jpegQuality.newValue;
    }
    if (changes.imageFormat) {
      imageFormat = changes.imageFormat.newValue;
    }
    if (changes.pdfImageFormat) {
      pdfImageFormat = changes.pdfImageFormat.newValue;
    }
    if (changes.pdfJpegQuality !== undefined) {
      pdfJpegQuality = changes.pdfJpegQuality.newValue;
    }
    
    // Обновление глав
    const titleChange = getTitleChange(changes, 'titleData', currentSlug);
    if (titleChange) {
      const newData = titleChange.newValue;
      if (newData && newData.chapters) {
        allChapters = newData.chapters;
        populateChapters();
      }
    }
    // Обновление названия при изменении в редакторе метаданных
    if (titleChange) {
      const newData = titleChange.newValue;
      if (newData && newData.metadata && newData.metadata.titleRu) {
        const bookTitleElement = document.getElementById('book-title');
        if (bookTitleElement) {
          bookTitleElement.textContent = newData.metadata.titleRu;
        }
      }
    }
    // Обновление формата оглавления
    if (changes.tocFormat || changes.customTocFormat || changes.hideChapterName || changes.hideVolumeNumber) {
      if (changes.tocFormat) {
        tocFormat = changes.tocFormat.newValue;
      }
      if (changes.customTocFormat) {
        customTocFormat = changes.customTocFormat.newValue;
      }
      if (changes.hideChapterName) {
        hideChapterName = changes.hideChapterName.newValue;
      }
      if (changes.hideVolumeNumber) {
        hideVolumeNumber = changes.hideVolumeNumber.newValue;
      }

      // Пересоздаём displayTitle для всех глав
      if (allChapters.length > 0) {
        allChapters.forEach(ch => {
          ch.displayTitle = formatChapterTitle(ch.volume, ch.number, ch.name, tocFormat, customTocFormat, hideChapterName, hideVolumeNumber);
        });
        populateChapters();
      }
    }
  }
});

// Слушаем сообщения для переформатирования глав
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'reformatChapters') {
    // Перезагружаем настройки формата
    chrome.storage.local.get(['tocFormat', 'customTocFormat', 'hideChapterName', 'hideVolumeNumber'], (result) => {
      if (result.tocFormat) tocFormat = result.tocFormat;
      if (result.customTocFormat) customTocFormat = result.customTocFormat;
      if (result.hideChapterName !== undefined) hideChapterName = result.hideChapterName;
      if (result.hideVolumeNumber !== undefined) hideVolumeNumber = result.hideVolumeNumber;

      // Перезагружаем главы из originalTitleData
      getTitleStore(['originalTitleData', 'currentSlug']).then((result) => {
        if (result.originalTitleData && result.currentSlug && result.originalTitleData[result.currentSlug]) {
          const originalChapters = result.originalTitleData[result.currentSlug].chapters;
          if (originalChapters && allChapters.length > 0) {
            // Обновляем данные глав из оригинальных
            originalChapters.forEach((origCh, index) => {
              if (allChapters[index]) {
                allChapters[index].volume = origCh.volume;
                allChapters[index].number = origCh.number;
                allChapters[index].name = origCh.name;
                allChapters[index].displayTitle = formatChapterTitle(origCh.volume, origCh.number, origCh.name, tocFormat, customTocFormat, hideChapterName, hideVolumeNumber);
              }
            });
            populateChapters();
          }
        }
      });
    });
  }
});

// Функция для получения случайной строки из текстового файла
async function getRandomCoverInspectionText() {
  try {
    const response = await fetch(chrome.runtime.getURL('assets/local_data'));
    if (!response.ok) {
      return 'Рассматриваем обложку...'; // Fallback если файл не доступен
    }
    const text = await response.text();
    const lines = text.split('\n').filter(line => line.trim() !== '');
    if (lines.length === 0) {
      return 'Рассматриваем обложку...';
    }
    const randomIndex = Math.floor(Math.random() * lines.length);
    return lines[randomIndex].trim();
  } catch (e) {
    return 'Рассматриваем обложку...'; // Fallback при ошибке
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

// Функция для включения/выключения кнопок
function enableButton(buttonId, enabled) {
  const button = document.getElementById(buttonId);
  if (button) {
    button.disabled = !enabled;
  }
}

// Функция для включения всех кнопок редакторов
function enableEditorButtons(enabled) {
  enableButton('btn-download', enabled);
}

// Глобальная переменная для начального прогресса

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

  // Удаляем старый downloadData при открытии popup (предотвращаем накопление мусора)
  chrome.storage.local.remove('downloadData');

  // Проверка обновлений при открытии popup (с задержкой 2 секунды)
  setTimeout(checkForUpdatesPopup, 2000);

  await loadTitle();
});

// Загрузка данных тайтла из активной вкладки (при открытии popup и после перезагрузки страницы)
async function loadTitle() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab || !activeTab.url) {
    showMessage('Не удалось определить активную вкладку.', true, 'no_title');
    return;
  }

  const url = activeTab.url;

  // Применяем акцентный цвет по сайту
  window.applySiteAccent(url);
  // Определяем тип сайта и сохраняем
  await chrome.storage.local.set({ siteType: siteTypeOf(siteKeyOf(url)), sourceUrl: url });

  let loaderText;
  const showProgress = loadedParts => {
    loaderText ??= getRandomCoverInspectionText();
    loaderText.then(text => updateLoader(text, 10 + 30 * loadedParts));
  };

  let info;
  try {
    info = await loadTitleData({ tabId: activeTab.id, url, onProgress: showProgress });
  } catch (error) {
    if (error.code === 'unsupported-site') {
      showMessage('Перейдите на один из поддерживаемых сайтов.', false, 'not_on_site');
      enableButton('btn-settings', true);
    } else if (error.code === 'not-title-page') {
      showMessage('Перейдите на главную страницу нужного тайтла.', false, 'no_title');
      enableButton('btn-settings', true);
    } else if (error.code === 'load-failed') {
      showMessage('Не удалось получить данные из API.', true, 'chapters_error');
    } else {
      throw error;
    }
    return;
  }

  currentSlug = info.slug;
  allChapters = info.allChapters;
  originalCover = info.originalCover;
  allCovers = info.covers;
  populateChapters();
  document.getElementById('book-title').textContent = info.title;

  // Сначала скрываем loader
  document.getElementById('loader').classList.add('hidden');

  // Потом показываем main-view
  document.getElementById('main-view').classList.remove('hidden');

  // Потом включаем кнопки
  enableEditorButtons(true);
  enableButton('btn-settings', true);
  document.querySelector('.btn-group').classList.remove('hidden');
}

// Функция для открытия popup окна
async function openPopupWindow(url, withTargetTabId = false) {
  // Определяем тип окна по URL
  let windowType = '';
  if (url.includes('settings.html')) windowType = 'settings';
  else if (url.includes('prepare.html')) windowType = 'prepare';
  else if (url.includes('chapters.html')) windowType = 'chapters';
  else if (url.includes('metadata.html')) windowType = 'metadata';
  else if (url.includes('covers.html')) windowType = 'covers';
  else if (url.includes('workspace.html')) windowType = 'workspace';

  // Проверяем, можно ли открыть окно
  if (!await canOpenWindow(windowType)) {
    return; // Нельзя открыть - уже показан toast
  }

  // Сначала проверяем, есть ли уже открытое окно с этим URL
  chrome.windows.getAll({ populate: true }, (windows) => {
    let existingWindow = null;

    for (const win of windows) {
      for (const tab of win.tabs) {
        if (tab.url && tab.url.includes(url.split('?')[0])) {
          existingWindow = win;
          break;
        }
      }
      if (existingWindow) break;
    }

    if (existingWindow) {
      // Фокусируемся на существующем окне
      chrome.windows.update(existingWindow.id, { focused: true });
    } else {
      // Создаём новое окно
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const targetTabId = tabs?.[0]?.id ?? null;
        const sourceUrl = tabs?.[0]?.url ?? null;

        const storageData = { currentSlug, targetTabId, sourceUrl };

        chrome.storage.local.set(storageData, () => {
          const width = 1024;
          const height = 768;

          chrome.system.display.getInfo((displays) => {
            const primaryDisplay = displays.find(d => d.isPrimary) || displays[0];
            const bounds = primaryDisplay.workArea;

            const left = Math.round(bounds.left + (bounds.width - width) / 2);
            const top = Math.round(bounds.top + (bounds.height - height) / 2);

            chrome.windows.create({
              url: chrome.runtime.getURL(url),
              type: 'popup',
              width: width,
              height: height,
              left: left,
              top: top,
              focused: true
            });
          });
        });
      });
    }
  });
}

// Сохраняет выбранный диапазон глав для редактора оглавления
async function saveChapterRange() {
  const fromIdx = parseInt(document.getElementById('chapter-from').value);
  const toIdx = parseInt(document.getElementById('chapter-to').value);
  
  // Сохраняем главы в titleData
  const result = await getTitleStore(['titleData', 'currentSlug']);
  const titleData = result.titleData || {};
  const currentSlug = result.currentSlug;
  
  if (!titleData[currentSlug]) {
    titleData[currentSlug] = { chapters: null, metadata: {} };
  }
  
  // Фильтруем главы по диапазону
  const filteredChapters = allChapters.slice(fromIdx, toIdx + 1);
  
  titleData[currentSlug].chapters = allChapters; // Сохраняем все главы
  titleData[currentSlug].filteredChapters = filteredChapters; // Сохраняем отфильтрованные главы для редактора
  titleData[currentSlug].fromIdx = fromIdx;
  titleData[currentSlug].toIdx = toIdx;
  await setTitleStore({ titleData });
}

// Глобальные переменные данных тайтла
let currentSlug = '';
let originalCover = '';
let allCovers = []; // Все обложки из popup

// Кнопка скачивания
document.getElementById('btn-download').addEventListener('click', () => {
  const fromIdx = parseInt(document.getElementById('chapter-from').value);
  const toIdx = parseInt(document.getElementById('chapter-to').value);
  const quality = savedQuality; // Используем сохраненное качество из настроек
  
  const selectedChapters = allChapters.slice(fromIdx, toIdx + 1);

  // Получаем метаданные из storage
  getTitleStore(['titleData', 'originalTitleData', 'siteType'], currentSlug).then((result) => {
    const metadata = result.titleData && result.titleData[currentSlug] && result.titleData[currentSlug].metadata ? result.titleData[currentSlug].metadata : {};
    const originalMetadata = result.originalTitleData && result.originalTitleData[currentSlug] && result.originalTitleData[currentSlug].metadata ? result.originalTitleData[currentSlug].metadata : {};
    const translatorPriority = result.titleData && result.titleData[currentSlug] ? (result.titleData[currentSlug].translatorPriority || []) : [];
    const chapterBranchOverrides = result.titleData && result.titleData[currentSlug] ? (result.titleData[currentSlug].chapterBranchOverrides || {}) : {};
    const siteType = result.siteType || 'ranobe';
    
    // Получаем ID текущей вкладки для content script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const currentTabId = tabs?.[0]?.id ?? null;
      
      const downloadData = {
        slug: currentSlug,
        format: 'epub',
        metadata: metadata,
        originalMetadata: originalMetadata,
        originalCover: originalCover,
        allCovers: metadata.covers || allCovers, // Используем обложки из редактора (если пользователь сохранял изменения) или из API (по умолчанию)
        quality: quality,
        coverQuality: savedCoverQuality,
        resizeMethod: resizeMethod,
        adaptiveRatio: adaptiveRatio,
        jpegQuality: jpegQuality,
        imageFormat: imageFormat,
        pdfImageFormat: pdfImageFormat,
        pdfJpegQuality: pdfJpegQuality,
        mangaId: currentSlug,
        chapters: selectedChapters,
        translatorPriority: translatorPriority, // Добавляем приоритет переводчиков
        chapterBranchOverrides: chapterBranchOverrides, // Добавляем переопределения переводчиков
        disableToc: disableToc,
        epubTocPage: !disableToc, // Вычисляем значение из disableToc
        tabId: currentTabId,
        siteType: siteType
      };

      chrome.storage.local.set({ downloadData }, () => {
        openPopupWindow('html/prepare.html', true);
      });
    });
  });
});




// Синхронизация диапазонов "От" и "До"
document.getElementById('chapter-from').addEventListener('change', async (e) => {
  const fromIdx = parseInt(e.target.value);
  const toSelect = document.getElementById('chapter-to');
  const toIdx = parseInt(toSelect.value);
  if (toIdx < fromIdx) {
    toSelect.value = fromIdx;
  }

  // Обновляем сохраненный диапазон и пересоздаём filteredChapters при изменении
  const result = await getTitleStore(['titleData', 'currentSlug']);
  const titleData = result.titleData || {};
  const currentSlug = result.currentSlug;

  if (titleData[currentSlug]) {
    titleData[currentSlug].fromIdx = fromIdx;
    titleData[currentSlug].toIdx = parseInt(toSelect.value);
    // Пересоздаём filteredChapters на основе текущего allChapters и нового диапазона
    if (titleData[currentSlug].chapters) {
      titleData[currentSlug].filteredChapters = titleData[currentSlug].chapters.slice(fromIdx, parseInt(toSelect.value) + 1);
    }
    await setTitleStore({ titleData });
  }
});

document.getElementById('chapter-to').addEventListener('change', async (e) => {
  const toIdx = parseInt(e.target.value);
  const fromSelect = document.getElementById('chapter-from');
  const fromIdx = parseInt(fromSelect.value);
  if (fromIdx > toIdx) {
    fromSelect.value = toIdx;
  }

  // Обновляем сохраненный диапазон и пересоздаём filteredChapters при изменении
  const result = await getTitleStore(['titleData', 'currentSlug']);
  const titleData = result.titleData || {};
  const currentSlug = result.currentSlug;

  if (titleData[currentSlug]) {
    titleData[currentSlug].fromIdx = parseInt(fromSelect.value);
    titleData[currentSlug].toIdx = toIdx;
    // Пересоздаём filteredChapters на основе текущего allChapters и нового диапазона
    if (titleData[currentSlug].chapters) {
      titleData[currentSlug].filteredChapters = titleData[currentSlug].chapters.slice(parseInt(fromSelect.value), toIdx + 1);
    }
    await setTitleStore({ titleData });
  }
});

// Показ сообщения (isError = true включает красный цвет, errorType определяет кнопку)
// errorType: 'not_on_site' - кнопки LIB сайтов
// errorType: 'no_title' - без кнопки
// errorType: 'chapters_error' - кнопка "Перезагрузить страницу"
// errorType: 'auth_required' - кнопки LIB сайтов для авторизации
function showMessage(text, isError = false, errorType = null) {
  document.getElementById('loader').classList.add('hidden');
  document.getElementById('main-view').classList.add('hidden');
  
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
  
  // Показываем кнопки при сообщении об ошибке
  document.querySelector('.btn-group').classList.remove('hidden');
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

// Кнопка настроек (с секретным переключением логирования storage)
let settingsClicks = [];
const SETTINGS_CLICK_THRESHOLD = 10;
const SETTINGS_CLICK_WINDOW = 8000; // 8 секунд

document.getElementById('btn-settings').addEventListener('click', async () => {
  const now = Date.now();
  
  // Удаляем клики старше 8 секунд
  settingsClicks = settingsClicks.filter(click => now - click < SETTINGS_CLICK_WINDOW);
  settingsClicks.push(now);
  
  // Если 10 кликов за 8 секунд - переключаем логирование
  if (settingsClicks.length >= SETTINGS_CLICK_THRESHOLD) {
    chrome.storage.session.get(['isLoggingEnabled'], (result) => {
      if (result.isLoggingEnabled) {
        chrome.runtime.sendMessage({ action: 'disableStorageLogging' });
      } else {
        chrome.runtime.sendMessage({ action: 'enableStorageLogging' });
      }
    });
    settingsClicks = []; // Сбрасываем
  }
  
  // Редакторы доступны только когда тайтл загружен, иначе окно откроется с одними настройками
  if (allChapters.length > 0) {
    await saveChapterRange();
    openPopupWindow('html/workspace.html');
  } else {
    openPopupWindow('html/workspace.html?title=0');
  }
});

// Обновление списков диапазонов
function populateChapters() {
  const fromSelect = document.getElementById('chapter-from');
  const toSelect = document.getElementById('chapter-to');

  // Сохраняем текущие значения ДО очистки
  const savedFromValue = fromSelect.value;
  const savedToValue = toSelect.value;

  fromSelect.innerHTML = '';
  toSelect.innerHTML = '';

  if (allChapters.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'Нет глав';
    fromSelect.appendChild(opt);
    toSelect.appendChild(opt.cloneNode(true));
    return;
  }

  allChapters.forEach((ch, index) => {
    const optFrom = document.createElement('option');
    optFrom.value = index;
    optFrom.textContent = ch.displayTitle;
    fromSelect.appendChild(optFrom);

    const optTo = document.createElement('option');
    optTo.value = index;
    optTo.textContent = ch.displayTitle;
    toSelect.appendChild(optTo);
  });

  // Восстанавливаем сохраненные значения, если они валидны
  let fromValid = false;
  let toValid = false;
  
  for (let i = 0; i < fromSelect.options.length; i++) {
    if (fromSelect.options[i].value === savedFromValue) {
      fromValid = true;
      break;
    }
  }
  
  for (let i = 0; i < toSelect.options.length; i++) {
    if (toSelect.options[i].value === savedToValue) {
      toValid = true;
      break;
    }
  }
  
  if (fromValid) {
    fromSelect.value = savedFromValue;
  } else {
    fromSelect.value = 0;
  }
  
  if (toValid) {
    toSelect.value = savedToValue;
  } else {
    toSelect.value = allChapters.length - 1;
  }
}
