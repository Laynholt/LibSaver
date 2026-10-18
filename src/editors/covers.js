let userCovers = [];
let currentSlug = null;
let originalCovers = [];

setupThemeMessageListener();

// Функция для загрузки изображения через background script (обход защиты)
async function fetchImageWithBypass(url) {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'fetchImage', url: url });
    if (response && response.success) {
      return response.data; // dataURL
    } else {
      console.error('[covers.js] Failed to fetch image:', response?.error);
      return null;
    }
  } catch (e) {
    console.error('[covers.js] Error fetching image:', e);
    return null;
  }
}

// Функция для конвертации dataUrl в Blob
function dataUrlToBlob(dataUrl) {
  const arr = dataUrl.split(',');
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}

// Загрузка данных при открытии
let disableDragAnimations = false;

document.addEventListener('DOMContentLoaded', async () => {
  // Загружаем и применяем тему
  await loadAndApplyTheme();

  // Применяем акцентный цвет по сайту (из storage)
  const result = await chrome.storage.local.get(['sourceUrl']);
  const sourceUrl = result.sourceUrl;
  if (sourceUrl) {
    window.applySiteAccent(sourceUrl);
  }
  
  const dataResult = await getTitleStore(['currentSlug', 'titleData', 'originalTitleData', 'disableDragAnimations']);
  currentSlug = dataResult.currentSlug;
  disableDragAnimations = dataResult.disableDragAnimations || false;

  if (currentSlug) {
    // Сначала проверяем пользовательские обложки (если они есть, даже если пустые)
    if (dataResult.titleData && dataResult.titleData[currentSlug] && dataResult.titleData[currentSlug].covers !== undefined) {
      userCovers = dataResult.titleData[currentSlug].covers;
      // Загружаем оригинальные обложки для сброса
      if (dataResult.originalTitleData && dataResult.originalTitleData[currentSlug] && dataResult.originalTitleData[currentSlug].covers) {
        originalCovers = dataResult.originalTitleData[currentSlug].covers.map(cover => cover.url || '');
      } else if (dataResult.titleData[currentSlug].metadata && dataResult.titleData[currentSlug].metadata.allCovers) {
        // Fallback: если originalTitleData нет, пробуем metadata.allCovers
        originalCovers = dataResult.titleData[currentSlug].metadata.allCovers.map(cover => cover.url || '');
      }
      renderCovers();
    }
    // Если пользовательских нет, проверяем оригинальные
    else if (dataResult.originalTitleData && dataResult.originalTitleData[currentSlug] && dataResult.originalTitleData[currentSlug].covers && dataResult.originalTitleData[currentSlug].covers.length > 0) {
      originalCovers = dataResult.originalTitleData[currentSlug].covers.map(cover => cover.url || '');
      userCovers = dataResult.originalTitleData[currentSlug].covers;
      renderCovers();
    }
    // Если нет в originalTitleData, пробуем metadata.allCovers
    else if (dataResult.titleData && dataResult.titleData[currentSlug] && dataResult.titleData[currentSlug].metadata && dataResult.titleData[currentSlug].metadata.allCovers && dataResult.titleData[currentSlug].metadata.allCovers.length > 0) {
      originalCovers = dataResult.titleData[currentSlug].metadata.allCovers.map(cover => cover.url || '');
      userCovers = dataResult.titleData[currentSlug].metadata.allCovers;
      renderCovers();
    }
    // Если нет никаких данных, показываем пустое состояние
    else {
      renderCovers();
    }
  } else {
    // Если currentSlug нет, показываем пустое состояние
    renderCovers();
  }
});

// Получение информации об изображении (разрешение и размер)
function getImageInfo(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      const sizeBytes = Math.round((dataUrl.length - 'data:image/jpeg;base64,'.length) * 3 / 4);
      
      let sizeStr;
      if (sizeBytes < 1024) {
        sizeStr = `${sizeBytes}B`;
      } else if (sizeBytes < 1024 * 1024) {
        sizeStr = `${Math.round(sizeBytes / 1024)}KB`;
      } else {
        sizeStr = `${(sizeBytes / (1024 * 1024)).toFixed(1)}MB`;
      }
      
      resolve(`${width}x${height}, ${sizeStr}`);
    };
    img.onerror = () => {
      resolve('');
    };
    img.src = dataUrl;
  });
}

