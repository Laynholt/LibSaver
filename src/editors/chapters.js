// Глобальные переменные
let allChapters = []; // Полный список глав (сохраняется в storage)
let displayChapters = []; // Главы для отображения (по диапазону из popup)
let originalChapters = [];
let userChapters = [];
let currentSlug = null;
let wasSaved = false;
let translatorPriority = [];

// Переменные пагинации
let currentPage = 0;
let pageSize = 500;
let initialChapterCount = 500;
let loadMoreChapterCount = 500;
let totalChaptersRendered = 0;
let enablePagination = false;

// Флаг для отслеживания изменений приоритета
let priorityChanged = false;

// Слушатель сообщений для обновления темы
setupThemeMessageListener();

let tocFormat = 'default';
let customTocFormat = '';
let hideChapterName = false;
let hideVolumeNumber = false;

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

function extractBranches() {
  branches = {};
  
  allChapters.forEach(ch => {
    // Нормализуем branches: если это объект, конвертируем в массив
    let branchesList = ch.branches;
    if (branchesList && !Array.isArray(branchesList)) {
      branchesList = Object.values(branchesList);
    }
    
    if (branchesList && Array.isArray(branchesList) && branchesList.length > 0) {
      branchesList.forEach(branch => {
        const translatorKey = getTranslatorKey(branch);
        const translatorName = getTranslatorName(branch);
        
        if (!branches[translatorKey]) {
          branches[translatorKey] = translatorName;
        }
      });
    } else {
      const branchId = ch.branchId === null ? 'null' : ch.branchId;
      const teamName = ch.branchTeamName || 'Основной перевод';
      const translatorKey = `${branchId}_unknown`;
      if (!branches[translatorKey]) {
        branches[translatorKey] = teamName;
      }
    }
  });
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

function populateTranslators() {
  const translatorSelect = document.getElementById('translator-select');
  const translatorField = document.getElementById('translator-field');
  
  const branchIds = Object.keys(branches);
  if (branchIds.length === 0) {
    if (translatorField) translatorField.style.display = 'none';
    if (translatorSelect) translatorSelect.textContent = 'Основной перевод';
    return;
  }

  if (translatorField) translatorField.style.display = 'block';

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
  
  let priorityTranslatorName = null;
  if (translatorPriority.length > 0) {
    // Находим имя переводчика для первого ключа из приоритета
    const priorityTranslatorKey = translatorPriority[0];
    priorityTranslatorName = branches[priorityTranslatorKey];
  }
  
  if (translatorSelect) {
    if (priorityTranslatorName) {
      translatorSelect.textContent = priorityTranslatorName;
    } else if (branchIds.length > 0) {
      // Если приоритет пуст или не найден, используем первый из branches
      translatorSelect.textContent = branches[branchIds[0]];
    } else {
      translatorSelect.textContent = 'Основной перевод';
    }
  }
  
  initTranslatorPriorityPopup();
}

// Загружаем и применяем тему
document.addEventListener('DOMContentLoaded', async () => {
  // Регистрируем окно редактора глав
  await chrome.storage.local.set({ currentOpenWindow: 'chapters' });

  // Очищаем регистрацию при закрытии
  window.addEventListener('beforeunload', async () => {
    await chrome.storage.local.remove('currentOpenWindow');
  });

  // Загружаем и применяем тему
  await loadAndApplyTheme();

  // Применяем акцентный цвет по сайту (из storage)
  const result = await chrome.storage.local.get(['sourceUrl', 'titleData', 'originalTitleData', 'currentSlug', 'tocFormat', 'customTocFormat', 'hideChapterName', 'hideVolumeNumber', 'enablePagination', 'initialChapters', 'loadMoreChapters']);
  const sourceUrl = result.sourceUrl;
  if (sourceUrl) {
    window.applySiteAccent(sourceUrl);
  }
  
  currentSlug = result.currentSlug || '';
  
  if (result.titleData && result.titleData[currentSlug]) {
    chapterBranchOverrides = result.titleData[currentSlug].chapterBranchOverrides || {};
    translatorPriority = result.titleData[currentSlug].translatorPriority || [];
  } else {
    chapterBranchOverrides = {};
    translatorPriority = [];
  }
  
  allChapters = [];
  displayChapters = [];
  originalChapters = [];
  wasSaved = false;
  branches = {};

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

  // Применяем настройки пагинации
  enablePagination = result.enablePagination === true;
  initialChapterCount = result.initialChapters || 500;
  loadMoreChapterCount = result.loadMoreChapters || 500;
  pageSize = loadMoreChapterCount;

  // Общее количество глав на сайте (для пагинации используем реальное количество, а не отфильтрованное)
  let totalChapters = 0;
  if (result.originalTitleData && result.originalTitleData[currentSlug] && result.originalTitleData[currentSlug].metadata) {
    totalChapters = result.originalTitleData[currentSlug].metadata.totalChapters || 0;
  }
  updateTotalChapters(totalChapters);

  // Загружаем полный список глав для сохранения изменений и приоритетов
  if (result.titleData && result.titleData[currentSlug] && result.titleData[currentSlug].chapters) {
    allChapters = result.titleData[currentSlug].chapters || [];
  }

  // Загружаем отфильтрованные главы для отображения (по диапазону из popup)
  if (result.titleData && result.titleData[currentSlug] && result.titleData[currentSlug].filteredChapters) {
    displayChapters = result.titleData[currentSlug].filteredChapters || [];
  } else {
    // Fallback: если filteredChapters нет, используем все главы
    displayChapters = allChapters;
  }
  
  if (result.originalTitleData && result.originalTitleData[currentSlug] && result.originalTitleData[currentSlug].chapters) {
    originalChapters = (result.originalTitleData[currentSlug].chapters || []).map(ch => ({
      id: ch.id,
      volume: ch.volume,
      number: ch.number,
      name: ch.name,
      branchId: ch.branchId
    }));
  } else {
    originalChapters = (result.titleData && result.titleData[currentSlug] && result.titleData[currentSlug].chapters || []).map(ch => ({
      id: ch.id,
      volume: ch.volume,
      number: ch.number,
      name: ch.name,
      branchId: ch.branchId
    }));
  }
  
  extractBranches();
  
  // Фильтруем translatorPriority, оставляя только те ключи, которые существуют в branches
  if (translatorPriority.length > 0) {
    const validPriority = [];
    for (const translatorKey of translatorPriority) {
      if (branches[translatorKey]) {
        validPriority.push(translatorKey);
      }
    }
    translatorPriority = validPriority;
  }
  
  const uniqueDisplayChapters = getUniqueChapters(displayChapters);
  const uniqueOriginalChapters = getUniqueChapters(originalChapters);

  renderChaptersList(uniqueDisplayChapters, uniqueOriginalChapters);
  populateTranslators();

  // Применяем сохраненные настройки переводчиков к загруженным главам
  if (translatorPriority.length > 0 || Object.keys(chapterBranchOverrides).length > 0) {
    applyTranslatorPriority(false); // false = не перезаписывать индивидуальные override
  }

  // totalChapters уже обновлён выше из originalTitleData.metadata.totalChapters
  updateEditorChaptersCount(uniqueDisplayChapters.length);
  
  // Инициализируем кнопку Очистить всё
  initClearAllButton();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    let settingsChanged = false;
    
    if (changes.tocFormat) {
      tocFormat = changes.tocFormat.newValue;
      settingsChanged = true;
    }
    if (changes.customTocFormat) {
      customTocFormat = changes.customTocFormat.newValue;
      settingsChanged = true;
    }
    if (changes.hideChapterName) {
      hideChapterName = changes.hideChapterName.newValue;
      settingsChanged = true;
    }
    if (changes.hideVolumeNumber) {
      hideVolumeNumber = changes.hideVolumeNumber.newValue;
      settingsChanged = true;
    }
    
    if (settingsChanged) {
      const inputs = document.querySelectorAll('.chapter-input');
      const uniqueOriginalChapters = getUniqueChapters(originalChapters);
      inputs.forEach((input) => {
        const index = parseInt(input.dataset.index);
        const originalCh = uniqueOriginalChapters[index];
        if (originalCh) {
          const defaultValue = formatChapterTitle(originalCh.volume, originalCh.number, originalCh.name, tocFormat, customTocFormat, hideChapterName, hideVolumeNumber);
          input.dataset.default = defaultValue;
          input.value = defaultValue;
        }
      });
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

      // Обновляем ВСЕ главы в allChapters с новым форматом (включая не загруженные в DOM)
      const uniqueAllChapters = getUniqueChapters(allChapters);
      const uniqueOriginalChapters = getUniqueChapters(originalChapters);
      uniqueAllChapters.forEach((ch, index) => {
        const originalCh = uniqueOriginalChapters[index];
        if (originalCh) {
          ch.displayTitle = formatChapterTitle(originalCh.volume, originalCh.number, originalCh.name, tocFormat, customTocFormat, hideChapterName, hideVolumeNumber);
        }
      });

      // Обновляем загруженные в DOM inputs с новым форматом
      const inputs = document.querySelectorAll('.chapter-input');
      inputs.forEach((input) => {
        const index = parseInt(input.dataset.index);
        const originalCh = uniqueOriginalChapters[index];
        if (originalCh) {
          const defaultValue = formatChapterTitle(originalCh.volume, originalCh.number, originalCh.name, tocFormat, customTocFormat, hideChapterName, hideVolumeNumber);
          input.dataset.default = defaultValue;
          input.value = defaultValue;
        }
      });
    });
  }
});

