// Metadata.js - управление метаданными ранобэ

let currentSlug = null;
let userMetadata = {}; // Пользовательские метаданные
let originalMetadata = {}; // Оригинальные метаданные с API (для сброса)
let metadataFields = {}; // Состояние чекбоксов полей из настроек
let fieldLabelsLoaded = false; // до загрузки fieldLabels из storage их нельзя записывать: пустой tempFieldLabels затёр бы сохранённые
let tempFieldLabels = {}; // Изменения названий полей, ещё не записанные в storage (пишет saveMetadata)
let originalFieldLabels = {}; // Оригинальные названия полей из storage (для отмены)
let publisherLabel = 'Издательство'; // у аниме - «Студия»

// AnimeLIB: художника и «Тип» (манга, манхва...) у аниме нет, а издатель - это студия
function applyAnimeFields() {
  for (const fieldId of ['artist', 'country']) {
    const field = document.querySelector(`.field[data-field="${fieldId}"]`);
    if (field) field.style.display = 'none';
  }
  publisherLabel = 'Студия';
  const label = document.querySelector('.field[data-field="publisher"] label');
  if (label) label.textContent = publisherLabel; // переименование пользователя (fieldLabels) ляжет поверх
}

// Слушатель сообщений для обновления темы
setupThemeMessageListener();

// Загрузка метаданных при открытии страницы
document.addEventListener('DOMContentLoaded', async () => {
  // Загружаем и применяем тему
  await loadAndApplyTheme();

  // Применяем акцентный цвет по сайту (из storage)
  const result = await chrome.storage.local.get(['sourceUrl', 'siteType']);
  const sourceUrl = result.sourceUrl;
  if (result.siteType === 'anime') applyAnimeFields();
  if (sourceUrl) {
    window.applySiteAccent(sourceUrl);
  }
  
  // Получаем метаданные из storage (загруженные popup.js)
  getTitleStore(['currentSlug', 'titleData', 'originalTitleData', 'metadataFields']).then((result) => {
    if (result.currentSlug) {
      currentSlug = result.currentSlug;
    }

    // Загружаем состояния чекбоксов из настроек
    if (result.metadataFields) {
      metadataFields = result.metadataFields;
    } else {
      // По умолчанию все поля включены
      metadataFields = {
        'title-ru': true,
        'title-en': true,
        'title-original': true,
        'title-alt': true,
        'author': true,
        'artist': true,
        'year': true,
        'status': true,
        'country': true,
        'release-format': true,
        'publisher': true,
        'age-restriction': true,
        'description': true,
        'genres': true,
        'tags': true
      };
    }
    applyFieldStates();

    // Загружаем оригинальные названия полей из storage
    chrome.storage.local.get(['fieldLabels'], (labelResult) => {
      originalFieldLabels = { ...(labelResult.fieldLabels || {}) };
      tempFieldLabels = { ...originalFieldLabels };
      fieldLabelsLoaded = true;
    });

    // Загружаем сохраненные метаданные пользователя из titleData
    if (result.titleData && result.titleData[currentSlug] && result.titleData[currentSlug].metadata) {
      userMetadata = result.titleData[currentSlug].metadata;
      
      // originalMetadata должна содержать оригинальные данные из API для сброса
      // Загружаем отдельно через callback как в бэкапе
      getTitleStore(['originalTitleData']).then((origResult) => {
        if (origResult.originalTitleData && origResult.originalTitleData[currentSlug] && origResult.originalTitleData[currentSlug].metadata) {
          originalMetadata = { ...origResult.originalTitleData[currentSlug].metadata };
        } else {
          // Fallback: если originalTitleData нет, используем сохраненные данные
          originalMetadata = { ...userMetadata };
        }
        
        fillFieldsFromSite();
      });
    }
  });
  
  // Инициализируем drag-and-drop
  initDragAndDrop();
  
  // Инициализируем кнопки сброса для отдельных полей
  initFieldResetButtons();
  
  // Инициализируем кнопки переименования полей
  initFieldRenameButtons();

  // Инициализируем кнопки видимости полей
  initFieldVisibilityButtons();

  // Применяем сохранённые названия полей
  applyFieldLabels();
});


