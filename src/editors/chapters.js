// Глобальные переменные
let allChapters = []; // Полный список глав (сохраняется в storage)
let displayChapters = []; // Главы для отображения: все главы тайтла, диапазон и выбор задаются в этом разделе
let originalChapters = [];
let uniqueChapters = []; // getUniqueChapters(displayChapters): индекс в списке = data-index в DOM и значения «от»/«до»
let volumeChapters = new Map(); // том (строкой) -> его главы из uniqueChapters, все, а не только показанные
let volumeCards = new Map(); // том (строкой) -> карточка тома в DOM (по мере показа глав)
// Томов больше одного - дерево: все тома свёрнуты; раскрытые помнятся, пока окно открыто, - перерисовка списка их не сворачивает
const expandedVolumes = new Set();
let renderSource = null; // { chapters, originalChapters, container } последнего показа: из него fillVolume берёт главы тома
let chosenIds = new Set(); // id отмеченных глав (хранится в titleData[slug].selectedChapterIds)
let selectionDirty = false; // выбор правили здесь и ещё не записали: без этого saveChapters чужой выбор (быстрое окошко) не трогает
let userChapters = [];
let currentSlug = null;
let translatorPriority = [];

// Переменные пагинации
let currentPage = 0;
let pageSize = 100;
let initialChapterCount = 100;
let loadMoreChapterCount = 100;
let totalChaptersRendered = 0;

// Таймер отложенного применения приоритета (когда глав много)
let priorityTimer = null;

// Разметка чекбокса та же, что в настройках (стили - .checkbox-group в common.css)
const CHECKBOX_MARKUP = '<svg class="svg-inline--fa fa-square-check fa-fw" aria-hidden="true" focusable="false" data-prefix="fas" data-icon="square-check" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512" data-state="checked"><path fill="currentColor" d="M64 32C28.7 32 0 60.7 0 96L0 416c0 35.3 28.7 64 64 64l320 0c35.3 0 64-28.7 64-64l0-320c0-35.3-28.7-64-64-64L64 32zM337 209L209 337c-9.4 9.4-24.6 9.4-33.9 0l-64-64c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0l47 47L303 175c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9z"></path></svg><svg class="svg-inline--fa fa-square fa-fw" aria-hidden="true" focusable="false" data-prefix="far" data-icon="square" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512" data-state="default"><path fill="currentColor" d="M384 80c8.8 0 16 7.2 16 16l0 320c0 8.8-7.2 16-16 16L64 432c-8.8 0-16-7.2-16-16L48 96c0-8.8 7.2-16 16-16l320 0zM64 32C28.7 32 0 60.7 0 96L0 416c0 35.3 28.7 64 64 64l320 0c35.3 0 64-28.7 64-64l0-320c0-35.3-28.7-64-64-64L64 32z"></path></svg>';

// 'all' | 'some' | 'none': сколько глав тома отмечено. chapters - главы тома или любой список (отбор по volume), selectedIds - Set или массив id
function volumeState(chapters, selectedIds, volume) {
  const chosen = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const inVolume = chapters.filter(ch => String(ch.volume) === String(volume));
  const count = inVolume.filter(ch => chosen.has(ch.id)).length;
  if (count === 0) return 'none';
  return count === inVolume.length ? 'all' : 'some';
}

let checkboxIconsTemplate = null;
function checkboxIcons() {
  if (!checkboxIconsTemplate) {
    checkboxIconsTemplate = document.createElement('template');
    checkboxIconsTemplate.innerHTML = CHECKBOX_MARKUP; // статичная разметка, данных сайта в ней нет
  }
  return checkboxIconsTemplate.content;
}

function createCheckbox(className) {
  const label = document.createElement('label');
  label.className = 'checkbox-group';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = className;
  const indicator = document.createElement('span');
  indicator.className = 'control__indicator';
  indicator.dataset.type = 'checkbox';
  indicator.append(checkboxIcons().cloneNode(true)); // разметка разбирается один раз, а не для каждой из тысяч глав
  label.append(input, indicator);
  return { label, input };
}

// Галочка и счётчик «6 / 6» тома: по всем главам тома, а не только по показанным
function updateVolumeHeader(key) {
  const card = volumeCards.get(key);
  const chapters = volumeChapters.get(key) || [];
  if (!card) return;
  const state = volumeState(chapters, chosenIds, key);
  const input = card.querySelector('.volume-checkbox');
  input.checked = state === 'all';
  input.indeterminate = state === 'some';
  card.querySelector('.volume-count').textContent = `${chapters.filter(ch => chosenIds.has(ch.id)).length} / ${chapters.length}`;
}

