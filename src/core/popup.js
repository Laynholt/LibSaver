let allChapters = []; // Все главы из API
let translatorPriority = []; // Приоритет переводчиков (порядок выбора)
let chapterBranchOverrides = {}; // Переопределения переводчиков для конкретных глав

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
  'covers': 'Редактор обложек'
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
      console.log('Уведомления об обновлениях отключены');
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
    console.error('Ошибка проверки обновлений в popup:', error);
  }
}

// Функция для сканирования реально открытых окон и обновления storage
async function syncOpenWindows() {
  const windows = await chrome.windows.getAll({ populate: true });
  let foundWindow = null;

  for (const win of windows) {
    for (const tab of win.tabs) {
      if (tab.url) {
        if (tab.url.includes('settings.html')) {
          foundWindow = 'settings';
          break;
        } else if (tab.url.includes('prepare.html')) {
          foundWindow = 'prepare';
          break;
        } else if (tab.url.includes('chapters.html')) {
          foundWindow = 'chapters';
          break;
        } else if (tab.url.includes('metadata.html')) {
          foundWindow = 'metadata';
          break;
        } else if (tab.url.includes('covers.html')) {
          foundWindow = 'covers';
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
    if (changes.titleData && currentSlug) {
      const newData = changes.titleData.newValue;
      if (newData && newData[currentSlug] && newData[currentSlug].chapters) {
        allChapters = newData[currentSlug].chapters;
        populateChapters();
      }
    }
    // Обновление названия при изменении в редакторе метаданных
    if (changes.titleData && currentSlug) {
      const newData = changes.titleData.newValue;
      if (newData && newData[currentSlug] && newData[currentSlug].metadata && newData[currentSlug].metadata.titleRu) {
        const bookTitleElement = document.getElementById('book-title');
        if (bookTitleElement) {
          bookTitleElement.textContent = newData[currentSlug].metadata.titleRu;
        }
      }
    }
    // Обновление формата оглавления
    if (changes.tocFormat || changes.customTocFormat || changes.hideChapterName || changes.hideVolumeNumber) {
      console.log('Settings changed:', changes);
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
      console.log('Updated settings:', { tocFormat, customTocFormat, hideChapterName, hideVolumeNumber });

      // Пересоздаём displayTitle для всех глав
      if (allChapters.length > 0) {
        console.log('Reformatting chapters, count:', allChapters.length);
        allChapters.forEach(ch => {
          ch.displayTitle = formatChapterTitle(ch.volume, ch.number, ch.name, tocFormat, customTocFormat, hideChapterName, hideVolumeNumber);
        });
        console.log('Sample formatted title:', allChapters[0]?.displayTitle);
        populateChapters();
      }
    }
  }
});

// Слушаем сообщения для переформатирования глав
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'reformatChapters') {
    console.log('Received reformatChapters message');
    // Перезагружаем настройки формата
    chrome.storage.local.get(['tocFormat', 'customTocFormat', 'hideChapterName', 'hideVolumeNumber'], (result) => {
      if (result.tocFormat) tocFormat = result.tocFormat;
      if (result.customTocFormat) customTocFormat = result.customTocFormat;
      if (result.hideChapterName !== undefined) hideChapterName = result.hideChapterName;
      if (result.hideVolumeNumber !== undefined) hideVolumeNumber = result.hideVolumeNumber;

      // Перезагружаем главы из originalTitleData
      chrome.storage.local.get(['originalTitleData', 'currentSlug'], (result) => {
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
    console.error('Ошибка при чтении файла local_data:', e);
    return 'Рассматриваем обложку...'; // Fallback при ошибке
  }
}

// Функция для очень быстрого прогресса (для основных этапов)
async function fastProgress(targetProgress) {
  const loaderProgress = document.getElementById('loader-progress');
  if (!loaderProgress) return;
  
  const currentProgress = parseFloat(loaderProgress.style.width) || 0;
  const diff = targetProgress - currentProgress;
  
  if (diff <= 0.5) {
    await animateProgress(targetProgress, 20);
  } else {
    // Быстрые шаги по 3-5%
    const stepCount = Math.ceil(diff / 4);
    const stepSize = diff / stepCount;
    const durationPerStep = 25 / stepCount; // 25ms всего
    
    let progress = currentProgress;
    for (let i = 0; i < stepCount; i++) {
      const nextProgress = Math.min(progress + stepSize, targetProgress);
      await animateProgress(nextProgress, durationPerStep);
      progress = nextProgress;
    }
  }
}

// Функция для медленного плавного прогресса (для Рассматриваем обложку - 800мс)
async function slowSmoothProgress(targetProgress) {
  const loaderProgress = document.getElementById('loader-progress');
  if (!loaderProgress) return;
  
  const currentProgress = parseFloat(loaderProgress.style.width) || 0;
  const diff = targetProgress - currentProgress;
  
  if (diff <= 0.5) {
    await animateProgress(targetProgress, 50);
  } else {
    // Очень мелкие шаги по 0.5% для максимальной плавности
    const stepCount = Math.ceil(diff / 0.5);
    const stepSize = diff / stepCount;
    const durationPerStep = 1200 / stepCount; // 1200ms всего
    
    let progress = currentProgress;
    for (let i = 0; i < stepCount; i++) {
      const nextProgress = Math.min(progress + stepSize, targetProgress);
      await animateProgress(nextProgress, durationPerStep);
      progress = nextProgress;
    }
  }
}

// Функция для Готово (400мс)
async function readyProgress(targetProgress) {
  const loaderProgress = document.getElementById('loader-progress');
  if (!loaderProgress) return;
  
  const currentProgress = parseFloat(loaderProgress.style.width) || 0;
  const diff = targetProgress - currentProgress;
  
  if (diff <= 0.5) {
    await animateProgress(targetProgress, 50);
  } else {
    // Шаги по 1% для плавности
    const stepCount = Math.ceil(diff / 1);
    const stepSize = diff / stepCount;
    const durationPerStep = 400 / stepCount; // 400ms всего
    
    let progress = currentProgress;
    for (let i = 0; i < stepCount; i++) {
      const nextProgress = Math.min(progress + stepSize, targetProgress);
      await animateProgress(nextProgress, durationPerStep);
      progress = nextProgress;
    }
  }
}

// Функция для случайной задержки
function randomDelay(min, max) {
  const delay = Math.random() * (max - min) + min;
  return new Promise(resolve => setTimeout(resolve, delay));
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

// Функция для плавного увеличения прогресса
function animateProgress(targetProgress, duration = 300) {
  return new Promise(resolve => {
    const loaderProgress = document.getElementById('loader-progress');
    if (!loaderProgress) {
      resolve();
      return;
    }
    
    const startProgress = parseFloat(loaderProgress.style.width) || 0;
    const startTime = performance.now();
    
    function animate(currentTime) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const currentProgress = startProgress + (targetProgress - startProgress) * progress;
      
      loaderProgress.style.width = currentProgress + '%';
      
      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        resolve();
      }
    }
    
    requestAnimationFrame(animate);
  });
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
  enableButton('btn-covers', enabled);
  enableButton('btn-metadata', enabled);
  enableButton('btn-edit-chapters', enabled);
}

// Глобальная переменная для начального прогресса
let globalStartProgress = 0;

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
      console.error('Failed to load SVG:', svgPath, error);
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

  // Очищаем старые titleData (старше 7 дней) для предотвращения мусора
  const result = await chrome.storage.local.get(['titleData']);
  if (result.titleData) {
    const titleData = result.titleData;
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    let modified = false;
    
    for (const slug in titleData) {
      if (titleData[slug].cacheTimestamp && titleData[slug].cacheTimestamp < sevenDaysAgo) {
        delete titleData[slug];
        modified = true;
      }
    }
    
    if (modified) {
      await chrome.storage.local.set({ titleData });
    }
  }

  // Проверка обновлений при открытии popup (с задержкой 2 секунды)
  setTimeout(checkForUpdatesPopup, 2000);

  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const activeTab = tabs[0];
    if (!activeTab || !activeTab.url) {
      showMessage('Не удалось определить активную вкладку.', true, 'no_title');
      return;
    }

    const url = activeTab.url;

    // Применяем акцентный цвет по сайту
    window.applySiteAccent(url);
    // Проверка, что мы находимся на поддерживаемом сайте
    const isRanobeLib = url.includes('ranobelib.me') || url.includes('novelslib.me');
    const isMangaLib = url.includes('mangalib.me') || url.includes('mangalib.org');
    const isHentaiLib = url.includes('hentailib.me') || url.includes('hentailib.org');
    const isShLib = url.includes('v2.shlib.life') || url.includes('shlib.life');
    const isAnimeLib = url.includes('animelib.org') || url.includes('anilib.me');
    const isSupportedSite = isRanobeLib || isMangaLib || isHentaiLib || isShLib || isAnimeLib;
    
    // Определяем тип сайта и сохраняем
    let siteType = 'ranobe';
    if (isMangaLib || isHentaiLib || isShLib) {
      siteType = 'manga';
    } else if (isAnimeLib) {
      siteType = 'anime';
    }
    await chrome.storage.local.set({ siteType, sourceUrl: url });
    
    // Проверка, что мы находимся на странице тайтла
    const isBookPage = url.includes('/book/') || url.includes('/manga/') || url.includes('/anime/');

    if (!isSupportedSite) {
      showMessage('Перейдите на один из поддерживаемых сайтов.', false, 'not_on_site');
      enableButton('btn-settings', true);
      return;
    }

    if (!isBookPage) {
      showMessage('Перейдите на главную страницу нужного тайтла.', false, 'no_title');
      enableButton('btn-settings', true);
      return;
    }

    // Извлекаем slug из URL для кэширования (используем тот же паттерн что и в API)
    let urlSlug = null;
    if (url.includes('ranobelib.me') || url.includes('novelslib.me')) {
      const slugMatch = url.match(/\/ru\/book\/([^-]+)(--[^?]+)?/);
      urlSlug = slugMatch ? slugMatch[1] + (slugMatch[2] || '') : null;
    } else if (url.includes('mangalib.me') || url.includes('mangalib.org')) {
      const slugMatch = url.match(/\/ru\/manga\/([^-]+)(--[^?]+)?/);
      urlSlug = slugMatch ? slugMatch[1] + (slugMatch[2] || '') : null;
    } else if (url.includes('hentailib.me') || url.includes('hentailib.org')) {
      const slugMatch = url.match(/\/ru\/manga\/([^-]+)(--[^?]+)?/);
      urlSlug = slugMatch ? slugMatch[1] + (slugMatch[2] || '') : null;
    } else if (url.includes('v2.shlib.life') || url.includes('shlib.life')) {
      const slugMatch = url.match(/\/ru\/manga\/([^-]+)(--[^?]+)?/);
      urlSlug = slugMatch ? slugMatch[1] + (slugMatch[2] || '') : null;
    } else if (url.includes('animelib.org') || url.includes('anilib.me')) {
      const slugMatch = url.match(/\/ru\/anime\/([^-]+)(--[^?]+)?/);
      urlSlug = slugMatch ? slugMatch[1] + (slugMatch[2] || '') : null;
    }

    // Проверяем кэш - есть ли полные данные для этого тайтла
    const cachedData = urlSlug ? await chrome.storage.local.get(['titleData', 'originalTitleData', 'currentSlug']) : { titleData: {}, originalTitleData: {}, currentSlug: null };
    const titleData = cachedData.titleData || {};
    const originalTitleData = cachedData.originalTitleData || {};
    const hasChapters = urlSlug && titleData[urlSlug] && titleData[urlSlug].chapters && titleData[urlSlug].chapters.length > 0;
    const hasMetadata = urlSlug && titleData[urlSlug] && titleData[urlSlug].metadata && Object.keys(titleData[urlSlug].metadata).length > 0;
    const hasCovers = urlSlug && titleData[urlSlug] && (titleData[urlSlug].covers || titleData[urlSlug].metadata?.cover);
    const hasOriginalMetadata = urlSlug && originalTitleData[urlSlug] && originalTitleData[urlSlug].metadata && Object.keys(originalTitleData[urlSlug].metadata).length > 0;

    // Проверяем timestamp кэша (устаревает через 10 минут = 600000 мс)
    const cacheTimestamp = urlSlug && titleData[urlSlug] ? titleData[urlSlug].cacheTimestamp : 0;
    const cacheAge = Date.now() - cacheTimestamp;
    const CACHE_MAX_AGE = 10 * 60 * 1000; // 10 минут
    const isCacheFresh = cacheAge < CACHE_MAX_AGE;

    // Используем кэш если есть полные данные, они свежие и включены originalTitleData
    if (hasChapters && hasMetadata && hasCovers && hasOriginalMetadata && isCacheFresh) {
      await chrome.storage.local.set({ currentSlug: urlSlug });
      currentSlug = urlSlug;

      // Восстанавливаем данные из кэша
      allChapters = titleData[urlSlug].chapters;
      originalCover = titleData[urlSlug].metadata.cover || '';
      allCovers = titleData[urlSlug].covers || (titleData[urlSlug].metadata?.cover ? [titleData[urlSlug].metadata.cover] : []);

      // Восстанавливаем приоритет переводчиков
      translatorPriority = titleData[urlSlug].translatorPriority || [];
      chapterBranchOverrides = titleData[urlSlug].chapterBranchOverrides || {};

      // Обновляем UI
      processChapters(allChapters);
      applyTranslatorPriority();
      populateChapters();

      const displayTitle = titleData[urlSlug].metadata.titleRu || titleData[urlSlug].metadata.titleEn || titleData[urlSlug].metadata.titleOriginal || 'Без названия';
      document.getElementById('book-title').textContent = displayTitle;

      // Готово (400мс - визуальный маркер)
      updateLoader('Готово!', 100);
      await readyProgress(100);
      await new Promise(resolve => setTimeout(resolve, 400));

      // Показываем UI
      document.getElementById('loader').classList.add('hidden');
      document.getElementById('main-view').classList.remove('hidden');
      document.querySelector('.btn-group').classList.remove('hidden');
      enableButton('btn-download', true);
      enableButton('btn-metadata', true);
      enableButton('btn-covers', true);
      enableButton('btn-edit-chapters', true);
      enableButton('btn-settings', true);
      return;
    }

    // Загружаем данные о ранобэ
    globalStartProgress = 0;
    
    // Загрузка данных через API
    updateLoader('Загрузка данных...', 5);
    
    // Загружаем главы
    const chaptersResult = await loadChapters(activeTab.id);
    if (chaptersResult && chaptersResult.success) {
      const newSlug = chaptersResult.slug;

      // Проверяем, изменился ли тайтл
      const result = await chrome.storage.local.get(['currentSlug', 'titleData', 'originalTitleData']);
      const oldSlug = result.currentSlug;
      if (oldSlug !== newSlug) {
        // Очищаем данные для старой книги
        const titleData = result.titleData || {};
        const originalTitleData = result.originalTitleData || {};
        delete titleData[oldSlug];
        delete originalTitleData[oldSlug];
        await chrome.storage.local.set({ titleData, originalTitleData });
      }
      await chrome.storage.local.set({ currentSlug: newSlug });
      currentSlug = newSlug;

      // Загружаем приоритет переводчиков (НЕ восстанавливаем диапазон - пользователь может свободно менять его)
      if (result.titleData && result.titleData[newSlug]) {
        translatorPriority = result.titleData[newSlug].translatorPriority || [];
        chapterBranchOverrides = result.titleData[newSlug].chapterBranchOverrides || {};
      } else {
        translatorPriority = [];
        chapterBranchOverrides = {};
      }
      if (chaptersResult.chapters) {
        processChapters(chaptersResult.chapters);
        applyTranslatorPriority();
        populateChapters();
      } else {
        console.error('chaptersResult.chapters is undefined:', chaptersResult);
        showMessage('Не удалось получить данные из API.', true, 'chapters_error');
        return;
      }
    } else {
      showMessage('Не удалось получить данные из API.', true, 'chapters_error');
      return;
    }

    // Загружаем метаданные
    const metadataResult = await loadMetadata(activeTab.id);
    if (metadataResult && metadataResult.success) {
      const metadata = metadataResult.metadata;
      const slug = metadataResult.slug;

      // Загружаем пользовательские метаданные
      const titleDataResult = await chrome.storage.local.get(['titleData']);
      const titleData = titleDataResult.titleData || {};

      // Устанавливаем заголовок с цепочкой fallback
      const userMetadata = titleData && titleData[slug] ? titleData[slug].metadata : {};
      const displayTitle = userMetadata.titleRu || metadata.titleRu || metadata.titleEn || metadata.titleOriginal || 'Без названия';
      document.getElementById('book-title').textContent = displayTitle;
      originalCover = metadata.cover || '';

      if (!titleData[slug]) {
        titleData[slug] = { chapters: null, metadata: {} };
      }
      titleData[slug].itemsCount = metadata.totalChapters;
      titleData[slug].cacheTimestamp = Date.now();
      await chrome.storage.local.set({ titleData });
      
      // Сохраняем метаданные в storage
      chrome.storage.local.get(['titleData', 'originalTitleData'], (result) => {
        const titleData = result.titleData || {};
        const originalTitleData = result.originalTitleData || {};
        
        
        // Инициализируем структуру если нет
        if (!titleData[slug]) {
          titleData[slug] = { chapters: null, metadata: {} };
        }
        if (!originalTitleData[slug]) {
          originalTitleData[slug] = { chapters: null, metadata: {} };
        }
        
        // Сохраняем оригинальные данные из API (всегда обновляем)
        originalTitleData[slug].metadata = { ...metadata };

        // Сохраняем пользовательские данные только если их нет (не перезаписываем правки)
        // Проверяем по наличию хотя бы одного ключа в metadata
        const userMetadataKeys = Object.keys(titleData[slug].metadata);
        if (userMetadataKeys.length === 0) {
          titleData[slug].metadata = { ...metadata };
        }

        // Сохраняем timestamp кэша (для устаревания через 10 минут)
        titleData[slug].cacheTimestamp = Date.now();

        chrome.storage.local.set({ titleData, originalTitleData });
      });
    } else {
      console.error('Не удалось загрузить метаданные:', metadataResult?.error);
    }
    
    // Загружаем обложки
    const coversResult = await loadCovers(activeTab.id, currentSlug);
    if (coversResult && coversResult.success) {
      allCovers = coversResult.covers;
      
      // Если covers API вернул пустой массив, fallback на metadata.cover
      if (allCovers.length === 0 && originalCover) {
        allCovers = [originalCover];
      }
      
      // Обновляем данные с обложками
      chrome.storage.local.get(['titleData', 'originalTitleData'], (result) => {
        const titleData = result.titleData || {};
        const originalTitleData = result.originalTitleData || {};
        
        // Инициализируем структуру если нет
        if (!titleData[currentSlug]) {
          titleData[currentSlug] = { chapters: null, metadata: {} };
        }
        if (!originalTitleData[currentSlug]) {
          originalTitleData[currentSlug] = { chapters: null, metadata: {} };
        }
        
        // Сохраняем оригинальные обложки (всегда обновляем)
        originalTitleData[currentSlug].covers = allCovers.map(url => ({ url, type: 'url' }));
        
        // Сохраняем пользовательские обложки только если их нет (не перезаписываем правки)
        // Перезаписываем только если массив вообще не существует, а не если он пустой
        if (!titleData[currentSlug].covers) {
          titleData[currentSlug].covers = allCovers.map(url => ({ url, type: 'url' }));
        }

        // Обновляем timestamp кэша (чтобы устаревал через 10 минут)
        titleData[currentSlug].cacheTimestamp = Date.now();

        chrome.storage.local.set({ titleData, originalTitleData });
      });
    } else {
      allCovers = [originalCover];
    }
    
    // Обновляем прогресс сразу без анимации
    const loaderProgress = document.getElementById('loader-progress');
    if (loaderProgress) {
      loaderProgress.style.width = (globalStartProgress + 25) + '%';
    }
    
    // Шуточный этап (медленно и плавно - 800мс)
    const coverInspectionText = await getRandomCoverInspectionText();
    updateLoader(coverInspectionText, globalStartProgress + 25);
    await slowSmoothProgress(globalStartProgress + 50);
    
    // Готово (400мс - визуальный маркер)
    updateLoader('Готово!', globalStartProgress + 50);
    await readyProgress(100);
    // Ждем завершения CSS transition
    await new Promise(resolve => setTimeout(resolve, 400));

    // Сначала скрываем loader
    document.getElementById('loader').classList.add('hidden');
    
    // Потом показываем main-view
    document.getElementById('main-view').classList.remove('hidden');
    
    // Потом включаем кнопки
    enableEditorButtons(true);
    enableButton('btn-settings', true);
    document.querySelector('.btn-group').classList.remove('hidden');
  });
});