function renderChaptersList(chapters, originalChapters, startIndex = 0, append = false, loadAll = false, overridePageSize = null) {
  const container = document.getElementById('chapters-list');
  
  if (!append) {
    container.innerHTML = '';
    currentPage = 0;
    totalChaptersRendered = 0;
    // Для первой загрузки используем initialChapterCount
    if (enablePagination && startIndex === 0) {
      pageSize = initialChapterCount;
    } else {
      pageSize = loadMoreChapterCount;
    }
  }
  
  // Если передан overridePageSize - используем его (для loadMoreChapters)
  const effectivePageSize = overridePageSize || pageSize;
  
  // Если пагинация отключена или loadAll=true - рендерим все главы до конца
  const endIndex = (!enablePagination || loadAll) ? chapters.length : Math.min(startIndex + effectivePageSize, chapters.length);
  const chaptersToRender = chapters.slice(startIndex, endIndex);
  
  chaptersToRender.forEach((ch, i) => {
    const globalIndex = startIndex + i;
    const originalCh = originalChapters[globalIndex] || ch;
    const div = document.createElement('div');
    div.className = 'chapter-item';
    div.dataset.index = globalIndex;
    
    const header = document.createElement('div');
    header.className = 'chapter-header';
    
    const label = document.createElement('div');
    label.className = 'chapter-title';
    label.textContent = `Том ${originalCh.volume}. Глава ${originalCh.number}.${originalCh.name ? ' ' + originalCh.name : ''}`;
    
    header.appendChild(label);
    
    const resetBtn = document.createElement('button');
    resetBtn.className = 'chapter-reset-btn';
    resetBtn.innerHTML = '<i class="fa-solid fa-rotate-left"></i>';
    resetBtn.dataset.index = globalIndex;
    
    header.appendChild(resetBtn);
    div.appendChild(header);
    
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'chapter-input-wrapper';
    
    const input = document.createElement('input');
    input.className = 'chapter-input';
    input.type = 'text';
    const defaultValue = formatChapterTitle(originalCh.volume, originalCh.number, originalCh.name, tocFormat, customTocFormat, hideChapterName, hideVolumeNumber);
    input.dataset.default = defaultValue;
    input.value = ch.displayTitle || defaultValue;
    input.dataset.index = globalIndex;
    
    inputWrapper.appendChild(input);
    
    const variants = getChapterVariants(ch.id);
    let currentTranslatorKey = chapterBranchOverrides[ch.id];
    let currentTranslator = '';
    
    if (!currentTranslatorKey && translatorPriority.length > 0) {
      for (const priorityKey of translatorPriority) {
        if (variants.has(priorityKey)) {
          currentTranslatorKey = priorityKey;
          break;
        }
      }
    }
    
    if (!currentTranslatorKey && ch.branches && ch.branches[0]) {
      currentTranslatorKey = getTranslatorKey(ch.branches[0]);
    }
    
    if (currentTranslatorKey && variants.has(currentTranslatorKey)) {
      currentTranslator = variants.get(currentTranslatorKey);
    } else if (ch.branches && ch.branches[0]) {
      currentTranslator = getTranslatorName(ch.branches[0]);
    } else {
      currentTranslator = ch.branchTeamName || 'Основной перевод';
    }
    
    if (variants.size > 1) {
      const translatorSelect = document.createElement('div');
      translatorSelect.className = 'chapter-translator';
      translatorSelect.textContent = currentTranslator;
      translatorSelect.dataset.chapterId = ch.id;
      
      const dropdown = document.createElement('div');
      dropdown.className = 'chapter-translator-dropdown';
      dropdown.style.display = 'none';
      dropdown.style.position = 'absolute';
      dropdown.style.zIndex = '1000';
      
      variants.forEach((name, translatorKey) => {
        const option = document.createElement('div');
        option.className = 'chapter-translator-option';
        if (translatorKey === currentTranslatorKey) {
          option.classList.add('selected');
        }
        option.textContent = name;
        option.dataset.translatorKey = translatorKey;
        option.addEventListener('click', (e) => {
          e.stopPropagation();
          chapterBranchOverrides[ch.id] = translatorKey;
          translatorSelect.textContent = name;
          dropdown.querySelectorAll('.chapter-translator-option').forEach(opt => opt.classList.remove('selected'));
          option.classList.add('selected');
          dropdown.style.display = 'none';
        });
        dropdown.appendChild(option);
      });
      
      inputWrapper.appendChild(dropdown);
      inputWrapper.appendChild(translatorSelect);
      
      const resizeObserver = new ResizeObserver(() => {
        const translatorWidth = translatorSelect.offsetWidth;
        input.style.paddingRight = (translatorWidth + 12) + 'px';
      });
      resizeObserver.observe(translatorSelect);
      
      translatorSelect.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.chapter-translator-dropdown').forEach(dd => {
          if (dd !== dropdown) dd.style.display = 'none';
        });
        const rect = translatorSelect.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.top = (rect.bottom + 2) + 'px';
        dropdown.style.left = rect.left + 'px';
        dropdown.style.display = dropdown.style.display !== 'none' ? 'none' : 'block';
      });
      
      document.addEventListener('click', (e) => {
        if (!translatorSelect.contains(e.target) && !dropdown.contains(e.target)) {
          dropdown.style.display = 'none';
        }
      });
      
      inputWrapper.appendChild(translatorSelect);
    }
    
    div.appendChild(inputWrapper);
    container.appendChild(div);
  });
  
  totalChaptersRendered = endIndex;
  updateEditorChaptersCount(chapters.length);
  initChapterResetButtons();
  
  updateLoadMoreButton(chapters.length);
}

