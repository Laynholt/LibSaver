// Конфигурация и состояние
let options = {};
let chaptersToDownload = [];
let debugMode = false; // Флаг для детального логирования

// Функция форматирования заголовков глав
function formatChapterTitle(vol, num, name, tocFormat, customTocFormat, hideChapterName, hideVolumeNumber) {
  const volStr = vol || '1';
  const numStr = num || '1';
  const nameStr = name || '';

  if (tocFormat === 'custom') {
    if (customTocFormat) {
      // Обрабатываем секции в квадратных скобках
      let result = customTocFormat;

      // Сначала обрабатываем экранирование: \[ → [, \] → ]
      result = result.replace(/\\\[/g, '\x00').replace(/\\\]/g, '\x01');

      // Разбиваем на части: вне скобок и внутри скобок
      const parts = [];
      let lastIndex = 0;
      const sectionRegex = /\[([^\[\]]*)\]/g;
      let match;

      while ((match = sectionRegex.exec(result)) !== null) {
        // Добавляем текст до секции
        if (match.index > lastIndex) {
          parts.push({
            type: 'literal',
            content: result.slice(lastIndex, match.index)
          });
        }
        // Добавляем секцию
        parts.push({
          type: 'section',
          content: match[1]
        });
        lastIndex = match.index + match[0].length;
      }

      // Добавляем оставшийся текст после последней секции
      if (lastIndex < result.length) {
        parts.push({
          type: 'literal',
          content: result.slice(lastIndex)
        });
      }

      // Обрабатываем каждую часть
      const processedParts = [];
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part.type === 'literal') {
          // Заменяем плейсхолдеры в тексте вне скобок
          let processed = part.content
            .replace('{vol}', volStr)
            .replace('{num}', numStr)
            .replace('{name}', nameStr);
          processedParts.push({
            type: 'literal',
            content: processed
          });
        } else if (part.type === 'section') {
          // Заменяем плейсхолдеры внутри секции
          let processed = part.content
            .replace('{vol}', volStr)
            .replace('{num}', numStr)
            .replace('{name}', nameStr);

          // Если секция пустая - пропускаем её
          if (!processed || processed.trim() === '') {
            processedParts.push({
              type: 'section',
              content: '',
              isEmpty: true
            });
          } else {
            // Добавляем секцию без скобок
            processedParts.push({
              type: 'section',
              content: processed,
              isEmpty: false
            });
          }
        }
      }

      // Удаляем пустые секции с разделителями
      const finalParts = [];
      for (let i = 0; i < processedParts.length; i++) {
        const part = processedParts[i];

        if (part.type === 'section' && part.isEmpty) {
          // Пропускаем пустую секцию, но удаляем разделители вокруг
          // Удаляем trailing разделитель из предыдущего literal
          if (finalParts.length > 0 && finalParts[finalParts.length - 1].type === 'literal') {
            const prevLiteral = finalParts[finalParts.length - 1];
            // Если предыдущий literal состоит только из разделителей, цифр и пробелов - удаляем его полностью
            if (/^[\d\s\p{P}\p{S}]+$/u.test(prevLiteral.content)) {
              finalParts.pop();
            } else {
              // Иначе удаляем только последний разделитель
              prevLiteral.content = prevLiteral.content.replace(/[\d\s\p{P}\p{S}]$/u, '');
            }
          }
          // Удаляем leading разделитель из следующего literal
          if (i + 1 < processedParts.length && processedParts[i + 1].type === 'literal') {
            const nextLiteral = processedParts[i + 1];
            // Если следующий literal состоит только из разделителей, цифр и пробелов - удаляем его полностью
            if (/^[\d\s\p{P}\p{S}]+$/u.test(nextLiteral.content)) {
              // Пропускаем его (не добавим в finalParts)
            } else {
              // Иначе удаляем только первый разделитель
              nextLiteral.content = nextLiteral.content.replace(/^[\d\s\p{P}\p{S}]/u, '');
            }
          }
        } else {
          finalParts.push(part);
        }
      }

      // Собираем результат
      result = finalParts.map(p => p.content).join('');

      // Схлопываем дубликаты разделителей (Unicode-aware)
      result = result.replace(/([\p{P}\p{S}])\1+/gu, '$1');

      // Восстанавливаем экранированные скобки
      result = result.replace(/\x00/g, '[').replace(/\x01/g, ']');

      return result.trim();
    }
    // Fallback если custom формат пустой
    return `Том ${volStr}. Глава ${numStr}.${nameStr ? ' ' + nameStr : ''}`.trim();
  }

  // Встроенные форматы - учитываем галочки
  let title = '';

  switch (tocFormat) {
    case 'format1':
      title = `Том ${volStr} Глава ${numStr} ${nameStr}`;
      break;
    case 'format2':
      title = `Том ${volStr} Глава ${numStr} ${nameStr ? '- ' + nameStr : ''}`;
      break;
    case 'format3':
      title = `Том ${volStr} - Глава ${numStr} ${nameStr ? '- ' + nameStr : ''}`;
      break;
    case 'format4':
      // Кастомная логика для format4 (со слешами)
      title = `Том ${volStr} / Глава ${numStr} / ${nameStr}`;
      if (hideVolumeNumber) {
        title = `Глава ${numStr} / ${nameStr}`;
      }
      if (hideChapterName) {
        title = hideVolumeNumber ? `Глава ${numStr}` : `Том ${volStr} / Глава ${numStr}`;
      }
      return title.trim();
    case 'no_headers':
      // Без заголовков в контенте, но оставляем нормальный заголовок для UI/TOC
      title = `Том ${volStr}. Глава ${numStr}.${nameStr ? ' ' + nameStr : ''}`;
      break;
    case 'default':
    default:
      title = `Том ${volStr}. Глава ${numStr}.${nameStr ? ' ' + nameStr : ''}`;
      break;
  }

  // Применяем галочки для встроенных форматов
  if (hideVolumeNumber) {
    // Убираем всё до "Глава" включительно
    title = title.replace(/.*Глава\s*/, 'Глава ');
  }

  if (hideChapterName) {
    // Убираем всё после номера главы (включая дробные номера типа 0.1)
    title = title.replace(/(Глава\s+[\d.]+).*$/, '$1').trim();
  }

  return title.trim();
}