// Функция для открытия popup окна
async function openPopupWindow(url, withTargetTabId = false) {
  // Определяем тип окна по URL
  let windowType = '';
  if (url.includes('settings.html')) windowType = 'settings';
  else if (url.includes('prepare.html')) windowType = 'prepare';
  else if (url.includes('chapters.html')) windowType = 'chapters';
  else if (url.includes('metadata.html')) windowType = 'metadata';
  else if (url.includes('covers.html')) windowType = 'covers';

  // Проверяем, можно ли открыть окно
  if (!await canOpenWindow(windowType)) {
    return; // Нельзя открыть - уже показан toast
  }

  // Сначала проверяем, есть ли уже открытое окно с этим URL
  chrome.windows.getAll({ populate: true }, (windows) => {
    let existingWindow = null;

    for (const win of windows) {
      for (const tab of win.tabs) {
        if (tab.url && tab.url.includes(url)) {
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

// Кнопка открытия редактора глав
document.getElementById('btn-edit-chapters').addEventListener('click', async () => {
  const fromIdx = parseInt(document.getElementById('chapter-from').value);
  const toIdx = parseInt(document.getElementById('chapter-to').value);
  
  // Сохраняем главы в titleData
  const result = await chrome.storage.local.get(['titleData', 'currentSlug']);
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
  await chrome.storage.local.set({ titleData });
  
  openPopupWindow('html/chapters.html');
});

// Глобальные переменные данных тайтла
let currentSlug = '';
let originalCover = '';
let allCovers = []; // Все обложки из popup

// Кнопка редактора обложек
document.getElementById('btn-covers').addEventListener('click', () => {
  openPopupWindow('html/covers.html', true);
});

// Кнопка настроек метаданных
document.getElementById('btn-metadata').addEventListener('click', async () => {
  openPopupWindow('html/metadata.html', true);
});

// Кнопка скачивания
document.getElementById('btn-download').addEventListener('click', () => {
  const fromIdx = parseInt(document.getElementById('chapter-from').value);
  const toIdx = parseInt(document.getElementById('chapter-to').value);
  const quality = savedQuality; // Используем сохраненное качество из настроек
  
  const selectedChapters = allChapters.slice(fromIdx, toIdx + 1);

  // Получаем метаданные из storage
  chrome.storage.local.get(['titleData', 'originalTitleData', 'siteType'], (result) => {
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
  const result = await chrome.storage.local.get(['titleData', 'currentSlug']);
  const titleData = result.titleData || {};
  const currentSlug = result.currentSlug;

  if (titleData[currentSlug]) {
    titleData[currentSlug].fromIdx = fromIdx;
    titleData[currentSlug].toIdx = parseInt(toSelect.value);
    // Пересоздаём filteredChapters на основе текущего allChapters и нового диапазона
    if (titleData[currentSlug].chapters) {
      titleData[currentSlug].filteredChapters = titleData[currentSlug].chapters.slice(fromIdx, parseInt(toSelect.value) + 1);
    }
    await chrome.storage.local.set({ titleData });
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
  const result = await chrome.storage.local.get(['titleData', 'currentSlug']);
  const titleData = result.titleData || {};
  const currentSlug = result.currentSlug;

  if (titleData[currentSlug]) {
    titleData[currentSlug].fromIdx = parseInt(fromSelect.value);
    titleData[currentSlug].toIdx = toIdx;
    // Пересоздаём filteredChapters на основе текущего allChapters и нового диапазона
    if (titleData[currentSlug].chapters) {
      titleData[currentSlug].filteredChapters = titleData[currentSlug].chapters.slice(parseInt(fromSelect.value), toIdx + 1);
    }
    await chrome.storage.local.set({ titleData });
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
    // Перезагружаем страницу
    await chrome.tabs.reload(tab.id);
    // Ждем 2 секунды и пробуем снова загрузить данные
    setTimeout(async () => {
      const [reloadedTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (reloadedTab && reloadedTab.id) {
        const chaptersResult = await loadChapters(reloadedTab.id);
        if (chaptersResult) {
          currentSlug = chaptersResult.slug;
          chrome.storage.local.set({ currentSlug });
          processChapters(chaptersResult.chapters);
        }
        await loadMetadata(reloadedTab.id);
        await loadCovers(reloadedTab.id);
      }
    }, 2000);
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

document.getElementById('btn-settings').addEventListener('click', () => {
  const now = Date.now();
  
  // Удаляем клики старше 8 секунд
  settingsClicks = settingsClicks.filter(click => now - click < SETTINGS_CLICK_WINDOW);
  settingsClicks.push(now);
  
  // Если 10 кликов за 8 секунд - переключаем логирование
  if (settingsClicks.length >= SETTINGS_CLICK_THRESHOLD) {
    chrome.storage.session.get(['isLoggingEnabled'], (result) => {
      if (result.isLoggingEnabled) {
        chrome.runtime.sendMessage({ action: 'disableStorageLogging' });
        console.log('[LibSaver] Storage logging DISABLED by secret click sequence');
      } else {
        chrome.runtime.sendMessage({ action: 'enableStorageLogging' });
        console.log('[LibSaver] Storage logging ENABLED by secret click sequence');
      }
    });
    settingsClicks = []; // Сбрасываем
  }
  
  openPopupWindow('html/settings.html');
});

// Обработка сырых данных из API
function processChapters(chaptersList) {
  allChapters = [];

  if (!chaptersList || !Array.isArray(chaptersList)) {
    console.error('Invalid chaptersList:', chaptersList);
    return;
  }

  chaptersList.forEach(item => {
    // Нормализуем branches: если это объект, конвертируем в массив
    let branches = item.branches;
    if (branches && !Array.isArray(branches)) {
      branches = Object.values(branches);
    }
    
    const vol = item.volume || '1';
    const num = item.number || '1';
    const name = item.name || '';
    
    // Берем первую доступную ветку или команду
    let teamName = 'Основной перевод';
    let branchId = null;
    
    if (branches && branches.length > 0) {
      const firstBranch = branches[0];
      branchId = firstBranch.branch_id !== null ? String(firstBranch.branch_id) : null;
      
      teamName = getTranslatorName(firstBranch);
    } else if (item.team?.name) {
      teamName = item.team.name;
    }
    
    allChapters.push({
      id: item.id,
      volume: vol,
      number: num,
      name: name,
      branchId: branchId,
      branchTeamName: teamName,
      branches: branches, // Сохраняем нормализованные branches
      displayTitle: formatChapterTitle(vol, num, name, tocFormat, customTocFormat, hideChapterName, hideVolumeNumber)
    });
  });

  // Сортировка глав по возрастанию
  allChapters.sort((a, b) => {
    const vA = parseFloat(a.volume) || 0;
    const vB = parseFloat(b.volume) || 0;
    if (vA !== vB) return vA - vB;
    const nA = parseFloat(a.number) || 0;
    const nB = parseFloat(b.number) || 0;
    return nA - nB;
  });

  // Восстанавливаем сохраненные displayTitle из titleData
  chrome.storage.local.get(['titleData', 'currentSlug'], (result) => {
    if (result.titleData && result.currentSlug && result.titleData[result.currentSlug] && result.titleData[result.currentSlug].chapters) {
      const savedChapters = result.titleData[result.currentSlug].chapters;
      const savedMap = new Map(savedChapters.map(ch => [`${ch.id}_${ch.branchId || 'null'}`, ch]));

      allChapters.forEach(ch => {
        const key = `${ch.id}_${ch.branchId || 'null'}`;
        const saved = savedMap.get(key);
        if (saved && saved.displayTitle) {
          ch.displayTitle = saved.displayTitle;
        }
      });
    }
  });
}

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

function getTranslatorKey(branch) {
  const branchId = branch.branch_id === null ? 'null' : branch.branch_id;
  let teamId = 'unknown';
  if (branch.teams && branch.teams[0]) {
    teamId = branch.teams[0].id;
  } else if (branch.team) {
    teamId = branch.team.id;
  }
  return `${branchId}_${teamId}`;
}

function getTranslatorName(branch) {
  if (branch.teams && branch.teams[0]) {
    const teamName = branch.teams[0].name;
    // Если команда "Неизвестный", но есть пользователь, добавляем никнейм в скобках
    if (teamName === 'Неизвестный' && branch.user?.username) {
      return `${teamName} (${branch.user.username})`;
    }
    return teamName;
  } else if (branch.team) {
    const teamName = branch.team.name;
    if (teamName === 'Неизвестный' && branch.user?.username) {
      return `${teamName} (${branch.user.username})`;
    }
    return teamName;
  }
  return branch.user?.username || 'Основной перевод';
}

function getChapterVariants(chapterId) {
  const variants = new Map();
  allChapters.forEach(ch => {
    if (ch.id === chapterId && ch.branches && Array.isArray(ch.branches)) {
      ch.branches.forEach(branch => {
        const key = getTranslatorKey(branch);
        const name = getTranslatorName(branch);
        variants.set(key, name);
      });
    }
  });
  return variants;
}

function getUniqueChapters(chapters) {
  const uniqueChapterIds = new Set();
  const uniqueChapters = [];
  
  chapters.forEach(ch => {
    if (!uniqueChapterIds.has(ch.id)) {
      uniqueChapterIds.add(ch.id);
      uniqueChapters.push(ch);
    }
  });
  
  return uniqueChapters;
}

function applyTranslatorPriority() {
  if (translatorPriority.length === 0) {
    const translatorCounts = {};
    allChapters.forEach(ch => {
      if (ch.branches && Array.isArray(ch.branches)) {
        ch.branches.forEach(branch => {
          const key = getTranslatorKey(branch);
          if (!translatorCounts[key]) {
            translatorCounts[key] = 0;
          }
          translatorCounts[key]++;
        });
      }
    });
    
    translatorPriority = Object.keys(translatorCounts).sort((a, b) => translatorCounts[b] - translatorCounts[a]);
  }
  
  const uniqueChapters = getUniqueChapters(allChapters);
  
  uniqueChapters.forEach(ch => {
    const variants = getChapterVariants(ch.id);
    if (variants.size > 1) {
      for (const translatorKey of translatorPriority) {
        if (variants.has(translatorKey)) {
          chapterBranchOverrides[ch.id] = translatorKey;
          break;
        }
      }
    }
  });
  
  allChapters.forEach(ch => {
    if (chapterBranchOverrides[ch.id]) {
      const targetKey = chapterBranchOverrides[ch.id];
      if (ch.branches && Array.isArray(ch.branches)) {
        const targetBranch = ch.branches.find(branch => getTranslatorKey(branch) === targetKey);
        if (targetBranch) {
          if (targetBranch.teams && targetBranch.teams.length > 0) {
            ch.branchTeamName = targetBranch.teams.map(t => t.name).join(' & ');
          } else if (targetBranch.user?.username) {
            ch.branchTeamName = targetBranch.user.username;
          }
          ch.branchId = targetBranch.branch_id !== null ? String(targetBranch.branch_id) : null;
        }
      }
    }
  });
  
  chrome.storage.local.get(['titleData', 'currentSlug'], (result) => {
    const titleData = result.titleData || {};
    const currentSlug = result.currentSlug;
    if (!titleData[currentSlug]) {
      titleData[currentSlug] = { chapters: null, metadata: {} };
    }
    titleData[currentSlug].translatorPriority = translatorPriority;
    titleData[currentSlug].chapterBranchOverrides = chapterBranchOverrides;
    titleData[currentSlug].chapters = allChapters;
    chrome.storage.local.set({ titleData });
  });
}