function updateTotalChapters(count) {
  const countElement = document.getElementById('total-chapters');
  if (countElement) {
    countElement.textContent = count;
  }
}

function updateEditorChaptersCount(count) {
  const countElement = document.getElementById('chapter-count');
  if (countElement) {
    countElement.textContent = count;
  }
}

function updateLoadMoreButton(totalChapters) {
  // Если пагинация отключена - не показываем кнопки
  if (!enablePagination) {
    const loadMoreBtn = document.getElementById('btn-load-more');
    const loadAllBtn = document.getElementById('btn-load-all');
    const buttonsContainer = document.getElementById('load-more-buttons');
    
    if (loadMoreBtn) loadMoreBtn.style.display = 'none';
    if (loadAllBtn) loadAllBtn.style.display = 'none';
    if (buttonsContainer) buttonsContainer.style.display = 'none';
    return;
  }
  
  let loadMoreBtn = document.getElementById('btn-load-more');
  let loadAllBtn = document.getElementById('btn-load-all');
  let buttonsContainer = document.getElementById('load-more-buttons');
  
  if (totalChaptersRendered >= totalChapters) {
    if (loadMoreBtn) {
      loadMoreBtn.style.display = 'none';
    }
    if (loadAllBtn) {
      loadAllBtn.style.display = 'none';
    }
    if (buttonsContainer) {
      buttonsContainer.style.display = 'none';
    }
  } else {
    const remaining = totalChapters - totalChaptersRendered;
    
    // Создаём контейнер для кнопок если нет
    if (!buttonsContainer) {
      buttonsContainer = document.createElement('div');
      buttonsContainer.id = 'load-more-buttons';
      buttonsContainer.className = 'load-more-buttons';
      
      const container = document.getElementById('chapters-list');
      if (container) {
        container.appendChild(buttonsContainer);
      }
    } else {
      buttonsContainer.style.display = 'flex';
      // Перемещаем контейнер в конец списка
      const container = document.getElementById('chapters-list');
      if (container) {
        container.appendChild(buttonsContainer);
      }
    }
    
    // Кнопка "Показать ещё"
    if (remaining > loadMoreChapterCount) {
      if (!loadMoreBtn) {
        loadMoreBtn = document.createElement('button');
        loadMoreBtn.id = 'btn-load-more';
        loadMoreBtn.className = 'btn-load-more';
        loadMoreBtn.innerHTML = `<i class="fa-solid fa-angle-down"></i> Показать ещё (${loadMoreChapterCount})`;
        loadMoreBtn.addEventListener('click', loadMoreChapters);
        
        buttonsContainer.appendChild(loadMoreBtn);
      } else {
        loadMoreBtn.style.display = 'inline-flex';
        loadMoreBtn.innerHTML = `<i class="fa-solid fa-angle-down"></i> Показать ещё (${loadMoreChapterCount})`;
      }
    } else {
      if (loadMoreBtn) {
        loadMoreBtn.style.display = 'none';
      }
    }
    
    // Кнопка "Показать все"
    if (!loadAllBtn) {
      loadAllBtn = document.createElement('button');
      loadAllBtn.id = 'btn-load-all';
      loadAllBtn.className = 'btn-load-more';
      loadAllBtn.innerHTML = `<i class="fa-solid fa-angles-down"></i> Показать все (${remaining})`;
      loadAllBtn.addEventListener('click', loadAllChapters);
      
      buttonsContainer.appendChild(loadAllBtn);
    } else {
      loadAllBtn.style.display = 'inline-flex';
      loadAllBtn.innerHTML = `<i class="fa-solid fa-angles-down"></i> Показать все (${remaining})`;
    }
  }
}