// Вспомогательная функция для создания иконки загрузки
function createLoadingIcon() {
  const loadingIcon = document.createElement('div');
  loadingIcon.innerHTML = '<i class="fa-solid fa-image" style="font-size: 16px; color: #666;"></i>';
  loadingIcon.className = 'loading-icon';
  loadingIcon.style.display = 'flex';
  loadingIcon.style.alignItems = 'center';
  loadingIcon.style.justifyContent = 'center';
  loadingIcon.style.width = '100%';
  loadingIcon.style.height = '100%';
  loadingIcon.style.borderRadius = '8px';
  loadingIcon.style.backgroundColor = 'var(--bg-tertiary)';
  return loadingIcon;
}

// Вспомогательная функция для создания иконки ошибки
function createErrorIcon() {
  const errorIcon = document.createElement('div');
  errorIcon.innerHTML = '<i class="fa-solid fa-image" style="font-size: 16px; color: #666;"></i>';
  errorIcon.style.display = 'flex';
  errorIcon.style.alignItems = 'center';
  errorIcon.style.justifyContent = 'center';
  errorIcon.style.width = '100%';
  errorIcon.style.height = '100%';
  errorIcon.style.borderRadius = '8px';
  errorIcon.style.backgroundColor = 'var(--bg-tertiary)';
  return errorIcon;
}

// Вспомогательная функция для создания обёртки изображения
function createImgWrapper(hasImage = false) {
  const imgWrapper = document.createElement('div');
  imgWrapper.className = hasImage ? 'img-wrapper has-image' : 'img-wrapper';
  return imgWrapper;
}