// Заполнение полей данными с сайта
function fillFieldsFromSite() {
  document.getElementById('title-ru').value = userMetadata.titleRu || '';
  document.getElementById('title-en').value = userMetadata.titleEn || '';
  document.getElementById('title-original').value = userMetadata.titleOriginal || '';
  document.getElementById('title-alt').value = userMetadata.titleAlt || '';
  document.getElementById('author').value = userMetadata.author || '';
  document.getElementById('artist').value = userMetadata.artist || '';
  document.getElementById('year').value = userMetadata.year || '';
  document.getElementById('status').value = userMetadata.status || '';
  document.getElementById('country').value = userMetadata.country || '';
  document.getElementById('release-format').value = userMetadata.releaseFormat || '';
  document.getElementById('publisher').value = userMetadata.publisher || '';
  document.getElementById('age-restriction').value = userMetadata.ageRestriction || '';
  document.getElementById('description').value = userMetadata.description || '';
  document.getElementById('genres').value = userMetadata.genres || '';
  document.getElementById('tags').value = userMetadata.tags || '';
  
  // Инициализируем autosize для многострочных полей (кроме title-alt)
  const textareas = ['description', 'genres', 'tags'];
  textareas.forEach(id => {
    const textarea = document.getElementById(id);
    if (textarea) {
      // Принудительно устанавливаем начальную высоту
      textarea.style.height = '28px';
      autosize(textarea);
      // Добавляем класс limit-reached при достижении максимальной высоты
      textarea.addEventListener('autosize:resized', () => {
        if (textarea.scrollHeight >= 280) {
          textarea.classList.add('limit-reached');
        } else {
          textarea.classList.remove('limit-reached');
        }
      });
    }
  });
  
  // Для title-alt используем кастомную функцию (white-space: pre)
  const titleAlt = document.getElementById('title-alt');
  if (titleAlt) {
    // Устанавливаем минимальную высоту
    titleAlt.style.minHeight = '28px';
    titleAlt.style.height = '28px';
    
    // Добавляем авто-подстройку высоты по количеству строк
    function autoResizeTitleAlt() {
      const lines = titleAlt.value.split('\n');
      const computedStyle = window.getComputedStyle(titleAlt);
      const fontSize = parseFloat(computedStyle.fontSize);
      const lineHeight = parseFloat(computedStyle.lineHeight) || fontSize * 1.4;
      const padding = parseFloat(computedStyle.paddingTop) + parseFloat(computedStyle.paddingBottom);
      const newHeight = Math.max(28, lines.length * lineHeight + padding);
      
      // Ограничиваем высоту до 280px
      if (newHeight >= 280) {
        titleAlt.style.height = '280px';
        titleAlt.classList.add('limit-reached');
      } else {
        titleAlt.style.height = newHeight + 'px';
        titleAlt.classList.remove('limit-reached');
      }
    }
    
    // Обновляем высоту при вводе
    titleAlt.addEventListener('input', autoResizeTitleAlt);
    
    // Инициализируем высоту
    autoResizeTitleAlt();
    
    // Сохраняем функцию глобально для использования в других местах
    window.autoResizeTitleAlt = autoResizeTitleAlt;
  }
}

// Применение сохраненных состояний чекбоксов из настроек
function applyFieldStates() {
  const fields = document.querySelectorAll('.field');
  fields.forEach(field => {
    const fieldId = field.getAttribute('data-field');

    if (metadataFields[fieldId] === false) {
      field.classList.add('disabled');
    } else {
      field.classList.remove('disabled');
    }

    // Иконка power-off всегда одинаковая, не меняем её
  });
}

// Инициализация drag-and-drop для полей с использованием SortableJS
function initDragAndDrop() {
  const container = document.getElementById('fields-container');
  if (!container) return;
  
  // Загружаем сохраненный порядок полей
  chrome.storage.local.get(['metadataFieldOrder'], (result) => {
    if (result.metadataFieldOrder) {
      applyFieldOrder(result.metadataFieldOrder);
    }
  });
  
  // Инициализируем SortableJS только для полей, не для кнопок
  new Sortable(container, {
    animation: 150,
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    dragClass: 'sortable-drag',
    handle: 'label',
    filter: '.btn-group, .field-reset-btn, .field-rename-btn',
    preventOnFilter: false,
    onEnd: function(evt) {
      // Убеждаемся что кнопки остаются внизу
      const btnGroup = container.querySelector('.btn-group');
      if (btnGroup && evt.item !== btnGroup) {
        container.appendChild(btnGroup);
      }
      saveFieldOrder();
    }
  });
}