function loadMoreChapters() {
  saveCurrentPageChanges();

  const uniqueDisplayChapters = getUniqueChapters(displayChapters);
  const uniqueOriginalChapters = getUniqueChapters(originalChapters);

  // При загрузке "ещё" используем loadMoreChapterCount
  const loadMoreSize = loadMoreChapterCount;
  // startIndex должен быть количеством уже загруженных глав
  const startIndex = totalChaptersRendered;

  renderChaptersList(uniqueDisplayChapters, uniqueOriginalChapters, startIndex, true, false, loadMoreSize);

  // Переключаем кнопку скролла на "вниз"
  if (typeof switchScrollButtonToDown === 'function') {
    switchScrollButtonToDown();
  }
}

function loadAllChapters() {
  saveCurrentPageChanges();

  const uniqueDisplayChapters = getUniqueChapters(displayChapters);
  const uniqueOriginalChapters = getUniqueChapters(originalChapters);

  // Загружаем все оставшиеся главы (от текущей позиции до конца)
  const startIndex = totalChaptersRendered;

  renderChaptersList(uniqueDisplayChapters, uniqueOriginalChapters, startIndex, true, true);

  // Переключаем кнопку скролла на "вниз"
  if (typeof switchScrollButtonToDown === 'function') {
    switchScrollButtonToDown();
  }
}