// Вспомогательная функция для предотвращения перетаскивания
function preventDrag(element) {
  element.draggable = false;
  element.addEventListener('dragstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
}

// Создание одного элемента обложки
function createCoverItem(cover, index) {
  const item = document.createElement('div');
  item.className = 'cover-item';
  item.dataset.index = index;
  
  // Создаем handle для перетаскивания только если элементов больше 1
  if (userCovers.length > 1) {
    const dragHandle = document.createElement('div');
    dragHandle.className = 'drag-handle';
    item.appendChild(dragHandle);
  }
  
  // Внутренний контейнер для отступов
  const innerContainer = document.createElement('div');
  innerContainer.className = 'cover-item-inner';
  
  const preview = document.createElement('div');
  preview.className = 'cover-preview';
  
  const imageInfo = document.createElement('div');
  imageInfo.className = 'image-info';
  imageInfo.textContent = '';
  
  if (cover.type === 'url' && cover.url) {
    preview.classList.add('loading');
    
    const imgWrapper = createImgWrapper(false);
    const loadingIcon = createLoadingIcon();
    imgWrapper.appendChild(loadingIcon);
    
    const img = document.createElement('img');
    img.style.borderRadius = '8px';
    
    fetchImageWithBypass(cover.url).then(dataUrl => {
      if (dataUrl) {
        preview.classList.remove('loading');
        preview.classList.add('has-image');
        imgWrapper.classList.add('has-image');
        const imgContainer = createImgContainer(img);
        imgWrapper.appendChild(imgContainer);
        setupImage(img, dataUrl, preview, imgWrapper, imageInfo);
      } else {
        const loadingIcon = imgWrapper.querySelector('.loading-icon');
        if (loadingIcon) loadingIcon.remove();
        const errorIcon = createErrorIcon();
        imgWrapper.appendChild(errorIcon);
        preview.classList.remove('loading');
        preview.classList.add('error');
      }
    }).catch(() => {
      const loadingIcon = imgWrapper.querySelector('.loading-icon');
      if (loadingIcon) loadingIcon.remove();
      const errorIcon = createErrorIcon();
      imgWrapper.appendChild(errorIcon);
      preview.classList.remove('loading');
      preview.classList.add('error');
    });
    
    preview.appendChild(imgWrapper);
    preventDrag(img);
  } else if (cover.type === 'file' && cover.dataUrl) {
    preview.classList.add('loading');
    
    const imgWrapper = createImgWrapper(false);
    const loadingIcon = createLoadingIcon();
    imgWrapper.appendChild(loadingIcon);
    
    const img = document.createElement('img');
    setupImage(img, cover.dataUrl, preview, imgWrapper, imageInfo);
    const imgContainer = createImgContainer(img);
    imgWrapper.appendChild(imgContainer);
    preview.appendChild(imgWrapper);
    preventDrag(img);
  } else {
    const imgWrapper = createImgWrapper(false);
    const emptyIcon = createErrorIcon();
    imgWrapper.appendChild(emptyIcon);
    preview.appendChild(imgWrapper);
    preview.classList.add('empty');
  }
  
  const inputs = document.createElement('div');
  inputs.className = 'cover-inputs';
  
  const inputGroup = document.createElement('div');
  inputGroup.className = 'input-group';
  
  inputGroup.appendChild(imageInfo);
  
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.placeholder = 'URL обложки';
  urlInput.value = cover.url || '';
  preventDrag(urlInput);
  urlInput.onchange = (e) => {
    userCovers[index].url = e.target.value;
    userCovers[index].type = 'url';
    userCovers[index].dataUrl = null;
    updateCoverItem(index);
  };
  
  const fileBtn = document.createElement('button');
  fileBtn.className = 'btn-file';
  fileBtn.innerHTML = '<i class="fa-solid fa-folder-open"></i>';
  fileBtn.title = 'Выбрать файл';
  preventDrag(fileBtn);
  fileBtn.onclick = () => handleFileUpload(index);
  
  const urlGroup = document.createElement('div');
  urlGroup.className = 'url-group';
  
  urlGroup.appendChild(urlInput);
  urlGroup.appendChild(fileBtn);
  inputGroup.appendChild(urlGroup);
  inputs.appendChild(inputGroup);
  
  innerContainer.appendChild(preview);
  innerContainer.appendChild(inputs);
  
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn-delete';
  deleteBtn.textContent = '✕';
  preventDrag(deleteBtn);
  deleteBtn.onclick = () => {
    userCovers.splice(index, 1);
    removeCoverItem(index);
    notifyChanged();
  };
  
  innerContainer.appendChild(deleteBtn);
  
  item.appendChild(innerContainer);
  
  updateCoverItemHandlers(item, index);
  
  return item;
}

// Функция для обновления обработчиков событий элемента
function updateCoverItemHandlers(item, index) {
  const urlInput = item.querySelector('input[type="text"]');
  const fileBtn = item.querySelector('.btn-file');
  const deleteBtn = item.querySelector('.btn-delete');
  
  if (urlInput) {
    urlInput.onchange = (e) => {
      userCovers[index].url = e.target.value;
      userCovers[index].type = 'url';
      userCovers[index].dataUrl = null;
      updateCoverItem(index);
    };
  }
  
  if (fileBtn) {
    fileBtn.onclick = () => handleFileUpload(index);
  }
  
  if (deleteBtn) {
    deleteBtn.onclick = () => {
      userCovers.splice(index, 1);
      removeCoverItem(index);
      notifyChanged();
    };
  }
}

// Вспомогательная функция для настройки изображения
function setupImage(img, dataUrl, preview, imgWrapper, imageInfo) {
  img.style.borderRadius = '8px';
  img.src = dataUrl;
  
  const handleLoad = () => {
    const loadingIcon = imgWrapper.querySelector('.loading-icon');
    if (loadingIcon) loadingIcon.remove();
    img.classList.add('loaded');
    preview.classList.remove('loading');
    preview.classList.add('has-image');
    imgWrapper.classList.add('has-image');
  };
  
  if (img.complete) {
    handleLoad();
  } else {
    img.onload = handleLoad;
  }
  
  img.onclick = () => {
    const blob = dataUrlToBlob(dataUrl);
    const blobUrl = URL.createObjectURL(blob);
    window.open(blobUrl, '_blank');
  };
  preventDrag(img);
  if (imageInfo) {
    getImageInfo(dataUrl).then(info => {
      imageInfo.textContent = info;
    });
  }
}

// Вспомогательная функция для создания контейнера изображения
function createImgContainer(img) {
  const imgContainer = document.createElement('div');
  imgContainer.className = 'img-container';
  imgContainer.appendChild(img);
  return imgContainer;
}

// Обновление элемента обложки по индексу
function updateCoverItem(index) {
  const container = document.getElementById('covers-list');
  const oldItem = container.querySelector(`[data-index="${index}"]`);
  
  if (oldItem) {
    const newItem = createCoverItem(userCovers[index], index);
    container.replaceChild(newItem, oldItem);
  }
}

// Добавление одного элемента обложки
function addCoverItem(cover) {
  const container = document.getElementById('covers-list');
  const index = userCovers.length - 1;
  const item = createCoverItem(cover, index);
  container.appendChild(item);
  
  // Удаляем empty-state если он есть
  const emptyState = container.querySelector('.empty-state');
  if (emptyState) {
    emptyState.remove();
  }
  
  // Обновляем видимость ручек
  updateDragHandles();
}

// Удаление одного элемента обложки
function removeCoverItem(index) {
  const container = document.getElementById('covers-list');
  const item = container.querySelector(`[data-index="${index}"]`);
  
  if (item) {
    item.remove();
    
    // Обновляем индексы для всех оставшихся элементов
    const items = container.querySelectorAll('.cover-item');
    items.forEach((item, i) => {
      item.dataset.index = i;
      updateCoverItemHandlers(item, i);
    });
    
    // Если больше нет обложек, показываем empty-state
    if (userCovers.length === 0) {
      container.innerHTML = '<div class="empty-state">Нет обложек</div>';
    }
    
    updateCoverCount();
    
    // Обновляем видимость ручек
    updateDragHandles();
  }
}

// Обновление видимости ручек перетаскивания
function updateDragHandles() {
  const container = document.getElementById('covers-list');
  const items = container.querySelectorAll('.cover-item');
  
  items.forEach((item, index) => {
    let dragHandle = item.querySelector('.drag-handle');
    
    // Если элементов больше 1 и ручки нет, добавляем
    if (userCovers.length > 1 && !dragHandle) {
      dragHandle = document.createElement('div');
      dragHandle.className = 'drag-handle';
      item.insertBefore(dragHandle, item.firstChild);
    }
    // Если элементов 1 или меньше и ручка есть, удаляем
    else if (userCovers.length <= 1 && dragHandle) {
      dragHandle.remove();
    }
  });
}

// Рендер списка обложек
function renderCovers() {
  const container = document.getElementById('covers-list');
  
  
  if (userCovers.length === 0) {
    container.innerHTML = '<div class="empty-state">Нет обложек</div>';
    updateCoverCount();
    return;
  }
  
  container.innerHTML = '';
  
  userCovers.forEach((cover, index) => {
    const item = createCoverItem(cover, index);
    container.appendChild(item);
  });
  
  // Инициализируем SortableJS
  initSortable(disableDragAnimations);
  updateCoverCount();
}

// Обновление счётчика обложек
function updateCoverCount() {
  const countElement = document.getElementById('cover-count');
  if (countElement) {
    countElement.textContent = userCovers.length;
  }
}

// Инициализация SortableJS
function initSortable(disableDragAnimations = false) {
  const container = document.getElementById('covers-list');
  if (!container) return;
  
  // Если элементов меньше 2, не инициализируем drag-and-drop
  const items = container.querySelectorAll('.cover-item');
  if (items.length < 2) return;
  
  // Удаляем существующий Sortable если есть
  if (container.sortableInstance) {
    container.sortableInstance.destroy();
  }
  
  // Создаем новый Sortable
  container.sortableInstance = new Sortable(container, {
    animation: disableDragAnimations ? 0 : 150,
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    dragClass: 'sortable-drag',
    handle: '.drag-handle',
    onEnd: function(evt) {
      // Обновляем массив userCovers в соответствии с новым порядком
      updateCoversOrder();
      notifyChanged();
    }
  });
}

// Обновление массива userCovers в соответствии с новым порядком DOM элементов
function updateCoversOrder() {
  const container = document.getElementById('covers-list');
  const items = Array.from(container.querySelectorAll('.cover-item'));
  
  const newCovers = items.map(item => {
    const index = parseInt(item.dataset.index);
    return userCovers[index];
  });
  
  userCovers = newCovers;
  
  // Обновляем индексы в dataset
  items.forEach((item, i) => {
    item.dataset.index = i;
    updateCoverItemHandlers(item, i);
  });
}

// Обработка загрузки файла
function handleFileUpload(index) {
  const fileInput = document.getElementById('file-input');
  fileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        userCovers[index].dataUrl = event.target.result;
        userCovers[index].type = 'file';
        userCovers[index].url = file.name; // Добавляем название файла в поле URL
        updateCoverItem(index);
        notifyChanged();
      };
      reader.readAsDataURL(file);
    }
  };
  fileInput.click();
}

