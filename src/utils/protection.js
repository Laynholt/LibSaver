// protection.js - Централизованный модуль защиты от блокировок
// Управляет случайными паузами, RateLimiter и режимом ускорения

// Состояние защиты
var isSpeedMode = false;
var chaptersSinceLastPause = 0;
var nextPauseAfterChapters = 0;
var imagesSinceLastPause = 0;

// Параметры случайных пауз
var RANDOM_PAUSE_MIN = 400;  // 0.4 сек
var RANDOM_PAUSE_MAX = 1600;  // 1.6 сек
var RANDOM_PAUSE_CHAPTERS_MIN = 1;  // Минимум глав между паузами
var RANDOM_PAUSE_CHAPTERS_MAX = 4;  // Максимум глав между паузами
var RANDOM_PAUSE_IMAGES_MIN = 2;  // Минимум картинок между паузами
var RANDOM_PAUSE_IMAGES_MAX = 4;  // Максимум картинок между паузами
var RANDOM_PAUSE_IMAGE_MIN = 400;  // 0.4 сек
var RANDOM_PAUSE_IMAGE_MAX = 2000;  // 2 сек

// Установить режим ускорения
function setSpeedMode(enabled) {
    isSpeedMode = enabled;
}

// Получить текущий режим ускорения
function getSpeedMode() {
    return isSpeedMode;
}

// Сбросить счётчики пауз
function resetPauseCounters() {
    chaptersSinceLastPause = 0;
    nextPauseAfterChapters = 0;
    imagesSinceLastPause = 0;
}

// Случайная пауза между главами
async function maybeAddRandomPause(chapterIndex, addLogCallback) {
    if (isSpeedMode) return;
    
    chaptersSinceLastPause++;
    
    if (nextPauseAfterChapters === 0) {
        nextPauseAfterChapters = RANDOM_PAUSE_CHAPTERS_MIN + Math.floor(Math.random() * (RANDOM_PAUSE_CHAPTERS_MAX - RANDOM_PAUSE_CHAPTERS_MIN + 1));
    }
    
    if (chaptersSinceLastPause >= nextPauseAfterChapters) {
        const pauseDuration = RANDOM_PAUSE_MIN + Math.floor(Math.random() * (RANDOM_PAUSE_MAX - RANDOM_PAUSE_MIN + 1));

        await new Promise(resolve => setTimeout(resolve, pauseDuration));
        
        chaptersSinceLastPause = 0;
        nextPauseAfterChapters = RANDOM_PAUSE_CHAPTERS_MIN + Math.floor(Math.random() * (RANDOM_PAUSE_CHAPTERS_MAX - RANDOM_PAUSE_CHAPTERS_MIN + 1));
    }
}

// Случайная пауза между картинками
async function maybeAddImagePause(addLogCallback) {
    if (isSpeedMode) return;
    
    imagesSinceLastPause++;
    
    const threshold = RANDOM_PAUSE_IMAGES_MIN + Math.floor(Math.random() * (RANDOM_PAUSE_IMAGES_MAX - RANDOM_PAUSE_IMAGES_MIN + 1));
    
    if (imagesSinceLastPause >= threshold) {
        const pauseDuration = RANDOM_PAUSE_IMAGE_MIN + Math.floor(Math.random() * (RANDOM_PAUSE_IMAGE_MAX - RANDOM_PAUSE_IMAGE_MIN + 1));

        await new Promise(resolve => setTimeout(resolve, pauseDuration));
        
        imagesSinceLastPause = 0;
    }
}

// Сбросить счётчик картинок
function resetImagePauseCounter() {
    imagesSinceLastPause = 0;
}

// Экспортируем функции в window для глобального доступа
window.setSpeedMode = setSpeedMode;
window.getSpeedMode = getSpeedMode;
window.resetPauseCounters = resetPauseCounters;
window.maybeAddRandomPause = maybeAddRandomPause;
window.maybeAddImagePause = maybeAddImagePause;
window.resetImagePauseCounter = resetImagePauseCounter;