function saveCurrentPageChanges() {
  const inputs = document.querySelectorAll('.chapter-input');
  const uniqueDisplayChapters = getUniqueChapters(displayChapters);
  const uniqueAllChapters = getUniqueChapters(allChapters);

  inputs.forEach((input) => {
    const displayIndex = parseInt(input.dataset.index);
    const displayCh = uniqueDisplayChapters[displayIndex];
    if (displayCh) {
      const value = input.value.trim() || input.dataset.default;
      // Находим соответствующую главу в allChapters по ID и сохраняем изменение
      const allCh = uniqueAllChapters.find(ch => ch.id === displayCh.id);
      if (allCh) {
        allCh.displayTitle = value;
      }
    }
  });
}



document.getElementById('btn-save').addEventListener('click', () => {
  const inputs = document.querySelectorAll('.chapter-input');
  const uniqueDisplayChapters = getUniqueChapters(displayChapters);
  const uniqueAllChapters = getUniqueChapters(allChapters);

  inputs.forEach((input) => {
    const displayIndex = parseInt(input.dataset.index);
    const displayCh = uniqueDisplayChapters[displayIndex];
    if (displayCh) {
      const value = input.value.trim() || input.dataset.default;
      // Находим соответствующую главу в allChapters по ID и сохраняем изменение
      const allCh = uniqueAllChapters.find(ch => ch.id === displayCh.id);
      if (allCh) {
        allCh.displayTitle = value;
      }
    }
  });

  // Заполняем пустые displayTitle дефолтными значениями для всех глав
  // (включая непрогруженные в DOM)
  const uniqueOriginalChapters = getUniqueChapters(originalChapters);
  uniqueAllChapters.forEach((ch, index) => {
    if (!ch.displayTitle) {
      const originalCh = uniqueOriginalChapters[index];
      if (originalCh) {
        ch.displayTitle = formatChapterTitle(
          originalCh.volume,
          originalCh.number,
          originalCh.name,
          tocFormat,
          customTocFormat,
          hideChapterName,
          hideVolumeNumber
        );
      }
    }
  });

  chrome.storage.local.get(['titleData', 'currentSlug'], (result) => {
    const titleData = result.titleData || {};
    const currentSlug = result.currentSlug;
    
    if (!titleData[currentSlug]) {
      titleData[currentSlug] = { chapters: null, metadata: {}, covers: [] };
    }
    
    titleData[currentSlug].chapters = allChapters;
    // НЕ перезаписываем filteredChapters - он должен создаваться только в popup по диапазону
    titleData[currentSlug].chapterBranchOverrides = chapterBranchOverrides;
    titleData[currentSlug].translatorPriority = translatorPriority;

    // Обновляем timestamp кэша (продлеваем срок действия на 10 минут)
    titleData[currentSlug].cacheTimestamp = Date.now();

    chrome.storage.local.set({ titleData }, () => {
      wasSaved = true;
      chrome.runtime.sendMessage({ action: 'showToast', message: 'Сохранено!', type: 'success' });
      chrome.windows.getCurrent((window) => {
        if (window && window.id) {
          chrome.windows.remove(window.id);
        }
      });
    });
  });
});

document.getElementById('btn-reset').addEventListener('click', () => {
  const inputs = document.querySelectorAll('.chapter-input');

  inputs.forEach((input) => {
    input.value = input.dataset.default;
  });
  
  const uniqueChapters = getUniqueChapters(allChapters);
  uniqueChapters.forEach(ch => {
    delete ch.displayTitle;
  });
  
  chapterBranchOverrides = {};
  translatorPriority = [];
  
  // Сначала вычисляем новый приоритет на основе частоты
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
  populateTranslators();
  
  // Применяем приоритет и обновляем DOM без полного рендера (сохраняет пагинацию)
  applyTranslatorPriority(true, false, true);
});


