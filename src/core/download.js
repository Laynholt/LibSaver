// Конфигурация и состояние
let options = {};
let chaptersToDownload = [];
let debugMode = false; // Флаг для детального логирования

// Интервал обновления статистики
let statsUpdateInterval = null;
let totalBytesDownloaded = 0; // Скачано байт: тексты глав и картинки (addDownloadedBytes) - для скорости
let speedSamples = [];

// Состояние обработки ошибок
let currentErrorChapter = null; // Текущая глава с ошибкой
let skippedChapters = []; // Список пропущенных глав
let isWaitingForUser = false; // Ожидание решения пользователя
let shouldRetryChapter = false; // Флаг для повтора текущей главы
let cancelRequested = false; // Отмена: следующий запрос или решение пользователя бросает ошибку

function throwIfCanceled() {
    if (cancelRequested) throw Object.assign(new Error('Загрузка отменена'), { canceled: true });
}

// Ход загрузки сообщается событиями: log, progress, stats, decision, decisionDone, paused
let downloadListener = null;
function setDownloadListener(fn) {
    downloadListener = fn;
}
function emit(event) {
    if (downloadListener) downloadListener(event);
}

function setPaused(paused) {
    isPaused = paused;
    emit({ type: 'paused', paused });
}

// RateLimiter для контроля скорости запросов
let requestsInLastMinute = 0;
let maxRequestsPerMinute = 0;  // Устанавливается в calculateInitialSpeed
let requestTimestamps = [];
let pendingQueue = [];
let isProcessingQueue = false;
let isPaused = false;

// RateLimiter - окно 20 сек для синхронизации с лимитами
let TIME_WINDOW = 20000;  // 20 секунд

// Базовая скорость (меняется только адаптивной скоростью, джиттер работает от неё)
let baseSpeed = 0;  // Дефолтное значение 0, устанавливается в calculateInitialSpeed

// Адаптивная скорость (полностью автоматическая)
let lastErrorTime = 0;
let lastSpeedIncreaseTime = Date.now();
let lastSpeedResetTime = 0;  // Для сброса 90 → 80 через 8 сек
let wasSpeedModeActive = false;  // Флаг: был ли активен режим ускорения
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
    throwIfCanceled();
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

// Картинки: RateLimiter и случайная пауза, как у глав; с «Ускорить» оба пропускаются сами, пауза и отмена загрузки действуют всегда
async function trackImageRequest() {
    await trackRequest();
    await window.maybeAddImagePause?.();
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
    emit({ type: 'log', line: `[${new Date().toLocaleTimeString()}] ${message}`, isError, color });
}

// Прогресс = готовые главы + доля текущей главы по картинкам: шкала двигается с каждой страницей
let progressNow = { current: 0, total: 0, part: 0 };
let progressSamples = []; // [{t, f}] - доля всей загрузки во времени, для оценки оставшегося времени
const ETA_WINDOW_MS = 60000; // скорость берём по последней минуте: паузы быстро выпадают из оценки

function updateProgress(current, total) {
    progressNow = { current, total, part: 0 };
    reportProgress();
}

function updateImageProgress(done, total) {
    progressNow.part = total > 0 ? Math.min(done / total, 1) : 0;
    reportProgress();
}

function reportProgress() {
    const { current, total, part } = progressNow;
    const now = Date.now();
    progressSamples.push({ t: now, f: total > 0 ? Math.min((current + part) / total, 1) : 0 });
    while (progressSamples.length > 2 && now - progressSamples[1].t > ETA_WINDOW_MS) progressSamples.shift();
    emit({ type: 'progress', current, total, part });
}

function addDownloadedBytes(bytes) {
    totalBytesDownloaded += bytes;
}

// Скорость по замерам { t, bytes } (скачано всего к моменту t) за последние 10 с, байт/с; 0, пока замеры короче секунды.
// Общая с загрузкой серий AnimeLIB (engine/anime.js)
const SPEED_WINDOW_MS = 10000;
function trackSpeed(samples, t, bytes) {
    samples.push({ t, bytes });
    while (samples.length > 2 && t - samples[1].t >= SPEED_WINDOW_MS) samples.shift();
    const seconds = (t - samples[0].t) / 1000;
    return seconds >= 1 ? (bytes - samples[0].bytes) / seconds : 0;
}

function formatSpeed(bytesPerSecond) {
    return bytesPerSecond >= 1048576 ? `${(bytesPerSecond / 1048576).toFixed(1)} МБ/с` : `${Math.round(bytesPerSecond / 1024)} КБ/с`;
}

// Секунды до конца или null, пока скорость не ясна. Время с последнего отчёта входит в оценку: застой растит её
function estimateRemainingSeconds(samples, now) {
    const first = samples[0], last = samples[samples.length - 1];
    if (!first) return null;
    if (last.f >= 1) return 0;
    const seconds = (now - first.t) / 1000;
    const done = last.f - first.f;
    if (seconds < 5 || done <= 0) return null;
    return (1 - last.f) * seconds / done;
}