function updateRangeCount() {
  const countElement = document.getElementById('range-count');
  if (countElement) countElement.textContent = `${chosenIds.size} из ${uniqueChapters.length}`;
}

// После массового изменения выбора (диапазон, «весь том»): галочки всех показанных глав, шапки томов, счётчик
function refreshSelectionUi() {
  document.querySelectorAll('.chapter-select').forEach(input => {
    input.checked = chosenIds.has(uniqueChapters[parseInt(input.dataset.index)]?.id);
  });
  volumeCards.forEach((card, key) => updateVolumeHeader(key));
  updateRangeCount();
}

function createVolumeCard(key) {
  const card = document.createElement('div');
  card.className = 'volume-card';

  const header = document.createElement('div');
  header.className = 'volume-header';
  const select = createCheckbox('volume-checkbox');
  select.input.title = 'Весь том';
  select.input.addEventListener('change', () => {
    selectionDirty = true;
    (volumeChapters.get(key) || []).forEach(ch => {
      if (select.input.checked) chosenIds.add(ch.id);
      else chosenIds.delete(ch.id);
    });
    refreshSelectionUi();
  });
  const title = document.createElement('span');
  title.className = 'volume-title';
  const unit = volumeChapters.get(key)?.[0]?.episode ? ['Сезон', 'сезон'] : ['Том', 'том'];
  title.textContent = `${unit[0]} ${key}`;
  const count = document.createElement('span');
  count.className = 'volume-count';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'volume-toggle';
  toggle.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
  const setOpen = open => {
    card.classList.toggle('collapsed', !open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.title = `${open ? 'Свернуть' : 'Развернуть'} ${unit[1]}`;
  };
  const flip = () => {
    const open = card.classList.contains('collapsed');
    if (open) expandedVolumes.add(key);
    else expandedVolumes.delete(key);
    setOpen(open);
    if (open) fillVolume(key);
  };
  setOpen(volumeChapters.size <= 1 || expandedVolumes.has(key));
  toggle.addEventListener('click', flip);
  title.addEventListener('click', flip);
  header.append(select.label, title, count, toggle);

  const body = document.createElement('div');
  body.className = 'volume-body';
  card.append(header, body);
  return card;
}

// Тело карточки тома; карточка создаётся, когда в неё впервые попала глава (пагинация дописывает главы в уже показанные тома)
function getVolumeBody(container, volume) {
  const key = String(volume);
  let card = volumeCards.get(key);
  if (!card) {
    card = createVolumeCard(key);
    volumeCards.set(key, card);
    container.appendChild(card);
  }
  return card.querySelector('.volume-body');
}

// «от»/«до» показывают границы текущего выбора (без выбора - весь список)
function syncRangeSelects() {
  const selected = uniqueChapters.map((ch, index) => chosenIds.has(ch.id) ? index : -1).filter(index => index >= 0);
  document.getElementById('range-from').value = selected.length ? selected[0] : 0;
  document.getElementById('range-to').value = selected.length ? selected[selected.length - 1] : uniqueChapters.length - 1;
}

// Выбор тайтла из хранилища: сохранённый selectedChapterIds, иначе диапазон popup, иначе все главы. Id глав, которых уже нет в тайтле, отбрасываются.
// Если из сохранённого не осталось ни одного известного id (главы загрузили заново), берём диапазон popup, а не пустой выбор
function initialSelection(title) {
  const known = new Set(uniqueChapters.map(ch => ch.id));
  const keep = ids => new Set(ids.filter(id => known.has(id)));
  const stored = Array.isArray(title.selectedChapterIds) ? title.selectedChapterIds : null;
  if (stored) {
    const ids = keep(stored);
    if (ids.size > 0 || stored.length === 0) return ids;
  }
  const ranged = keep((title.filteredChapters || []).map(ch => ch.id));
  return ranged.size > 0 ? ranged : keep(uniqueChapters.map(ch => ch.id));
}

// Выбор поменяли снаружи (быстрое окошко, другое окно): пока здесь нет несохранённой правки, подхватываем его
function followStoredSelection(changes) {
  const change = changes[titleStoreKey('titleData', currentSlug)];
  if (selectionDirty || !change?.newValue || uniqueChapters.length === 0) return;
  chosenIds = initialSelection(change.newValue);
  refreshSelectionUi();
  syncRangeSelects();
}

// Диапазон «от»/«до»: все главы тайтла по порядку; выбор = ровно главы диапазона
function initRangeCard() {
  const fromSelect = document.getElementById('range-from');
  const toSelect = document.getElementById('range-to');
  [fromSelect, toSelect].forEach(select => {
    select.replaceChildren(...uniqueChapters.map((ch, index) => {
      const option = document.createElement('option');
      option.value = index;
      option.textContent = chapterLabel(ch);
      return option;
    }));
  });
  syncRangeSelects();

  const apply = changed => {
    selectionDirty = true;
    [fromSelect.value, toSelect.value] = syncRange(Number(fromSelect.value), Number(toSelect.value), changed);
    chosenIds = new Set(rangeChapterIds(uniqueChapters, Number(fromSelect.value), Number(toSelect.value)));
    refreshSelectionUi();
  };
  fromSelect.addEventListener('change', () => apply('from'));
  toSelect.addEventListener('change', () => apply('to'));
  updateRangeCount();
}

// Слушатель сообщений для обновления темы
setupThemeMessageListener();

let tocFormat = 'default';
let customTocFormat = '';
let hideChapterName = false;
let hideVolumeNumber = false;

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

// Переводы главы по id: индекс строится один раз на список глав, а не обходом всех глав для каждой (на тысячах глав это секунды)
let variantsIndex = { chapters: null, byId: new Map() };
function getChapterVariantsById(chapterId) {
  if (variantsIndex.chapters !== allChapters) {
    const byId = new Map();
    allChapters.forEach(ch => {
      if (!ch.branches || !Array.isArray(ch.branches)) return;
      if (!byId.has(ch.id)) byId.set(ch.id, new Map());
      ch.branches.forEach(branch => byId.get(ch.id).set(getTranslatorKey(branch), getTranslatorName(branch)));
    });
    variantsIndex = { chapters: allChapters, byId };
  }
  return new Map(variantsIndex.byId.get(chapterId) || []);
}

// Карточка «Перевод» («Озвучка» у аниме): приоритет переводчиков списком (по умолчанию - по числу глав)
function populateTranslators() {
  const card = document.getElementById('translator-card');
  const list = document.getElementById('translator-list');
  card.querySelector('h4').firstChild.textContent = uniqueChapters[0]?.episode ? 'Озвучка ' : 'Перевод ';
  updatePriorityList(list);
  card.style.display = list.children.length > 0 ? '' : 'none';
}

// Загружаем и применяем тему
document.addEventListener('DOMContentLoaded', async () => {
  // Загружаем и применяем тему
  await loadAndApplyTheme();

  // Применяем акцентный цвет по сайту (из storage)
  const result = await getTitleStore(['sourceUrl', 'titleData', 'originalTitleData', 'currentSlug', 'tocFormat', 'customTocFormat', 'hideChapterName', 'hideVolumeNumber', 'initialChapters', 'loadMoreChapters']);
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
  // Главы всегда показываются частями: тысячи виджетов разом вешают окно
  initialChapterCount = result.initialChapters || 100;
  loadMoreChapterCount = result.loadMoreChapters || 100;
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

  // Раздел показывает все главы тайтла: диапазон задаётся здесь, а не в popup
  displayChapters = allChapters;
  uniqueChapters = getUniqueChapters(allChapters);
  volumeChapters = new Map();
  uniqueChapters.forEach(ch => {
    const key = String(ch.volume);
    if (!volumeChapters.has(key)) volumeChapters.set(key, []);
    volumeChapters.get(key).push(ch);
  });
  chosenIds = initialSelection((result.titleData && result.titleData[currentSlug]) || {});
  

  if (result.originalTitleData && result.originalTitleData[currentSlug] && result.originalTitleData[currentSlug].chapters) {
    originalChapters = (result.originalTitleData[currentSlug].chapters || []).map(ch => ({
      id: ch.id,
      volume: ch.volume,
      number: ch.number,
      name: ch.name,
      branchId: ch.branchId,
      episode: ch.episode
    }));
  } else {
    originalChapters = (result.titleData && result.titleData[currentSlug] && result.titleData[currentSlug].chapters || []).map(ch => ({
      id: ch.id,
      volume: ch.volume,
      number: ch.number,
      name: ch.name,
      branchId: ch.branchId,
      episode: ch.episode
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
  
  const uniqueDisplayChapters = uniqueChapters;
  const uniqueOriginalChapters = getUniqueChapters(originalChapters);

  renderChaptersList(uniqueDisplayChapters, uniqueOriginalChapters);
  initRangeCard();
  populateTranslators();

  // Применяем сохраненные настройки переводчиков к загруженным главам
  if (translatorPriority.length > 0 || Object.keys(chapterBranchOverrides).length > 0) {
    applyTranslatorPriorityToEditor(false); // false = не перезаписывать индивидуальные override
  }

  // totalChapters уже обновлён выше из originalTitleData.metadata.totalChapters
  updateEditorChaptersCount(uniqueDisplayChapters.length);
  
  // Инициализируем кнопку Очистить всё
  initClearAllButton();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    followStoredSelection(changes);
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
    volumeCards = new Map();
    currentPage = 0;
    totalChaptersRendered = 0;
    // Для первой загрузки используем initialChapterCount
    if (startIndex === 0) {
      pageSize = initialChapterCount;
    } else {
      pageSize = loadMoreChapterCount;
    }
  }
  
  // Если передан overridePageSize - используем его (для loadMoreChapters)
  const effectivePageSize = overridePageSize || pageSize;
  
  // loadAll=true - рендерим все главы до конца
  // Томов больше одного - дерево томов вместо показа частями
  const treeMode = volumeChapters.size > 1;
  const endIndex = loadAll || treeMode ? chapters.length : Math.min(startIndex + effectivePageSize, chapters.length);
  const chaptersToRender = chapters.slice(startIndex, endIndex);
  
  if (treeMode) {
    // Дерево: карточки всех томов сразу, свёрнутые; главы тома рисуются, когда его раскрыли (fillVolume)
    renderSource = { chapters, originalChapters, container };
    chapters.forEach(ch => getVolumeBody(container, ch.volume));
    expandedVolumes.forEach(fillVolume);
  } else {
    chaptersToRender.forEach((ch, i) => renderChapterRow(container, ch, originalChapters[startIndex + i] || ch, startIndex + i));
  }
  volumeCards.forEach((card, key) => updateVolumeHeader(key));
  
  totalChaptersRendered = endIndex;
  updateEditorChaptersCount(chapters.length);
  initChapterResetButtons();
  
  updateLoadMoreButton(chapters.length);
}

// Строка главы (серии) в карточке её тома
function renderChapterRow(container, ch, originalCh, globalIndex) {
  const div = document.createElement('div');
  div.className = 'chapter-item';
  div.dataset.index = globalIndex;
  // Серия AnimeLIB - одна строка: галочка, «Серия N», озвучка. Заголовка для оглавления у видео нет, поле и сброс не нужны
  const episode = !!(originalCh.episode || ch.episode);
  if (episode) div.classList.add('episode');
  
  const header = document.createElement('div');
  header.className = 'chapter-header';
  
  const select = createCheckbox('chapter-select');
  select.input.dataset.index = globalIndex;
  select.input.checked = chosenIds.has(ch.id);
  select.input.addEventListener('change', () => {
    selectionDirty = true;
    if (select.input.checked) chosenIds.add(ch.id);
    else chosenIds.delete(ch.id);
    updateVolumeHeader(String(ch.volume));
    updateRangeCount();
  });
  header.appendChild(select.label);

  const label = document.createElement('div');
  label.className = 'chapter-title';
  label.textContent = episode ? `Серия ${originalCh.number}${originalCh.name ? '. ' + originalCh.name : ''}` : chapterLabel(originalCh);
  
  header.appendChild(label);
  
  const resetBtn = document.createElement('button');
  resetBtn.className = 'chapter-reset-btn';
  resetBtn.innerHTML = '<i class="fa-solid fa-rotate-left"></i>';
  resetBtn.dataset.index = globalIndex;
  
  if (!episode) header.appendChild(resetBtn);
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
  
  if (!episode) inputWrapper.appendChild(input);
  
  const variants = getChapterVariantsById(ch.id);
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
        selectionDirty = true; // перевод главы лежит и в копиях глав filteredChapters
        chapterBranchOverrides[ch.id] = translatorKey;
        notifyChanged();
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
    if (!episode) resizeObserver.observe(translatorSelect);
    
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
      div.classList.add('menu-open');
    });
    
    inputWrapper.appendChild(translatorSelect);
  }
  
  (episode ? header : div).appendChild(inputWrapper);
  getVolumeBody(container, ch.volume).appendChild(div);
}

// Главы тома в дереве: при первом раскрытии карточки
function fillVolume(key) {
  const card = volumeCards.get(key);
  if (!card || !renderSource || card.dataset.filled) return;
  card.dataset.filled = 'true';
  const { chapters, originalChapters, container } = renderSource;
  chapters.forEach((ch, index) => {
    if (String(ch.volume) === key) renderChapterRow(container, ch, originalChapters[index] || ch, index);
  });
  updateVolumeHeader(key);
  initChapterResetButtons();
}

// Клик мимо списка переводчиков закрывает его: один обработчик на все главы (клики по самому списку до document не доходят)
document.addEventListener('click', event => {
  if (event.target.closest?.('.chapter-translator-dropdown')) return; // прокрутка или отступ внутри списка
  document.querySelectorAll('.chapter-translator-dropdown').forEach(dropdown => { dropdown.style.display = 'none'; });
});

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



// Сохранение глав (автосохранение, enableAutosave)
async function saveChapters() {
  if (allChapters.length === 0) return; // главы не загружены: не затираем сохранённые пустым списком
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

  const result = await getTitleStore(['titleData', 'currentSlug']);
  const titleData = result.titleData || {};
  const currentSlug = result.currentSlug;
  if (!currentSlug) return; // иначе запись уйдёт в titleData:undefined

  if (!titleData[currentSlug]) {
    titleData[currentSlug] = { chapters: null, metadata: {}, covers: [] };
  }

  titleData[currentSlug].chapters = allChapters;
  // Выбор уходит и в selectedChapterIds, и в filteredChapters (из него снимок берёт главы, в том числе вне прежнего диапазона popup)
  // Только если выбор правили здесь: иначе устаревший выбор перебил бы новый диапазон из быстрого окошка при любом другом автосохранении
  const selectionSaved = selectionDirty;
  if (selectionSaved) {
    selectionDirty = false; // правка во время записи снова поднимет флаг
    applySelectionToTitle(titleData[currentSlug], allChapters, uniqueAllChapters.filter(ch => chosenIds.has(ch.id)).map(ch => ch.id));
  }
  titleData[currentSlug].chapterBranchOverrides = chapterBranchOverrides;
  titleData[currentSlug].translatorPriority = translatorPriority;

  // Обновляем timestamp кэша (продлеваем срок действия на 10 минут)
  titleData[currentSlug].cacheTimestamp = Date.now();

  try {
    await setTitleStore({ titleData });
  } catch (error) {
    if (selectionSaved) selectionDirty = true; // не записали: выбор остаётся несохранённым
    throw error;
  }
}

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
  selectionDirty = true; // перевод глав сброшен: копии в filteredChapters обновятся вместе с выбором
  
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
  applyTranslatorPriorityToEditor(true, false, true);
  notifyChanged();
});