function initChapterResetButtons() {
  const resetButtons = document.querySelectorAll('.chapter-reset-btn');
  resetButtons.forEach(button => {
    button.addEventListener('click', (e) => {
      e.preventDefault();
      const index = parseInt(button.dataset.index);
      const input = document.querySelector(`.chapter-input[data-index="${index}"]`);
      if (input) {
        input.value = input.dataset.default || '';
      }

      const uniqueDisplayChapters = getUniqueChapters(displayChapters);
      const uniqueAllChapters = getUniqueChapters(allChapters);
      const displayChapter = uniqueDisplayChapters[index];
      if (displayChapter) {
        delete chapterBranchOverrides[displayChapter.id];

        const variants = getChapterVariants(displayChapter.id);
        // Находим соответствующую главу в allChapters по ID
        const allChapter = uniqueAllChapters.find(ch => ch.id === displayChapter.id);
        if (allChapter) {
          applyTranslatorPriorityToChapter(allChapter, variants, false);
        }

        const translatorSelect = document.querySelector(`.chapter-translator[data-chapter-id="${displayChapter.id}"]`);
        if (translatorSelect) {
          const currentTranslatorKey = chapterBranchOverrides[displayChapter.id];
          let currentTranslator = '';

          if (currentTranslatorKey && variants.has(currentTranslatorKey)) {
            currentTranslator = variants.get(currentTranslatorKey);
          } else if (displayChapter.branches && displayChapter.branches[0]) {
            currentTranslator = getTranslatorName(displayChapter.branches[0]);
          } else {
            currentTranslator = displayChapter.branchTeamName || 'Основной перевод';
          }
          translatorSelect.textContent = currentTranslator;
          
          // dropdown находится ПЕРЕД translatorSelect в DOM (previousElementSibling)
          const dropdown = translatorSelect.previousElementSibling;
          if (dropdown) {
            dropdown.querySelectorAll('.chapter-translator-option').forEach(opt => {
              opt.classList.remove('selected');
              if (opt.dataset.translatorKey === currentTranslatorKey) {
                opt.classList.add('selected');
              }
            });
          }
        }
      }
    });
  });
}


window.addEventListener('beforeunload', () => {
  if (!wasSaved) {
    chrome.runtime.sendMessage({ action: 'showToast', message: 'Отменено!', type: 'cancel' });
  }
});

function updatePriorityList(listElement) {
  if (!listElement) {
    console.error('updatePriorityList: listElement is null');
    return;
  }
  
  listElement.innerHTML = '';
  
  const translatorCounts = {};
  const translatorNames = {};
  
  allChapters.forEach(ch => {
    if (ch.branches && Array.isArray(ch.branches)) {
      ch.branches.forEach(branch => {
        const key = getTranslatorKey(branch);
        const name = getTranslatorName(branch);
        
        if (!translatorCounts[key]) {
          translatorCounts[key] = 0;
        }
        translatorCounts[key]++;
        
        if (!translatorNames[key]) {
          translatorNames[key] = name;
        }
      });
    }
  });
  
  let priorityList = [...translatorPriority];
  if (priorityList.length === 0) {
    priorityList = Object.keys(translatorCounts).sort((a, b) => translatorCounts[b] - translatorCounts[a]);
    translatorPriority = priorityList;
  }
  
  Object.keys(translatorCounts).forEach(translatorKey => {
    if (!priorityList.includes(translatorKey)) {
      priorityList.push(translatorKey);
    }
  });
  
  priorityList = priorityList.filter(translatorKey => translatorCounts[translatorKey]);
  translatorPriority = priorityList;
  
  priorityList.forEach((translatorKey, index) => {
    const item = document.createElement('div');
    item.className = 'translator-priority-item';
    item.dataset.translatorKey = translatorKey;
    item.dataset.index = index;
    
    const name = document.createElement('span');
    name.className = 'translator-priority-name';
    name.textContent = translatorNames[translatorKey] || 'Основной перевод';
    
    const count = document.createElement('span');
    count.className = 'translator-priority-count';
    count.textContent = translatorCounts[translatorKey] + ' гл.';
    
    const controls = document.createElement('div');
    controls.className = 'translator-priority-controls';
    
    const upBtn = document.createElement('button');
    upBtn.className = 'translator-priority-btn translator-priority-up';
    upBtn.innerHTML = '<i class="fa-solid fa-chevron-up"></i>';
    upBtn.title = 'Увеличить приоритет';
    upBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      moveTranslatorUp(listElement, item);
    });
    
    const downBtn = document.createElement('button');
    downBtn.className = 'translator-priority-btn translator-priority-down';
    downBtn.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
    downBtn.title = 'Уменьшить приоритет';
    downBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      moveTranslatorDown(listElement, item);
    });
    
    controls.appendChild(upBtn);
    controls.appendChild(downBtn);
    
    item.appendChild(name);
    item.appendChild(count);
    item.appendChild(controls);
    listElement.appendChild(item);
  });
  
  updateButtonStates(listElement);
}

function moveTranslatorUp(listElement, item) {
  const prevItem = item.previousElementSibling;
  if (prevItem) {
    listElement.insertBefore(item, prevItem);
    updatePriorityFromList(listElement);
    updateButtonStates(listElement);
  }
}