// Сохранение порядка полей
function saveFieldOrder() {
  const container = document.getElementById('fields-container');
  const fields = container.querySelectorAll('.field');
  const fieldOrder = Array.from(fields).map(field => field.getAttribute('data-field'));
  chrome.storage.local.set({ metadataFieldOrder: fieldOrder });
}

// Применение сохраненного порядка полей
function applyFieldOrder(fieldOrder) {
  const container = document.getElementById('fields-container');
  const fields = Array.from(container.querySelectorAll('.field'));
  
  fieldOrder.forEach(fieldId => {
    const field = fields.find(f => f.getAttribute('data-field') === fieldId);
    if (field) {
      container.appendChild(field);
    }
  });
}

// Сохранение метаданных (автосохранение, enableAutosave)
async function saveMetadata() {
  if (!currentSlug) return; // тайтл ещё не загружен
  const metadata = {};
  
  // Добавляем только включенные поля из настроек
  if (metadataFields['title-ru'] !== false) {
    metadata.titleRu = document.getElementById('title-ru').value;
  }
  if (metadataFields['title-en'] !== false) {
    metadata.titleEn = document.getElementById('title-en').value;
  }
  if (metadataFields['title-original'] !== false) {
    metadata.titleOriginal = document.getElementById('title-original').value;
  }
  if (metadataFields['title-alt'] !== false) {
    metadata.titleAlt = document.getElementById('title-alt').value;
  }
  if (metadataFields['author'] !== false) {
    metadata.author = document.getElementById('author').value;
  }
  if (metadataFields['artist'] !== false) {
    metadata.artist = document.getElementById('artist').value;
  }
  if (metadataFields['year'] !== false) {
    metadata.year = document.getElementById('year').value;
  }
  if (metadataFields['status'] !== false) {
    metadata.status = document.getElementById('status').value;
  }
  if (metadataFields['country'] !== false) {
    metadata.country = document.getElementById('country').value;
  }
  if (metadataFields['release-format'] !== false) {
    metadata.releaseFormat = document.getElementById('release-format').value;
  }
  if (metadataFields['publisher'] !== false) {
    metadata.publisher = document.getElementById('publisher').value;
  }
  if (metadataFields['age-restriction'] !== false) {
    metadata.ageRestriction = document.getElementById('age-restriction').value;
  }
  if (metadataFields['description'] !== false) {
    metadata.description = document.getElementById('description').value;
  }
  if (metadataFields['genres'] !== false) {
    metadata.genres = document.getElementById('genres').value;
  }
  if (metadataFields['tags'] !== false) {
    metadata.tags = document.getElementById('tags').value;
  }

  const result = await getTitleStore(['titleData']);
  const titleData = result.titleData || {};
  // Инициализируем структуру если нет
  if (!titleData[currentSlug]) {
    titleData[currentSlug] = { chapters: null, metadata: {}, covers: [] };
  }

  // Сохраняем существующие covers, чтобы не потерять обложки
  const existingData = titleData[currentSlug] || {};
  metadata.covers = existingData.covers || [];
  // metadata.cover приходит с сайта или из редактора обложек, у поля метаданных его нет
  if (existingData.metadata?.cover !== undefined) metadata.cover = existingData.metadata.cover;

  titleData[currentSlug].metadata = metadata;

  // Обновляем timestamp кэша (продлеваем срок действия на 10 минут)
  titleData[currentSlug].cacheTimestamp = Date.now();

  // Сохраняем названия полей в storage (когда они уже загружены)
  await setTitleStore(fieldLabelsLoaded ? { titleData, fieldLabels: tempFieldLabels } : { titleData });
}