document.getElementById('btn-add').addEventListener('click', () => {
  // Всегда добавляем пустышку, чтобы пользователь сам решает что добавить
  userCovers.push({ url: '', type: 'url' });
  addCoverItem(userCovers[userCovers.length - 1]);
  initSortable(disableDragAnimations);
  updateCoverCount();
  
  // Прокручиваем к новому элементу
  const container = document.getElementById('covers-list');
  const newItem = container.lastElementChild;
  if (newItem) {
    newItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
});

// Сохранение обложек (автосохранение, enableAutosave)
async function saveCovers() {
  if (!currentSlug) return;
  
  const titleDataResult = await getTitleStore(['titleData']);
  const titleData = titleDataResult.titleData || {};
  
  // Инициализируем структуру если нет
  if (!titleData[currentSlug]) {
    titleData[currentSlug] = { chapters: null, metadata: {}, covers: [] };
  }
  
  // Пустая обложка из «Новая обложка» не сохраняется, пока не введён URL или не выбран файл
  const covers = userCovers.filter(cover => cover.url || cover.dataUrl);
  titleData[currentSlug].covers = covers;
  // Обновляем cover в metadata для совместимости
  if (!titleData[currentSlug].metadata) {
    titleData[currentSlug].metadata = {};
  }
  titleData[currentSlug].metadata.cover = covers.length > 0 ? (covers[0].url || covers[0].dataUrl) : '';

  // Обновляем timestamp кэша (продлеваем срок действия на 10 минут)
  titleData[currentSlug].cacheTimestamp = Date.now();

  await setTitleStore({ titleData });
}

// Сброс к значениям с сайта
document.getElementById('btn-reset').addEventListener('click', async () => {
  if (!currentSlug) return;

  // Сбрасываем обложки к значениям с сайта (originalCovers)
  if (originalCovers && originalCovers.length > 0) {
    userCovers = originalCovers.map(url => ({ url, type: 'url' }));
  } else {
    userCovers = [];
  }

  renderCovers();
  notifyChanged();
});

// Удаление всех обложек с двухэтапным подтверждением
let deleteAllTimeout = null;
document.getElementById('btn-delete-all').addEventListener('click', () => {
  const btn = document.getElementById('btn-delete-all');
  
  if (btn.textContent.includes('Уверены?')) {
    // Второй клик - подтверждение
    clearTimeout(deleteAllTimeout);
    deleteAllTimeout = null;
    
    // Удаляем все обложки
    userCovers = [];
    renderCovers();
    notifyChanged();
    
    // Сбрасываем кнопку
    btn.innerHTML = '<i class="fa-solid fa-trash"></i> Удалить все';
  } else {
    // Первый клик - показываем подтверждение
    btn.innerHTML = '<i class="fa-solid fa-trash"></i> Уверены?';
    
    // Таймаут 8 секунд для возврата в исходное состояние
    deleteAllTimeout = setTimeout(() => {
      btn.innerHTML = '<i class="fa-solid fa-trash"></i> Удалить все';
      deleteAllTimeout = null;
    }, 8000);
  }
});

enableAutosave({ save: saveCovers });