function moveTranslatorDown(listElement, item) {
  const nextItem = item.nextElementSibling;
  if (nextItem) {
    listElement.insertBefore(nextItem, item);
    updatePriorityFromList(listElement);
    updateButtonStates(listElement);
  }
}

function updateButtonStates(listElement) {
  const items = listElement.querySelectorAll('.translator-priority-item');
  const itemsCount = items.length;
  
  items.forEach((item, index) => {
    const upBtn = item.querySelector('.translator-priority-up');
    const downBtn = item.querySelector('.translator-priority-down');
    
    // Если всего один перевод - скрываем кнопки полностью (display: none)
    // Если больше одного переводов - скрываем только визуально (visibility: hidden)
    const useDisplayNone = itemsCount === 1;
    
    if (upBtn) {
      if (index === 0) {
        if (useDisplayNone) {
          upBtn.style.display = 'none';
        } else {
          upBtn.style.visibility = 'hidden';
          upBtn.style.cursor = 'default';
        }
      } else {
        upBtn.style.display = 'flex';
        upBtn.style.visibility = 'visible';
        upBtn.style.cursor = 'pointer';
      }
    }
    if (downBtn) {
      if (index === itemsCount - 1) {
        if (useDisplayNone) {
          downBtn.style.display = 'none';
        } else {
          downBtn.style.visibility = 'hidden';
          downBtn.style.cursor = 'default';
        }
      } else {
        downBtn.style.display = 'flex';
        downBtn.style.visibility = 'visible';
        downBtn.style.cursor = 'pointer';
      }
    }
  });
}

function updatePriorityFromList(listElement) {
  const items = listElement.querySelectorAll('.translator-priority-item');
  const newPriority = [];
  items.forEach(item => {
    newPriority.push(item.dataset.translatorKey);
  });
  translatorPriority = newPriority;
  priorityChanged = true;
  
  const translatorSelect = document.getElementById('translator-select');
  if (translatorSelect && newPriority.length > 0) {
    const priorityTranslatorKey = newPriority[0];
    // Используем branches для получения имени переводчика
    const priorityTranslatorName = branches[priorityTranslatorKey];
    if (priorityTranslatorName) {
      translatorSelect.textContent = priorityTranslatorName;
    }
  }
  
  // Если глав меньше 800, обновляем сразу (старая схема)
  // Обновляем только DOM без полного рендера (сохраняет пагинацию)
  const uniqueDisplayChapters = getUniqueChapters(displayChapters);
  if (uniqueDisplayChapters.length < 800) {
    applyTranslatorPriority(true, false, true); // updateDomOnly=true
  }
  // Если глав много (>800), приоритет не применяется сразу для оптимизации
}

// Очистить все названия глав с двухэтапным подтверждением
function initClearAllButton() {
  let clearAllTimeout = null;
  document.getElementById('btn-clear-all').addEventListener('click', () => {
    const btn = document.getElementById('btn-clear-all');
    
    if (btn.textContent.includes('Уверены?')) {
      // Второй клик - подтверждение
      clearTimeout(clearAllTimeout);
      clearAllTimeout = null;
      
      // Очищаем все поля (делаем пустыми)
      const inputs = document.querySelectorAll('.chapter-input');
      inputs.forEach(input => {
        input.value = '';
      });
      
      // Сбрасываем кнопку
      btn.innerHTML = '<i class="fa-solid fa-eraser"></i> Очистить всё';
    } else {
      // Первый клик - показываем подтверждение
      btn.innerHTML = '<i class="fa-solid fa-eraser"></i> Уверены?';
      
      // Таймаут 8 секунд для возврата в исходное состояние
      clearAllTimeout = setTimeout(() => {
        btn.innerHTML = '<i class="fa-solid fa-eraser"></i> Очистить всё';
        clearAllTimeout = null;
      }, 8000);
    }
  });
}

function initTranslatorPriorityPopup() {
  const translatorSelect = document.getElementById('translator-select');
  if (!translatorSelect) return;

  if (typeof window.tippy === 'undefined') {
    console.error('Tippy library not loaded');
    return;
  }

  if (translatorSelect._tippy) {
    translatorSelect._tippy.destroy();
  }

  const popupContent = document.createElement('div');
  popupContent.className = 'translator-priority-popup';

  const list = document.createElement('div');
  list.className = 'translator-priority-list';
  popupContent.appendChild(list);

  const isDark = !document.documentElement.hasAttribute('data-theme');

  try {
    window.tippy(translatorSelect, {
      content: popupContent,
      placement: 'bottom',
      trigger: 'mouseenter',
      interactive: true,
      arrow: false,
      maxWidth: 420,
      theme: isDark ? 'dark' : 'light',
      onShow: () => {
        updatePriorityList(list);
      },
      onHide: () => {
        // Обновляем список глав только при закрытии tippy (уход мыши) если:
        // 1. Были изменения в приоритете
        // 2. И глав >= 800 (оптимизация)
        // Обновляем только DOM без полного рендера (сохраняет пагинацию)
        if (priorityChanged) {
          const uniqueDisplayChapters = getUniqueChapters(displayChapters);
          if (uniqueDisplayChapters.length >= 800) {
            applyTranslatorPriority(true, false, true); // updateDomOnly=true
          }
          priorityChanged = false;
        }
      }
    });
  } catch (error) {
    console.error('Error creating tippy instance:', error);
  }
}