// Сброс к данным с сайта
document.getElementById('btn-reset').addEventListener('click', () => {
  // Загружаем оригинальные метаданные из API (originalTitleData)
  getTitleStore(['originalTitleData', 'currentSlug']).then((result) => {
    if (result.originalTitleData && result.currentSlug && result.originalTitleData[result.currentSlug] && result.originalTitleData[result.currentSlug].metadata) {
      const resetMetadata = result.originalTitleData[result.currentSlug].metadata;
      document.getElementById('title-ru').value = resetMetadata.titleRu || '';
      document.getElementById('title-en').value = resetMetadata.titleEn || '';
      document.getElementById('title-original').value = resetMetadata.titleOriginal || '';
      document.getElementById('title-alt').value = resetMetadata.titleAlt || '';
      document.getElementById('author').value = resetMetadata.author || '';
      document.getElementById('artist').value = resetMetadata.artist || '';
      document.getElementById('year').value = resetMetadata.year || '';
      document.getElementById('status').value = resetMetadata.status || '';
      document.getElementById('country').value = resetMetadata.country || '';
      document.getElementById('release-format').value = resetMetadata.releaseFormat || '';
      document.getElementById('publisher').value = resetMetadata.publisher || '';
      document.getElementById('age-restriction').value = resetMetadata.ageRestriction || '';
      document.getElementById('description').value = resetMetadata.description || '';
      document.getElementById('genres').value = resetMetadata.genres || '';
      document.getElementById('tags').value = resetMetadata.tags || '';
      
      // Обновляем autosize для многострочных полей (кроме title-alt)
      autosize.update(document.getElementById('description'));
      autosize.update(document.getElementById('genres'));
      autosize.update(document.getElementById('tags'));
      
      // Обновляем высоту title-alt
      if (window.autoResizeTitleAlt) {
        window.autoResizeTitleAlt();
      }
      
      // Обновляем originalMetadata для сброса отдельных полей
      originalMetadata = { ...resetMetadata };
      
      // Сбрасываем все названия полей к дефолтным
      resetAllFieldLabels();
      notifyChanged();
    } else {
      // Fallback: если originalTitleData нет, пробуем из titleData
      getTitleStore(['titleData', 'currentSlug']).then((result) => {
        if (result.titleData && result.currentSlug && result.titleData[result.currentSlug] && result.titleData[result.currentSlug].metadata) {
          const savedMetadata = result.titleData[result.currentSlug].metadata;
          document.getElementById('title-ru').value = savedMetadata.titleRu || '';
          document.getElementById('title-en').value = savedMetadata.titleEn || '';
          document.getElementById('title-original').value = savedMetadata.titleOriginal || '';
          document.getElementById('title-alt').value = savedMetadata.titleAlt || '';
          document.getElementById('author').value = savedMetadata.author || '';
          document.getElementById('artist').value = savedMetadata.artist || '';
          document.getElementById('year').value = savedMetadata.year || '';
          document.getElementById('status').value = savedMetadata.status || '';
          document.getElementById('country').value = savedMetadata.country || '';
          document.getElementById('release-format').value = savedMetadata.releaseFormat || '';
          document.getElementById('publisher').value = savedMetadata.publisher || '';
          document.getElementById('age-restriction').value = savedMetadata.ageRestriction || '';
          document.getElementById('description').value = savedMetadata.description || '';
          document.getElementById('genres').value = savedMetadata.genres || '';
          document.getElementById('tags').value = savedMetadata.tags || '';
          
          // Обновляем autosize для многострочных полей (кроме title-alt)
          autosize.update(document.getElementById('description'));
          autosize.update(document.getElementById('genres'));
          autosize.update(document.getElementById('tags'));
          
          // Обновляем высоту title-alt
          if (window.autoResizeTitleAlt) {
            window.autoResizeTitleAlt();
          }
          
          // Обновляем originalMetadata для сброса отдельных полей
          originalMetadata = { ...savedMetadata };
          
          // Сбрасываем все названия полей к дефолтным
          resetAllFieldLabels();
          notifyChanged();
        }
      });
    }
  });
});

// Сброс положения полей к дефолтному
document.getElementById('btn-reset-order').addEventListener('click', () => {
  // Удаляем сохраненный порядок из storage
  chrome.storage.local.remove(['metadataFieldOrder'], () => {
    // Дефолтный порядок полей
    const defaultOrder = [
      'title-ru',
      'title-en',
      'title-original',
      'title-alt',
      'author',
      'artist',
      'year',
      'status',
      'country',
      'release-format',
      'publisher',
      'age-restriction',
      'description',
      'genres',
      'tags'
    ];
    
    // Применяем дефолтный порядок
    applyFieldOrder(defaultOrder);
  });
});