// Интервал обновления статистики
let statsUpdateInterval = null;
let totalBytesDownloaded = 0; // Общее количество скачанных байт

// Состояние обработки ошибок
let currentErrorChapter = null; // Текущая глава с ошибкой
let currentError = null; // Текущая ошибка
let skippedChapters = []; // Список пропущенных глав
let isWaitingForUser = false; // Ожидание решения пользователя
let shouldRetryChapter = false; // Флаг для повтора текущей главы

const logContainer = document.getElementById('log');
const logsPanel = document.getElementById('logs-panel');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const btnDownloadFile = document.getElementById('btn-download-file');

let savedBlob = null; // Сохраненный blob для повторной загрузки

// RateLimiter для контроля скорости запросов
let requestsInLastMinute = 0;
let maxRequestsPerMinute = 0;  // Устанавливается в calculateInitialSpeed
let requestTimestamps = [];
let pendingQueue = [];
let isProcessingQueue = false;
let isPaused = false;

// RateLimiter - окно 20 сек для синхронизации с лимитами
let TIME_WINDOW = 20000;  // 20 секунд
let REQUESTS_PER_WINDOW = 20;  // Синхронизация с лимитами

// Базовая скорость (меняется только адаптивной скоростью, джиттер работает от неё)
let baseSpeed = 0;  // Дефолтное значение 0, устанавливается в calculateInitialSpeed

// Адаптивная скорость (полностью автоматическая)
let lastErrorTime = 0;
let lastSpeedIncreaseTime = Date.now();
let lastSpeedResetTime = 0;  // Для сброса 90 → 80 через 8 сек
let wasSpeedModeActive = false;  // Флаг: был ли активен режим ускорения
const MIN_REQUESTS_PER_MINUTE = 30;
let MAX_REQUESTS_PER_MINUTE = 90;  // Максимум 90 везде
const SPEED_INCREASE_INTERVAL = 20000;  // Повышение каждые 20 сек
const SPEED_DECREASE_FACTOR = 0.67;  // В 1.5 раза вместо 4
const SPEED_INCREASE_FACTOR = 1.25;
const SPEED_RESET_DELAY = 8000;  // Сброс 90 → 80 через 8 сек
const SPEED_MODE_FIXED_SPEED = 80;  // Фиксированная скорость в режиме ускорения
const SPEED_RESET_TARGET = 80;  // Целевая скорость после сброса 90 → 80
const JITTER_RANGE = 5;  // Джиттер ±5 запросов/мин

// Для логирования переводчиков по главам
let chapterTranslators = [];

// Callback для логирования переводчиков
function onTranslatorSelected(chapter, selectedTranslatorName, selectedBranchId, downloadedTranslatorName, downloadedBranchId) {
    if (debugMode) {
        const volume = chapter.volume || '1';
        const number = chapter.number || '?';
        chapterTranslators.push({
            volume,
            number,
            selectedTranslator: selectedTranslatorName,
            selectedBranchId: selectedBranchId,
            downloadedTranslator: downloadedTranslatorName,
            downloadedBranchId: downloadedBranchId
        });
    }
}

async function trackRequest() {
    return new Promise((resolve) => {
        pendingQueue.push({ resolve });
        processQueue();
    });
}