function applyTranslatorPriorityToChapter(chapter, variants, allowOverride = true) {
  if (translatorPriority.length === 0 || variants.size <= 1) return;
  
  // При изменении глобального приоритета перезаписываем все индивидуальные override
  // allowOverride = true по умолчанию для этого поведения
  if (allowOverride) {
    for (const translatorKey of translatorPriority) {
      if (variants.has(translatorKey)) {
        chapterBranchOverrides[chapter.id] = translatorKey;
        break;
      }
    }
  } else if (!chapterBranchOverrides[chapter.id]) {
    // Если allowOverride = false, применяем приоритет только к главам без override
    for (const translatorKey of translatorPriority) {
      if (variants.has(translatorKey)) {
        chapterBranchOverrides[chapter.id] = translatorKey;
        break;
      }
    }
  }
}

function applyTranslatorPriority(allowOverride = true, forceRenderAll = false, updateDomOnly = false) {
  // Если принудительно requested (сброс) - рендерим даже если приоритет пуст
  if (translatorPriority.length === 0 && !forceRenderAll) return;

  const uniqueAllChapters = getUniqueChapters(allChapters);
  const uniqueDisplayChapters = getUniqueChapters(displayChapters);

  uniqueAllChapters.forEach(ch => {
    const variants = getChapterVariants(ch.id);
    applyTranslatorPriorityToChapter(ch, variants, allowOverride);
  });

  // Если updateDomOnly=true - обновляем только DOM без полного рендера
  if (updateDomOnly) {
    updateChapterDom(uniqueDisplayChapters);
    return;
  }

  // Рендерим только если:
  // 1. Принудительно requested (forceRenderAll=true - для сброса)
  // 2. Или если не все главы загружены (для пагинации)
  if (forceRenderAll || totalChaptersRendered < uniqueDisplayChapters.length) {
    const uniqueOriginalChapters = getUniqueChapters(originalChapters);
    // Если forceRenderAll=true - рендерим все главы (loadAll=true)
    renderChaptersList(uniqueDisplayChapters, uniqueOriginalChapters, 0, false, forceRenderAll);
  }
}

// Обновляет DOM элементы глав без полного рендера (сохраняет пагинацию)
function updateChapterDom(uniqueDisplayChapters) {
  const uniqueAllChapters = getUniqueChapters(allChapters);

  uniqueDisplayChapters.forEach((displayCh, displayIndex) => {
    // Находим соответствующую главу в allChapters по ID
    const allCh = uniqueAllChapters.find(ch => ch.id === displayCh.id);

    // Обновляем только если элемент существует в DOM
    const input = document.querySelector(`.chapter-input[data-index="${displayIndex}"]`);
    if (input) {
      const defaultValue = input.dataset.default;
      input.value = (allCh?.displayTitle) || defaultValue;
    }

    // Обновляем текст переводчика
    const translatorSelect = document.querySelector(`.chapter-translator[data-chapter-id="${displayCh.id}"]`);
    if (translatorSelect) {
      const variants = getChapterVariants(displayCh.id);

      // Вычисляем currentTranslatorKey так же как при рендере
      let currentTranslatorKey = chapterBranchOverrides[displayCh.id];
      if (!currentTranslatorKey && translatorPriority.length > 0) {
        for (const priorityKey of translatorPriority) {
          if (variants.has(priorityKey)) {
            currentTranslatorKey = priorityKey;
            break;
          }
        }
      }
      if (!currentTranslatorKey && displayCh.branches && displayCh.branches[0]) {
        currentTranslatorKey = getTranslatorKey(displayCh.branches[0]);
      }

      let currentTranslator = '';
      if (currentTranslatorKey && variants.has(currentTranslatorKey)) {
        currentTranslator = variants.get(currentTranslatorKey);
      } else if (displayCh.branches && displayCh.branches[0]) {
        currentTranslator = getTranslatorName(displayCh.branches[0]);
      } else {
        currentTranslator = displayCh.branchTeamName || 'Основной перевод';
      }

      translatorSelect.textContent = currentTranslator;

      // Обновляем выбранный вариант в dropdown
      // dropdown находится ПЕРЕД translatorSelect в DOM (previousElementSibling)
      const dropdown = translatorSelect.previousElementSibling;
      if (dropdown) {
        dropdown.querySelectorAll('.chapter-translator-option').forEach(opt => {
          opt.classList.remove('selected');
          if (opt.dataset.translatorKey === currentTranslatorKey) {
            opt.classList.add('selected');
          }
        });
      }
    }
  });
}