// Очистить все поля с двухэтапным подтверждением
let clearAllTimeout = null;
document.getElementById('btn-clear-all').addEventListener('click', () => {
  const btn = document.getElementById('btn-clear-all');
  
  if (btn.textContent.includes('Уверены?')) {
    // Второй клик - подтверждение
    clearTimeout(clearAllTimeout);
    clearAllTimeout = null;
    
    // Очищаем все поля
    document.getElementById('title-ru').value = '';
    document.getElementById('title-en').value = '';
    document.getElementById('title-original').value = '';
    document.getElementById('title-alt').value = '';
    document.getElementById('author').value = '';
    document.getElementById('artist').value = '';
    document.getElementById('year').value = '';
    document.getElementById('status').value = '';
    document.getElementById('country').value = '';
    document.getElementById('release-format').value = '';
    document.getElementById('publisher').value = '';
    document.getElementById('age-restriction').value = '';
    document.getElementById('description').value = '';
    document.getElementById('genres').value = '';
    document.getElementById('tags').value = '';
    
    // Обновляем autosize для textarea (кроме title-alt)
    const textareas = ['description', 'genres', 'tags'];
    textareas.forEach(id => {
      const textarea = document.getElementById(id);
      if (textarea) {
        autosize.update(textarea);
      }
    });
    
    // Обновляем высоту title-alt
    if (window.autoResizeTitleAlt) {
      window.autoResizeTitleAlt();
    }
    
    // Сбрасываем кнопку
    btn.innerHTML = '<i class="fa-solid fa-eraser"></i> Очистить всё';
    notifyChanged();
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

// Инициализация кнопок сброса для отдельных полей
function initFieldResetButtons() {
  const resetButtons = document.querySelectorAll('.field-reset-btn');
  resetButtons.forEach(button => {
    button.addEventListener('click', (e) => {
      e.preventDefault();
      const fieldId = button.getAttribute('data-field');
      
      // Маппинг fieldId в ключ метаданных
      const fieldToMetadataKey = {
        'title-ru': 'titleRu',
        'title-en': 'titleEn',
        'title-original': 'titleOriginal',
        'title-alt': 'titleAlt',
        'author': 'author',
        'artist': 'artist',
        'year': 'year',
        'status': 'status',
        'country': 'country',
        'release-format': 'releaseFormat',
        'publisher': 'publisher',
        'age-restriction': 'ageRestriction',
        'description': 'description',
        'genres': 'genres',
        'tags': 'tags'
      };
      
      // Дефолтные названия полей
      const defaultFieldLabels = {
        'title-ru': 'Название (RU)',
        'title-en': 'Название (EN)',
        'title-original': 'Название (SRC)',
        'title-alt': 'Название (ALT)',
        'author': 'Автор',
        'artist': 'Художник',
        'year': 'Год',
        'status': 'Статус',
        'country': 'Тип',
        'release-format': 'Формат',
        'publisher': publisherLabel,
        'age-restriction': 'Возрастной рейтинг',
        'description': 'Описание',
        'genres': 'Жанры',
        'tags': 'Метки'
      };
      
      const metadataKey = fieldToMetadataKey[fieldId];
      if (metadataKey !== undefined) {
        // Сбрасываем значение поля
        document.getElementById(fieldId).value = originalMetadata[metadataKey] || '';
        
        // Сбрасываем название поля к дефолтному
        const field = button.closest('.field');
        const label = field.querySelector('label');
        if (label && defaultFieldLabels[fieldId]) {
          label.textContent = defaultFieldLabels[fieldId];
          
          // Удаляем переименованное название из временного хранилища
          delete tempFieldLabels[fieldId];
        }
        
        // Если это textarea (кроме title-alt), обновляем autosize
        const element = document.getElementById(fieldId);
        if (element.tagName === 'TEXTAREA') {
          if (fieldId === 'title-alt') {
            // Для title-alt используем нашу функцию авто-подстройки
            if (window.autoResizeTitleAlt) {
              window.autoResizeTitleAlt();
            }
          } else {
            // Для остальных используем autosize
            autosize.update(element);
          }
        }
        notifyChanged();
      }
    });
  });
}

// Инициализация кнопок переименования полей
function initFieldRenameButtons() {
  const renameButtons = document.querySelectorAll('.field-rename-btn');
  renameButtons.forEach(button => {
    button.addEventListener('click', (e) => {
      e.preventDefault();
      const fieldId = button.getAttribute('data-field');
      const field = button.closest('.field');
      const label = field.querySelector('label');
      
      // Делаем label редактируемым
      label.contentEditable = true;
      label.classList.add('editing');
      label.focus();
      
      // Выделяем весь текст
      const range = document.createRange();
      range.selectNodeContents(label);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      
      // Сохраняем оригинальное значение для отмены
      const originalLabel = label.textContent;
      
      // Обработчик для сохранения при потере фокуса
      const handleBlur = () => {
        label.contentEditable = false;
        label.classList.remove('editing');
        label.removeEventListener('blur', handleBlur);
        label.removeEventListener('keydown', handleKeydown);
        
        const newLabel = label.textContent.trim();
        if (newLabel && newLabel !== originalLabel) {
          // Сохраняем во временное хранилище (не в storage)
          tempFieldLabels[fieldId] = newLabel;
        } else {
          // Возвращаем оригинальное значение если пустое или не изменилось
          label.textContent = originalLabel;
          delete tempFieldLabels[fieldId];
        }
        notifyChanged();
      };
      
      // Обработчик для клавиш
      const handleKeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          label.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          label.textContent = originalLabel;
          label.blur();
          delete tempFieldLabels[fieldId];
        }
      };
      
      label.addEventListener('blur', handleBlur);
      label.addEventListener('keydown', handleKeydown);
    });
  });
}

// Инициализация кнопок видимости полей
function initFieldVisibilityButtons() {
  const visibilityButtons = document.querySelectorAll('.field-visibility-btn');
  visibilityButtons.forEach(button => {
    button.addEventListener('click', (e) => {
      e.preventDefault();
      const fieldId = button.getAttribute('data-field');
      const field = button.closest('.field');

      // Переключаем состояние
      metadataFields[fieldId] = !metadataFields[fieldId];

      // Обновляем UI
      if (metadataFields[fieldId] === false) {
        field.classList.add('disabled');
      } else {
        field.classList.remove('disabled');
      }

      // Сохраняем в storage (синхронизируем с настройками); из этого ключа панель считает «Метаданные: N полей»
      chrome.storage.local.set({ metadataFields });
      notifyChanged(); // отключённое поле не попадает в сохранённые метаданные
    });
  });
}

// Применение сохранённых названий полей
function applyFieldLabels() {
  chrome.storage.local.get(['fieldLabels'], (result) => {
    const fieldLabels = result.fieldLabels || {};
    Object.keys(fieldLabels).forEach(fieldId => {
      const field = document.querySelector(`.field[data-field="${fieldId}"]`);
      if (field) {
        const label = field.querySelector('label');
        if (label) {
          label.textContent = fieldLabels[fieldId];
        }
      }
    });
  });
}

// Сброс всех названий полей к дефолтным
function resetAllFieldLabels() {
  const defaultFieldLabels = {
    'title-ru': 'Название (RU)',
    'title-en': 'Название (EN)',
    'title-original': 'Название (SRC)',
    'title-alt': 'Название (ALT)',
    'author': 'Автор',
    'artist': 'Художник',
    'year': 'Год',
    'status': 'Статус',
    'country': 'Тип',
    'publisher': publisherLabel,
    'age-restriction': 'Возрастной рейтинг',
    'description': 'Описание',
    'genres': 'Жанры',
    'tags': 'Метки'
  };
  
  Object.keys(defaultFieldLabels).forEach(fieldId => {
    const field = document.querySelector(`.field[data-field="${fieldId}"]`);
    if (field) {
      const label = field.querySelector('label');
      if (label) {
        label.textContent = defaultFieldLabels[fieldId];
      }
    }
  });
  
  // Очищаем временные и оригинальные названия
  tempFieldLabels = {};
  originalFieldLabels = {};
  
  // Удаляем все переименованные названия из storage
  chrome.storage.local.remove(['fieldLabels']);
}

enableAutosave({ save: saveMetadata });