async function checkPause() {
    while (isPaused) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

// Функция для очистки состояния перед новой загрузкой
function resetDownloadState() {
    // Очищаем статистику через statistics.js
    window.resetStatistics();
    totalBytesDownloaded = 0;
    speedSamples = [];
    
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
    isWaitingForUser = false;
    shouldRetryChapter = false;
    shouldRetryImage = false;
    skippedChapters = [];
    userDecisionResolve = null;
    cancelRequested = false;

    // Останавливаем интервал обновления статистики если он был
    if (statsUpdateInterval) {
        clearInterval(statsUpdateInterval);
        statsUpdateInterval = null;
    }
}

// Функция для запуска загрузки (вызывается движком в фоне, engine/). Работает от снимка (см. snapshot.js), storage не читает
async function startDownload(snapshot) {
    try {
        resetDownloadState();
        const result = snapshot.stored || {};
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
            window.setSpeedMode(result.speedMode !== false); // «Ускорить» по умолчанию включён
        }
        
        if (!snapshot.downloadData) {
            throw new Error('Данные для загрузки не найдены');
        }
        options = { ...snapshot.downloadData };
        chaptersToDownload = options.chapters;

        // Сохраняем настройку отключения оглавления (всегда берем из снимка настроек)
        const disableToc = result.disableToc !== undefined ? result.disableToc : false;
        options.disableToc = disableToc;
        options.epubTocPage = !disableToc; // Когда оглавление включено, создаем отдельную страницу

        // Сохраняем переименованные названия полей
        options.fieldLabels = result.fieldLabels || {};
        
        // Сохраняем порядок полей
        options.metadataFieldOrder = result.metadataFieldOrder || null;
        
        // Выбор перевода, все главы, оригинальные метаданные и sourceUrl из снимка titleData
        Object.assign(options, snapshot.titleExtras);

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
        speedSamples = [];
        progressSamples = [];

        // Сбрасываем счётчики пауз
        if (window.resetPauseCounters) {
            window.resetPauseCounters();
        }

        // Запускаем интервал обновления статистики (каждую секунду)
        statsUpdateInterval = setInterval(updateStatisticsDisplay, 1000);
        
        updateStatisticsDisplay();
        
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

        // Заголовок по настройкам - только главам без сохранённого (правка в редакторе глав; смена формата сама сбрасывает сохранённые)
        const tocFormat = options.settings.tocFormat || 'default';
        const customTocFormat = options.settings.customTocFormat || '';
        const hideChapterName = options.settings.hideChapterName || false;
        const hideVolumeNumber = options.settings.hideVolumeNumber || false;

        chaptersToDownload.forEach(ch => {
            ch.displayTitle ||= formatChapterTitle(ch.volume, ch.number, ch.name, tocFormat, customTocFormat, hideChapterName, hideVolumeNumber);
        });

        updateProgress(0, chaptersToDownload.length);

        // Используем фабрику форматтеров для генерации файла
        const formatterOptions = {
            ...options,
            format: options.selectedFormat,
            // Передаем функции для RateLimiter и статистики
            trackRequest: trackRequest,
            trackImageRequest: trackImageRequest,
            addLog: addLog,
            updateProgress: updateProgress,
            updateImageProgress: updateImageProgress,
            incrementErrorCount: window.incrementErrorCount,
            incrementSkippedImagesCount: window.incrementSkippedImagesCount,
            addFileSize: window.addFileSize,
            addDownloadedBytes: addDownloadedBytes,
            updateChapterIndex: window.updateChapterIndex,
            recordChapterTime: window.recordChapterTime,
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
            sameWidth: result.sameWidth === true,
            // Передаем siteType для определения типа контента
            siteType: options.siteType,
            // Передаем параметры для manga
            tabId: options.tabId,
            slug: options.slug,
            siteKey: options.siteKey, // base.js вызывает страницу сайта по siteKey, без chrome.tabs
            imageServer: options.imageServer || 'normal',
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
        throwIfCanceled(); // форматтер мог доделать файл, глотая ошибки отменённых запросов

        // Устанавливаем точный размер файла после финализации
        setExactFileSize(blob.size);
        updateStatisticsDisplay();
        
        const skippedImages = window.getStatisticsValue?.('skippedImagesCount') || 0;
        const skippedCount = Math.max(skippedChapters.length, window.getStatisticsValue?.('skippedChaptersCount') || 0);
        const downloadedCount = chaptersToDownload.length - skippedCount;
        addLog(completionText({ downloaded: downloadedCount, total: chaptersToDownload.length, skippedImages }));

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

        return { blob, filename, downloaded: downloadedCount, total: chaptersToDownload.length, skippedChapters: [...skippedChapters], skippedImages };
    } catch (err) {
        addLog(`Критическая ошибка: ${err.message}`, true);
        console.error(err);
        throw err; // сообщить об ошибке и вернуть управление — дело вызывающего
    } finally {
        if (statsUpdateInterval) {
            clearInterval(statsUpdateInterval);
            statsUpdateInterval = null;
        }
    }
}

// Итог загрузки одной строкой (для лога и строки прогресса)
function completionText({ downloaded, total, skippedImages }) {
    return downloaded < total || skippedImages
        ? `Готово с пропусками: ${downloaded} / ${total} глав; пропущено картинок: ${skippedImages}`
        : `Загрузка завершена: ${downloaded} / ${total} глав`;
}

// Управление загрузкой: то, что окно или движок вызывают по кнопкам Пауза / Повторить / Пропустить
const downloadControl = {
    pause() {
        setPaused(true);
    },
    resume() {
        setPaused(false);
    },
    retry() {
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
    },
    skip() {
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
    },
    setSpeedMode(on) {
        window.setSpeedMode?.(on);
    },
    // Ждущее решение и следующий запрос бросают ошибку отмены; startDownload завершается с ней
    cancel() {
        cancelRequested = true;
        isPaused = false;
        userDecisionMade();
    }
};

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
    const downloadStartTime = window.getStatisticsValue('downloadStartTime');
    const siteType = options.siteType || 'ranobe';
    // Главы старого формата не относятся к манге
    const isManga = siteType === 'manga';

    emit({
        type: 'stats',
        stats: {
            elapsed: formatTime(downloadStartTime ? (Date.now() - downloadStartTime) / 1000 : 0),
            estimated: calculateEstimatedTime(),
            etaSeconds: estimateRemainingSeconds(progressSamples, Date.now()),
            speed: downloadSpeedText(),
            fileSize: formatFileSize(window.getStatisticsValue('totalFileSize')),
            errors: window.getStatisticsValue('totalErrorCount'),
            skippedChapters: window.getStatisticsValue('skippedChaptersCount'),
            skippedImages: window.getStatisticsValue('skippedImagesCount'),
            // Фактическая скорость и лимит
            requestsPerMinute: Math.max(0, requestsInLastMinute),
            maxRequestsPerMinute,
            oldFormatChapters: isManga ? '-' : window.getStatisticsValue('oldFormatChaptersCount'),
            totalChapters: window.getStatisticsValue('totalChapters'),
            totalCovers: window.getStatisticsValue('totalCovers'),
            totalImages: window.getStatisticsValue('totalImages')
        }
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

// undefined, пока скачивать нечего (ждём вкладку, решение, стоим на паузе): окна такую строку не показывают
function downloadSpeedText() {
    const speed = trackSpeed(speedSamples, Date.now(), totalBytesDownloaded);
    return speed > 0 ? formatSpeed(speed) : undefined;
}

function calculateEstimatedTime() {
    const seconds = estimateRemainingSeconds(progressSamples, Date.now());
    return seconds === null ? 'Вычисляется...' : formatTime(seconds);
}

// Обработчик ошибок глав
async function handleChapterError(chapter, error, chapterIndex) {
    throwIfCanceled();
    currentErrorImage = null;
    currentErrorChapter = chapter;
    isWaitingForUser = true;
    shouldRetryChapter = false;

    const volume = chapter.volume || '1';
    const number = chapter.number || '?';
    const title = chapter.displayTitle || chapter.title || '';

    addLog(`ОШИБКА при загрузке главы: Том ${volume}. Глава ${number}. ${title}`, true);
    addLog(`Ошибка: ${error.message}`, true);

    // Приостанавливаем загрузку и ждём решения пользователя
    setPaused(true);
    emit({ type: 'decision', decision: { kind: 'chapter', chapterTitle: title, message: error.message } });
    await waitForUserDecision();
    emit({ type: 'decisionDone' });
    throwIfCanceled();

    // Возобновляем загрузку
    setPaused(false);

    isWaitingForUser = false;

    currentErrorChapter = null;
    return {
        shouldRetry: shouldRetryChapter,
        shouldSkip: !shouldRetryChapter
    };
}

// Обработчик ошибок картинок (для манги)
let currentErrorImage = null;
let shouldRetryImage = false;

async function handleImageError(chapter, error, chapterIndex, imageUrl) {
    throwIfCanceled();
    currentErrorChapter = null;
    currentErrorImage = { chapter, error, imageUrl };
    isWaitingForUser = true;
    shouldRetryImage = false;

    const volume = chapter.volume || '1';
    const number = chapter.number || '?';
    const title = chapter.displayTitle || chapter.title || '';

    addLog(`ОШИБКА при загрузке изображения: Том ${volume}. Глава ${number}. ${title}`, true);
    addLog(`Ошибка: ${error.message}`, true);
    addLog(`URL изображения: ${imageUrl}`, true);

    // Приостанавливаем загрузку и ждём решения пользователя
    setPaused(true);
    emit({ type: 'decision', decision: { kind: 'image', chapterTitle: title, message: error.message, imageUrl } });
    await waitForUserDecision();
    emit({ type: 'decisionDone' });
    throwIfCanceled();

    // Возобновляем загрузку
    setPaused(false);

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