async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (pendingQueue.length > 0) {
        if (isPaused) {
            requestsInLastMinute = 0;
            await new Promise(resolve => setTimeout(resolve, 100));
            continue;
        }

        const now = Date.now();

        // В режиме ускорения фиксируем скорость на 80 (ПЕРЕД джиттером)
        if (window.getSpeedMode && window.getSpeedMode()) {
            if (maxRequestsPerMinute !== SPEED_MODE_FIXED_SPEED) {
                maxRequestsPerMinute = SPEED_MODE_FIXED_SPEED;
                baseSpeed = SPEED_MODE_FIXED_SPEED;
                wasSpeedModeActive = true;  // Помечаем что был активен режим ускорения
            }
        } else {
            // Если режим ускорения был включён, но сейчас выключен - пересчитываем начальную скорость
            if (wasSpeedModeActive) {
                const chapterCount = chaptersToDownload.length;
                if (chapterCount >= 50) {
                    baseSpeed = 60;
                } else {
                    baseSpeed = 75;
                }
                maxRequestsPerMinute = baseSpeed;
                wasSpeedModeActive = false;  // Сбрасываем флаг
            }

            // Автоматическое повышение скорости (только не в режиме ускорения)
            if (now - lastSpeedIncreaseTime > SPEED_INCREASE_INTERVAL &&
                now - lastErrorTime > SPEED_INCREASE_INTERVAL &&
                baseSpeed < MAX_REQUESTS_PER_MINUTE) {
                const newSpeed = Math.min(
                    Math.floor(baseSpeed * SPEED_INCREASE_FACTOR),
                    MAX_REQUESTS_PER_MINUTE
                );
                if (newSpeed > baseSpeed) {
                    baseSpeed = newSpeed;
                    lastSpeedIncreaseTime = now;
                    lastSpeedResetTime = now;  // Запоминаем когда достигли максимума
                }
            }

            // Автоматический сброс 90 → 80 через 8 сек
            if (baseSpeed >= MAX_REQUESTS_PER_MINUTE &&
                now - lastSpeedResetTime > SPEED_RESET_DELAY) {
                baseSpeed = SPEED_RESET_TARGET;
                lastSpeedResetTime = now;
                maxRequestsPerMinute = baseSpeed;  // Синхронизируем
            }

            // Применяем джиттер ПОСЛЕ всех изменений baseSpeed (только не в режиме ускорения)
            addSpeedJitter();
        }

        // RateLimiter ожидание (отключается в режиме ускорения)
        const speedModeEnabled = window.getSpeedMode ? window.getSpeedMode() : false;
        while (!speedModeEnabled && requestsInLastMinute >= maxRequestsPerMinute) {
            const oldestTimestamp = requestTimestamps[0];
            const waitTime = oldestTimestamp ? Math.max(0, oldestTimestamp + TIME_WINDOW - Date.now()) : 1000;
            if (waitTime > 5000) {
                addLog(`Rate limit: ожидание (${Math.round(waitTime/1000)}s, ${requestsInLastMinute}/${maxRequestsPerMinute} запросов/мин)`);
            }
            await new Promise(resolve => setTimeout(resolve, Math.min(waitTime, 1000)));
        }

        const request = pendingQueue.shift();
        if (!request) continue;

        requestsInLastMinute += 1;
        const timestamp = Date.now();
        requestTimestamps.push(timestamp);
        request.resolve();

        setTimeout(() => {
            requestsInLastMinute -= 1;
            requestTimestamps.shift();
        }, TIME_WINDOW);
    }

    isProcessingQueue = false;
}

function handleRateLimitError() {
    const now = Date.now();
    lastErrorTime = now;

    // Минимум не может быть ниже начальной скорости (60 или 75)
    const minAllowedSpeed = 60;  // Минимум для всех тайтлов

    const newSpeed = Math.max(
        Math.floor(baseSpeed * SPEED_DECREASE_FACTOR),
        minAllowedSpeed
    );

    if (newSpeed < baseSpeed) {
        baseSpeed = newSpeed;
        maxRequestsPerMinute = baseSpeed;  // Синхронизируем
    }

    lastSpeedIncreaseTime = now;
    lastSpeedResetTime = now;  // Сбрасываем таймер сброса
}

function calculateInitialSpeed(chapterCount) {
    // Устанавливаем начальную скорость
    // Максимум везде 90 запросов/мин
    MAX_REQUESTS_PER_MINUTE = 90;

    // TIME_WINDOW фиксирован на 60 сек для синхронизации с лимитами

    if (chapterCount >= 50) {
        baseSpeed = 60;  // Начальная скорость для больших тайтлов (>= 50 глав)
    } else {
        baseSpeed = 75;  // Начальная скорость для малых тайтлов (< 50 глав)
    }

    maxRequestsPerMinute = baseSpeed;  // Синхронизируем

    // Сбрасываем таймеры повышения/сброса скорости
    lastSpeedIncreaseTime = Date.now();
    lastSpeedResetTime = Date.now();

    return maxRequestsPerMinute;
}

function calculateMaxSpeed(chapterCount) {
    // Максимальная скорость всегда 90
    // Эта функция оставлена для совместимости
    return 90;
}

function addSpeedJitter() {
    // В режиме ускорения джиттер отключен
    if (window.getSpeedMode && window.getSpeedMode()) return;

    // Джиттер работает от baseSpeed, а не от текущего значения
    const jitter = Math.floor(Math.random() * (JITTER_RANGE * 2 + 1)) - JITTER_RANGE;  // -5 до +5
    const newSpeed = Math.max(
        baseSpeed,  // Не ниже базовой скорости
        Math.min(MAX_REQUESTS_PER_MINUTE, baseSpeed + jitter)
    );

    if (newSpeed !== maxRequestsPerMinute) {
        maxRequestsPerMinute = newSpeed;
    }
}

function addLog(message, isError = false, color = null) {
    // Используем функцию из prepare.js
    if (window.addLogToContainer) {
        window.addLogToContainer(`[${new Date().toLocaleTimeString()}] ${message}`, isError, color);
    }
}

function updateProgress(current, total) {
    const percent = (current / total) * 100;
    progressBar.style.width = percent + '%';
    progressText.textContent = `${current} / ${total} глав`;
}