function initChapterResetButtons() {
  const resetButtons = document.querySelectorAll('.chapter-reset-btn');
  resetButtons.forEach(button => {
    if (button.dataset.bound) return; // главы дорисовываются частями и по томам: обработчик - один на кнопку
    button.dataset.bound = 'true';
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
        selectionDirty = true;

        const variants = getChapterVariantsById(displayChapter.id);
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


enableAutosave({ save: saveChapters });

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
  selectionDirty = true;
  notifyChanged();
  
  // Если глав меньше 800, обновляем сразу, иначе после паузы в щелчках (оптимизация)
  // Обновляем только DOM без полного рендера (сохраняет пагинацию)
  clearTimeout(priorityTimer);
  if (getUniqueChapters(displayChapters).length < 800) {
    applyTranslatorPriorityToEditor(true, false, true); // updateDomOnly=true
  } else {
    priorityTimer = setTimeout(() => {
      applyTranslatorPriorityToEditor(true, false, true);
      notifyChanged(); // при >= 800 главах приоритет ложится на главы только сейчас
    }, 500);
  }
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
      notifyChanged();
      
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

function applyTranslatorPriorityToEditor(allowOverride = true, forceRenderAll = false, updateDomOnly = false) {
  // Если принудительно requested (сброс) - рендерим даже если приоритет пуст
  if (translatorPriority.length === 0 && !forceRenderAll) return;

  const uniqueAllChapters = getUniqueChapters(allChapters);
  const uniqueDisplayChapters = getUniqueChapters(displayChapters);

  uniqueAllChapters.forEach(ch => {
    const variants = getChapterVariantsById(ch.id);
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
      const variants = getChapterVariantsById(displayCh.id);

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