async function checkPause() {
    while (isPaused) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

async function fetchWithRetry(url, options = {}, maxRetries = 5) {
  const delays = [3000, 5000, 8000];  // 3с, 5с, 8с вместо 5с, 10с, 15с
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      if (attempt === 0 && !response.ok) {
        addLog(`HTTP Status: ${response.status} (${response.statusText})`, true);
      }

      if (response.ok) {
        const contentLength = response.headers.get('content-length');
        if (contentLength) {
          totalBytesDownloaded += parseInt(contentLength, 10);
        }
        return response;
      }

      if (response.status === 429) {
        handleRateLimitError();

        if (attempt < maxRetries) {
          const delay = delays[Math.min(attempt, delays.length - 1)];
          addLog(`Rate limited (429), waiting ${delay/1000}s before retry ${attempt + 1}/${maxRetries + 1}`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        } else {
          throw new Error('Rate limited after 5 retry attempts (3s, 5s, 8s)');
        }
      }

      if (response.status >= 500) {
        handleRateLimitError();
        addLog(`Server error (${response.status}), adaptive speed reduced`, true);
      } else if (response.status !== 408) {
        // 404/403 и прочие 4xx повтор не исправит — не ждём зря
        throw Object.assign(new Error(`HTTP ${response.status}: ${response.statusText}`), { noRetry: true });
      }

      if (attempt < maxRetries) {
        const delay = delays[Math.min(attempt, delays.length - 1)];
        addLog(`Request failed (${response.status}), retrying in ${delay/1000}s (attempt ${attempt + 1}/${maxRetries + 1})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } catch (error) {
      if (error.noRetry) throw error;
      lastError = error;
      if (attempt < maxRetries) {
        const delay = delays[Math.min(attempt, delays.length - 1)];
        addLog(`Network error (${error.message}), retrying in ${delay/1000}s (attempt ${attempt + 1}/${maxRetries + 1})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError || new Error('Max retries exceeded');
}

// Функция для очистки состояния перед новой загрузкой
function resetDownloadState() {
    // Очищаем статистику через statistics.js
    window.resetStatistics();
    totalBytesDownloaded = 0;
    
    // Очищаем RateLimiter
    requestsInLastMinute = 0;
    pendingQueue = [];
    isProcessingQueue = false;
    isPaused = false;
    requestTimestamps = [];
    
    // Сбрасываем адаптивную скорость
    lastErrorTime = 0;
    lastSpeedIncreaseTime = Date.now();
    chaptersSinceLastPause = 0;
    nextPauseAfterChapters = 0;
    imagesSinceLastPause = 0;
    
    currentErrorChapter = null;
    currentErrorImage = null;
    currentError = null;
    isWaitingForUser = false;
    shouldRetryChapter = false;
    shouldRetryImage = false;
    skippedChapters = [];
    userDecisionResolve = null;

    // Очищаем сохраненный blob
    savedBlob = null;
    
    // Останавливаем интервал обновления статистики если он был
    if (statsUpdateInterval) {
        clearInterval(statsUpdateInterval);
        statsUpdateInterval = null;
    }
    
    // Сбрасываем UI
    if (progressBar) progressBar.style.width = '0%';
    if (progressText) progressText.textContent = '0 / 0 глав';
    if (btnDownloadFile) btnDownloadFile.style.display = 'none';
    if (btnPauseElement) {
        btnPauseElement.style.display = '';
        btnPauseElement.innerHTML = '<i class="fa-solid fa-pause"></i>';
        btnPauseElement.title = 'Пауза';
    }

    // Очищаем лог
    if (logContainer) logContainer.innerHTML = '';
}

// Функция для запуска загрузки (вызывается из prepare.js)
async function startDownload() {
    try {
        resetDownloadState();
        const result = await chrome.storage.local.get(['downloadData', 'rateLimit', 'metadataFieldOrder', 'fieldLabels', 'debugLogging', 'disableToc', 'currentSlug', 'speedMode', 'txtImageMarker', 'pdfFont', 'pdfFontSize', 'pdfPageSize', 'pdfLineSpacing', 'pdfParagraphSpacing', 'tocFormat', 'customTocFormat', 'hideChapterName', 'hideVolumeNumber', 'generateComicInfo']);
        // Устанавливаем режим детального логирования из настроек
        debugMode = result.debugLogging || false;

        // Очищаем массив переводчиков перед началом загрузки
        chapterTranslators = [];

        // Сбрасываем статистику перед началом загрузки
        if (window.resetStatistics) {
            window.resetStatistics();
        }

        // Устанавливаем режим ускорения
        if (window.setSpeedMode) {
            window.setSpeedMode(result.speedMode || false);
        }
        
        if (!result.downloadData) {
            throw new Error('Данные для загрузки не найдены');
        }
        options = result.downloadData;
        chaptersToDownload = options.chapters;
        
        // Сохраняем настройку отключения оглавления (всегда берем из storage для актуального значения)
        disableToc = result.disableToc !== undefined ? result.disableToc : false;
        options.disableToc = disableToc;
        options.epubTocPage = !disableToc; // Когда оглавление включено, создаем отдельную страницу

        // Сохраняем переименованные названия полей
        options.fieldLabels = result.fieldLabels || {};
        
        // Сохраняем порядок полей
        options.metadataFieldOrder = result.metadataFieldOrder || null;
        
        // Добавляем настройки выбора перевода из titleData
        const currentSlug = options.slug;
        const { titleData } = await getTitleStore(['titleData'], currentSlug);
        if (titleData[currentSlug]) {
            options.chapterBranchOverrides = titleData[currentSlug].chapterBranchOverrides || {};
            options.translatorPriority = titleData[currentSlug].translatorPriority || [];
        } else {
            options.chapterBranchOverrides = {};
            options.translatorPriority = [];
        }

        // Добавляем настройки из storage
        options.settings = {
            txtImageMarker: result.txtImageMarker || 'numbered',
            pdfFont: result.pdfFont || 'dejavu-sans',
            pdfFontSize: result.pdfFontSize || 12,
            pdfPageSize: result.pdfPageSize || 'A5',
            pdfLineSpacing: result.pdfLineSpacing !== undefined ? result.pdfLineSpacing : 2,
            // Настройки заголовков
            tocFormat: result.tocFormat || 'default',
            customTocFormat: result.customTocFormat || '',
            hideChapterName: result.hideChapterName || false,
            hideVolumeNumber: result.hideVolumeNumber || false,
            pdfParagraphSpacing: result.pdfParagraphSpacing !== undefined ? result.pdfParagraphSpacing : 1
        };

        // Полностью автоматическая адаптивная скорость - не используем пользовательскую настройку
        const chapterCount = chaptersToDownload.length;
        maxRequestsPerMinute = calculateInitialSpeed(chapterCount);
        // MAX_REQUESTS_PER_MINUTE уже устанавливается в calculateInitialSpeed
        
        // Инициализируем статистику через statistics.js
        window.setDownloadStartTime();
        totalBytesDownloaded = 0;
        
        // Сбрасываем счётчики пауз
        if (window.resetPauseCounters) {
            window.resetPauseCounters();
        }

        // Запускаем интервал обновления статистики (каждую секунду)
        statsUpdateInterval = setInterval(updateStatisticsDisplay, 1000);
        
        updateStatisticsDisplay();
        
        // Сохраняем tabId для использования в background script
        if (options.tabId) {
          // Передаем tabId в background script через storage
          chrome.storage.local.set({ targetTabId: options.tabId });
        }
        
        // Определяем название для отображения
        const displayTitle = options.metadata?.titleRu || options.originalMetadata?.titleRu || options.originalMetadata?.titleEn || options.originalMetadata?.titleOriginal || 'Без названия';
        
        // Отображаем формат
        const selectedFormat = options.selectedFormat || 'epub';
        
        // Фильтруем главы по выбранным ID
        if (options.selectedChapterIds && Array.isArray(options.selectedChapterIds)) {
          chaptersToDownload = chaptersToDownload.filter(ch => options.selectedChapterIds.includes(ch.id));
        }
        
        // Помечаем все отфильтрованные главы как выбранные для форматтеров
        if (chaptersToDownload.length === 0) throw new Error('Выберите хотя бы одну главу');
        chaptersToDownload.forEach(ch => ch.selected = true);

        // Переформатируем заголовки глав согласно настройкам перед скачиванием
        const tocFormat = options.settings.tocFormat || 'default';
        const customTocFormat = options.settings.customTocFormat || '';
        const hideChapterName = options.settings.hideChapterName || false;
        const hideVolumeNumber = options.settings.hideVolumeNumber || false;

        chaptersToDownload.forEach(ch => {
            ch.displayTitle = formatChapterTitle(ch.volume, ch.number, ch.name, tocFormat, customTocFormat, hideChapterName, hideVolumeNumber);
        });

        // Обновляем progressText с правильным количеством глав
        if (progressText) progressText.textContent = `0 / ${chaptersToDownload.length} глав`;

        // Используем фабрику форматтеров для генерации файла
        const formatterOptions = {
            ...options,
            format: options.selectedFormat,
            // Передаем функции для RateLimiter и статистики
            trackRequest: trackRequest,
            addLog: addLog,
            updateProgress: updateProgress,
            incrementErrorCount: window.incrementErrorCount,
            incrementSkippedImagesCount: window.incrementSkippedImagesCount,
            addFileSize: window.addFileSize,
            updateChapterIndex: window.updateChapterIndex,
            recordChapterTime: window.recordChapterTime,
            debug: debugMode, // Передаем флаг debug
            totalChapters: chaptersToDownload.length,
            speedMode: window.getSpeedMode ? window.getSpeedMode() : false, // Передаем флаг режима ускорения
            // Передаем настройки сжатия изображений
            resizeMethod: options.resizeMethod || 'MIN_SIDE',
            adaptiveRatio: options.adaptiveRatio || 3,
            jpegQuality: options.jpegQuality || 1.0,
            imageFormat: options.imageFormat || 'original',
            pdfImageFormat: options.pdfImageFormat || 'original-png',
            pdfJpegQuality: options.pdfJpegQuality || 1.0,
            // Передаем настройки TXT
            txtImageMarker: options.settings.txtImageMarker || 'numbered',
            // Передаем настройки заголовков
            tocFormat: options.settings.tocFormat || 'default',
            customTocFormat: options.settings.customTocFormat || '',
            hideChapterName: options.settings.hideChapterName || false,
            hideVolumeNumber: options.settings.hideVolumeNumber || false,
            // Передаем настройку генерации ComicInfo.xml
            generateComicInfo: result.generateComicInfo !== false,
            // Передаем siteType для определения типа контента
            siteType: options.siteType,
            // Передаем параметры для manga
            tabId: options.tabId,
            slug: options.slug,
            imageServer: options.imageServer || 'normal',
            loadChapterPages: options.loadChapterPages,
            siteType: options.siteType,
            // Передаем обработчик ошибок глав
            onChapterError: handleChapterError,
            // Передаем обработчик ошибок картинок (для манги)
            onImageError: handleImageError,
            // Передаем функцию для регистрации глав старого формата
            addOldFormatChapter: window.addOldFormatChapter,
            // Передаем оригинальные метаданные из API для fallback в названиях файлов
            originalMetadata: options.originalMetadata,
            // Передаем режим отладки для детальной статистики
            debug: debugMode,
            // Передаем callback для логирования переводчиков
            onTranslatorSelected: onTranslatorSelected
        };
        
        const formatter = getFormatter(selectedFormat, formatterOptions);
        const { blob, filename } = await formatter.format(chaptersToDownload, options.metadata);

        // Устанавливаем точный размер файла после финализации
        setExactFileSize(blob.size);
        updateStatisticsDisplay();
        
        // Сохраняем blob для повторной загрузки
        savedBlob = { content: blob, fileName: filename };
        
        saveAs(blob, filename);

        // Устанавливаем 100% после завершения
        progressBar.style.width = '100%';
        const skippedImages = window.getStatisticsValue?.('skippedImagesCount') || 0;
        const skippedCount = Math.max(skippedChapters.length, window.getStatisticsValue?.('skippedChaptersCount') || 0);
        const downloadedCount = chaptersToDownload.length - skippedCount;
        progressText.textContent = skippedCount || skippedImages
            ? `Готово с пропусками: ${downloadedCount} / ${chaptersToDownload.length} глав; пропущено картинок: ${skippedImages}`
            : `Загрузка завершена: ${downloadedCount} / ${chaptersToDownload.length} глав`;
        addLog(progressText.textContent);


        // Логируем переводчики по главам если включен debugMode
        if (debugMode && chapterTranslators.length > 0) {
            addLog(`=== ИСПОЛЬЗОВАННЫЕ ПЕРЕВОДЧИКИ ===`);
            for (const item of chapterTranslators) {
                const selectedBranchStr = item.selectedBranchId !== null ? ` (branch_id: ${item.selectedBranchId})` : ' (branch_id: null)';
                const downloadedBranchStr = item.downloadedBranchId !== null ? ` (branch_id: ${item.downloadedBranchId})` : ' (branch_id: null)';
                addLog(`Выбрано: Том ${item.volume}. Глава ${item.number}. - ${item.selectedTranslator}${selectedBranchStr}`);
                addLog(`Скачано: Том ${item.volume}. Глава ${item.number}. - ${item.downloadedTranslator}${downloadedBranchStr}`);
            }
            addLog('====================================');
        }

        // Логируем пропущенные главы
        if (skippedChapters.length > 0) {
            addLog("Пропущенные главы:");
            for (const chapter of skippedChapters) {
                if (!chapter) continue;
                const volume = chapter.volume || '1';
                const number = chapter.number || '?';
                const title = chapter.displayTitle || chapter.title || '';
                addLog(`Том ${volume}. Глава ${number}. ${title}`);
            }
        }
        
        // Показываем кнопку Скачать файл
        if (btnDownloadFile) {
          btnDownloadFile.style.display = 'flex';
        }

    } catch (err) {
        addLog(`Критическая ошибка: ${err.message}`, true);
        console.error(err);
        if (progressText) progressText.textContent = `Ошибка: ${err.message}`;
        window.restoreDownloadControls?.();
    } finally {
        if (statsUpdateInterval) {
            clearInterval(statsUpdateInterval);
            statsUpdateInterval = null;
        }
        window.stopStatisticsUpdate?.();
        for (const button of [btnPauseElement, btnRetryElement, btnSkipElement]) {
            if (button) button.style.display = 'none';
        }
    }
}

// Обработчик кнопки Пауза/Возобновить
const btnPauseElement = document.getElementById('btn-pause');
const btnRetryElement = document.getElementById('btn-retry');
const btnSkipElement = document.getElementById('btn-skip');

if (btnPauseElement) {
    btnPauseElement.addEventListener('click', () => {
        isPaused = !isPaused;
        if (isPaused) {
            btnPauseElement.innerHTML = '<i class="fa-solid fa-play"></i>';
            btnPauseElement.title = 'Возобновить';
        } else {
            btnPauseElement.innerHTML = '<i class="fa-solid fa-pause"></i>';
            btnPauseElement.title = 'Пауза';
        }
    });
}

// Обработчик кнопки Повторить главу
if (btnRetryElement) {
    btnRetryElement.addEventListener('click', () => {
        if (isWaitingForUser) {
            if (currentErrorChapter) {
                // Ошибка главы
                shouldRetryChapter = true;
                addLog(`Повторная попытка загрузки главы: ${currentErrorChapter.displayTitle}`);
            } else if (currentErrorImage) {
                // Ошибка картинки
                shouldRetryImage = true;
                addLog(`Повторная попытка загрузки изображения`);
            }
            userDecisionMade();
        }
    });
}

// Обработчик кнопки Пропустить главу
if (btnSkipElement) {
    btnSkipElement.addEventListener('click', () => {
        if (isWaitingForUser) {
            if (currentErrorChapter) {
                // Ошибка главы
                shouldRetryChapter = false;
                skippedChapters.push(currentErrorChapter);
                if (window.incrementSkippedChaptersCount) {
                    window.incrementSkippedChaptersCount();
                }
                addLog(`Пропущена глава: ${currentErrorChapter.displayTitle}`);
            } else if (currentErrorImage) {
                // Ошибка картинки
                shouldRetryImage = false;
                if (window.incrementSkippedImagesCount) {
                    window.incrementSkippedImagesCount();
                }
                addLog(`Пропущено изображение`);
            }
            userDecisionMade();
        }
    });
}

// Обработчик кнопки Скачать файл (повторная загрузка)
if (btnDownloadFile) {
    btnDownloadFile.addEventListener('click', () => {
        if (savedBlob) {
            saveAs(savedBlob.content, savedBlob.fileName);
        }
    });
}

// Функции для статистики
function incrementErrorCount() {
    totalErrorCount++;
}

function incrementSkippedImagesCount() {
    skippedImagesCount++;
}

function setExactFileSize(size) {
    totalFileSize = size;
}

function updateStatisticsDisplay() {
    const statsTime = document.getElementById('stats-time');
    const statsEstimatedTime = document.getElementById('stats-estimated-time');
    const statsFileSize = document.getElementById('stats-file-size');
    const statsErrors = document.getElementById('stats-errors');
    const statsSkippedChapters = document.getElementById('stats-skipped-chapters');
    const statsSkippedImages = document.getElementById('stats-skipped-images');
    const statsRequestsPerMinute = document.getElementById('stats-requests-per-minute');
    const statsOldFormatChapters = document.getElementById('stats-old-format-chapters');
    const statsTotalChapters = document.getElementById('stats-total-chapters');
    const statsTotalCovers = document.getElementById('stats-total-covers');
    const statsTotalImages = document.getElementById('stats-total-images');

    if (!statsTime || !statsEstimatedTime || !statsFileSize || !statsErrors || !statsOldFormatChapters || !statsSkippedChapters || !statsSkippedImages || !statsTotalChapters || !statsTotalCovers || !statsTotalImages || !statsRequestsPerMinute) return;

    // Получаем значения из statistics.js
    const downloadStartTime = window.getStatisticsValue('downloadStartTime');
    const totalFileSize = window.getStatisticsValue('totalFileSize');
    const totalErrorCount = window.getStatisticsValue('totalErrorCount');
    const oldFormatChaptersCount = window.getStatisticsValue('oldFormatChaptersCount');
    const skippedChaptersCount = window.getStatisticsValue('skippedChaptersCount');
    const skippedImagesCount = window.getStatisticsValue('skippedImagesCount');
    const totalChapters = window.getStatisticsValue('totalChapters');
    const totalCovers = window.getStatisticsValue('totalCovers');
    const totalImages = window.getStatisticsValue('totalImages');
    const chapterTimes = window.getStatisticsValue('chapterTimes');
    const currentChapterIndex = window.getStatisticsValue('currentChapterIndex');

    // Время загрузки
    if (downloadStartTime) {
        const elapsedSeconds = (Date.now() - downloadStartTime) / 1000;
        statsTime.textContent = formatTime(elapsedSeconds);
    }

    // Примерное время
    statsEstimatedTime.textContent = calculateEstimatedTime();

    // Размер файла
    statsFileSize.textContent = formatFileSize(totalFileSize);

    // Ошибки
    statsErrors.textContent = totalErrorCount;

    // Главы старого формата (скрываем для манги)
    const siteType = options.siteType || 'ranobe';
    const isManga = siteType === 'mangalib' || siteType === 'hentailib' || siteType === 'shlib';
    if (isManga) {
      statsOldFormatChapters.textContent = '-';
    } else {
      statsOldFormatChapters.textContent = oldFormatChaptersCount;
    }

    // Всего глав
    statsTotalChapters.textContent = totalChapters;

    // Всего обложек
    statsTotalCovers.textContent = totalCovers;

    // Всего картинок
    statsTotalImages.textContent = totalImages;

    // Пропущено глав
    statsSkippedChapters.textContent = skippedChaptersCount;

    // Пропущено картинок
    statsSkippedImages.textContent = skippedImagesCount;

    // Запросов в минуту (фактическая скорость с лимитом в скобках)
    const actualRpm = Math.max(0, requestsInLastMinute);
    statsRequestsPerMinute.textContent = `${actualRpm} (${maxRequestsPerMinute})`;
    
    // Обновляем поле "Запросов в минуту" в prepare.js через storage
    chrome.storage.local.set({
        currentRequestsPerMinute: actualRpm.toFixed(0),
        maxRequestsPerMinute: maxRequestsPerMinute
    });
}

function formatTime(seconds) {
    if (seconds < 60) {
        return `${seconds.toFixed(0)} сек`;
    } else if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes} мин ${secs} сек`;
    } else {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${hours} ч ${minutes} мин`;
    }
}

// Функция для форматирования размера файла
function formatFileSize(bytes) {
    if (bytes < 1024) {
        return `${bytes} B`;
    } else if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(2)} KB`;
    } else if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    } else {
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
}

// Функция для расчёта медианы массива
function calculateMedian(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Функция для расчёта примерного времени на основе адаптивных данных
function calculateEstimatedTime() {
    const chapterTimes = window.getStatisticsValue('chapterTimes');
    const currentChapterIndex = window.getStatisticsValue('currentChapterIndex');
    
    if (!chapterTimes || chapterTimes.length === 0) {
        return 'Вычисляется...';
    }

    const remainingChapters = chaptersToDownload.length - currentChapterIndex;

    // Если все главы загружены, показываем 0
    if (remainingChapters <= 0) {
        return '0 сек';
    }

    // Определяем тип контента по siteType
    const siteType = options.siteType || 'ranobe';

    // Медиана из 3 глав везде
    const sampleSize = 3;

    // Лимит по типу сайта
    let maxTimePerChapter;
    if (siteType === 'ranobelib') {
        maxTimePerChapter = 4;  // RanobeLIB
    } else if (siteType === 'mangalib' || siteType === 'hentailib' || siteType === 'shlib') {
        maxTimePerChapter = 8;  // MangaLIB, HentaiLIB, SlashLIB
    } else {
        maxTimePerChapter = 4;  // Дефолт
    }

    const recentChapterTimes = chapterTimes.slice(-sampleSize);
    const medianTime = calculateMedian(recentChapterTimes);

    // Ограничиваем максимум и защищаем от NaN
    const avgTimePerChapter = Math.min(medianTime || 0, maxTimePerChapter);
    const estimatedSeconds = (avgTimePerChapter || 0) * remainingChapters;

    // Защита от NaN
    if (isNaN(estimatedSeconds) || !isFinite(estimatedSeconds)) {
        return 'Вычисляется...';
    }

    return formatTime(estimatedSeconds);
}

// Обработчик ошибок глав
async function handleChapterError(chapter, error, chapterIndex) {
    currentErrorImage = null;
    currentErrorChapter = chapter;
    currentError = error;
    isWaitingForUser = true;
    shouldRetryChapter = false;

    const volume = chapter.volume || '1';
    const number = chapter.number || '?';
    const title = chapter.displayTitle || chapter.title || '';

    addLog(`ОШИБКА при загрузке главы: Том ${volume}. Глава ${number}. ${title}`, true);
    addLog(`Ошибка: ${error.message}`, true);

    // Приостанавливаем загрузку
    isPaused = true;
    if (btnPauseElement) {
        btnPauseElement.innerHTML = '<i class="fa-solid fa-play"></i>';
        btnPauseElement.title = 'Возобновить';
    }

    // Показываем кнопки retry и skip на toolbar
    if (btnRetryElement) btnRetryElement.style.display = '';
    if (btnSkipElement) btnSkipElement.style.display = '';

    // Ждём решения пользователя
    await waitForUserDecision();

    // Скрываем кнопки retry и skip
    if (btnRetryElement) btnRetryElement.style.display = 'none';
    if (btnSkipElement) btnSkipElement.style.display = 'none';

    // Возобновляем загрузку
    isPaused = false;
    if (btnPauseElement) {
        btnPauseElement.innerHTML = '<i class="fa-solid fa-pause"></i>';
        btnPauseElement.title = 'Пауза';
    }

    isWaitingForUser = false;

    currentErrorChapter = null;
    currentError = null;
    return {
        shouldRetry: shouldRetryChapter,
        shouldSkip: !shouldRetryChapter
    };
}

// Обработчик ошибок картинок (для манги)
let currentErrorImage = null;
let shouldRetryImage = false;

async function handleImageError(chapter, error, chapterIndex, imageUrl) {
    currentErrorChapter = null;
    currentError = null;
    currentErrorImage = { chapter, error, imageUrl };
    isWaitingForUser = true;
    shouldRetryImage = false;

    const volume = chapter.volume || '1';
    const number = chapter.number || '?';
    const title = chapter.displayTitle || chapter.title || '';

    addLog(`ОШИБКА при загрузке изображения: Том ${volume}. Глава ${number}. ${title}`, true);
    addLog(`Ошибка: ${error.message}`, true);
    addLog(`URL изображения: ${imageUrl}`, true);

    // Приостанавливаем загрузку
    isPaused = true;
    if (btnPauseElement) {
        btnPauseElement.innerHTML = '<i class="fa-solid fa-play"></i>';
        btnPauseElement.title = 'Возобновить';
    }

    // Показываем кнопки retry и skip на toolbar
    if (btnRetryElement) btnRetryElement.style.display = '';
    if (btnSkipElement) btnSkipElement.style.display = '';

    // Ждём решения пользователя
    await waitForUserDecision();

    // Скрываем кнопки retry и skip
    if (btnRetryElement) btnRetryElement.style.display = 'none';
    if (btnSkipElement) btnSkipElement.style.display = 'none';

    // Возобновляем загрузку
    isPaused = false;
    if (btnPauseElement) {
        btnPauseElement.innerHTML = '<i class="fa-solid fa-pause"></i>';
        btnPauseElement.title = 'Пауза';
    }

    isWaitingForUser = false;

    currentErrorImage = null;
    return {
        shouldRetry: shouldRetryImage,
        shouldSkip: !shouldRetryImage
    };
}

let userDecisionResolve = null;

function waitForUserDecision() {
    return new Promise(resolve => {
        userDecisionResolve = resolve;
    });
}

function userDecisionMade() {
    if (userDecisionResolve) {
        userDecisionResolve();
        userDecisionResolve = null;
    }
}
