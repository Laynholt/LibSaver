let userCovers = [];
let currentSlug = null;
let originalCovers = [];
let currentZoomLevel = 3;
const activeBlobUrls = new Set();


// Очистка созданных Blob URL при закрытии вкладки редактора
window.addEventListener('beforeunload', () => {
  for (const url of activeBlobUrls) {
    URL.revokeObjectURL(url);
  }
  activeBlobUrls.clear();
});

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
  
  // Загружаем сохранённый масштаб обложек (по умолчанию 3: 4 в строку)
  const storedZoom = await chrome.storage.local.get(['coversZoomLevel']);
  if (storedZoom.coversZoomLevel !== undefined) {
    currentZoomLevel = parseInt(storedZoom.coversZoomLevel, 10) || 3;
    if (currentZoomLevel < 1 || currentZoomLevel > 5) currentZoomLevel = 3;
  } else {
    currentZoomLevel = 3;
  }
  applyZoomLevel(currentZoomLevel);
  setupZoomControls();

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
  
  
  // Внутренний контейнер для отступов
  const innerContainer = document.createElement('div');
  innerContainer.className = 'cover-item-inner';
  
  const preview = document.createElement('div');
  preview.className = 'cover-preview';
  
  const imageInfo = document.createElement('div');
  imageInfo.className = 'image-info';
  
  const coverNumber = document.createElement('span');
  coverNumber.className = 'cover-number';
  coverNumber.textContent = '';
  
  const imageMeta = document.createElement('span');
  imageMeta.className = 'image-meta';
  imageMeta.textContent = '';
  
  imageInfo.appendChild(imageMeta);
  imageInfo.appendChild(coverNumber);
  
  if (cover.type === 'url' && cover.url) {
    preview.classList.add('loading');
    
    const imgWrapper = createImgWrapper(false);
    const loadingIcon = createLoadingIcon();
    imgWrapper.appendChild(loadingIcon);
    
    const img = document.createElement('img');
    
    fetchImageWithBypass(cover.url).then(dataUrl => {
      if (dataUrl) {
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
        if (preview._tippy) preview._tippy.destroy();
        updateCoverCount();
      }
    }).catch(() => {
      const loadingIcon = imgWrapper.querySelector('.loading-icon');
      if (loadingIcon) loadingIcon.remove();
      const errorIcon = createErrorIcon();
      imgWrapper.appendChild(errorIcon);
      preview.classList.remove('loading');
      preview.classList.add('error');
      if (preview._tippy) preview._tippy.destroy();
      updateCoverCount();
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

// Применение масштаба обложек (1: Список, 2: 5 в строку, 3: 4 в строку, 4: 3 в строку, 5: 2 в строку)
function applyZoomLevel(level) {
  currentZoomLevel = level;
  const container = document.getElementById('covers-list');
  const slider = document.getElementById('zoom-slider');
  const btnList = document.getElementById('zoom-btn-list');
  const btnGrid = document.getElementById('zoom-btn-grid');
  
  if (slider && parseInt(slider.value, 10) !== level) {
    slider.value = level;
  }
  
  if (btnList) btnList.classList.toggle('active', level === 1);
  if (btnGrid) btnGrid.classList.toggle('active', level === 5);
  
  if (!container) return;
  
  container.classList.remove('view-list', 'view-grid', 'view-grid-5', 'view-grid-4', 'view-grid-3', 'view-grid-2', 'view-grid-sm', 'view-grid-md', 'view-grid-lg');
  
  const pageContainer = container.closest('.container');
  if (level === 1) {
    container.classList.add('view-list');
    if (pageContainer) pageContainer.classList.add('mode-list');
  } else {
    container.classList.add('view-grid');
    if (pageContainer) pageContainer.classList.remove('mode-list');
    if (level === 2) {
      container.classList.add('view-grid-5', 'view-grid-sm');
    } else if (level === 3) {
      container.classList.add('view-grid-4', 'view-grid-md');
    } else if (level === 4) {
      container.classList.add('view-grid-3');
    } else if (level === 5) {
      container.classList.add('view-grid-2', 'view-grid-lg');
    }
  }
  
  initSortable(disableDragAnimations);
}

// Настройка элементов управления масштабом
function setupZoomControls() {
  const slider = document.getElementById('zoom-slider');
  const btnList = document.getElementById('zoom-btn-list');
  const btnGrid = document.getElementById('zoom-btn-grid');
  
  if (slider) {
    slider.value = currentZoomLevel;
    slider.addEventListener('input', (e) => {
      const level = parseInt(e.target.value, 10);
      applyZoomLevel(level);
      chrome.storage.local.set({ coversZoomLevel: level });
    });
  }
  
  if (btnList) {
    btnList.addEventListener('click', () => {
      const nextLevel = Math.max(1, currentZoomLevel - 1);
      applyZoomLevel(nextLevel);
      chrome.storage.local.set({ coversZoomLevel: nextLevel });
    });
  }
  
  if (btnGrid) {
    btnGrid.addEventListener('click', () => {
      const nextLevel = Math.min(5, currentZoomLevel + 1);
      applyZoomLevel(nextLevel);
      chrome.storage.local.set({ coversZoomLevel: nextLevel });
    });
  }
}

// Прикрепление Tippy к превью для всплывающего увеличенного изображения в режиме списка
function attachTippyPreview(preview, dataUrl) {
  if (!window.tippy || !dataUrl) return;
  if (preview._tippy) {
    preview._tippy.destroy();
  }
  
  const content = document.createElement('div');
  content.className = 'tippy-cover-preview';
  content.style.borderRadius = '8px';
  content.style.overflow = 'hidden';

  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = 'Превью обложки';
  img.style.display = 'block';
  content.appendChild(img);
  
  window.tippy(preview, {
    content,
    placement: 'right',
    trigger: 'mouseenter',
    interactive: false,
    theme: 'libsaver',
    animation: 'scale-subtle',
    duration: [150, 150],
    offset: [0, 14],
    hideOnClick: true,
    maxWidth: 'none',
    arrow: false,
    onShow() {
      // Показывать Tippy только в режиме списка (Zoom level 1)
      if (currentZoomLevel !== 1) {
        return false;
      }
    }
  });
}

// Вспомогательная функция для настройки изображения
function setupImage(img, dataUrl, preview, imgWrapper, imageInfo) {
  img.src = dataUrl;
  
  const handleLoad = () => {
    const loadingIcon = imgWrapper.querySelector('.loading-icon');
    if (loadingIcon) loadingIcon.remove();
    img.classList.add('loaded');
    preview.classList.remove('loading');
    preview.classList.add('has-image');
    imgWrapper.classList.add('has-image');
    updateCoverCount();
    attachTippyPreview(preview, dataUrl);
  };
  
  if (img.complete) {
    handleLoad();
  } else {
    img.onload = handleLoad;
  }
  
  img.onclick = () => {
    const blob = dataUrlToBlob(dataUrl);
    const blobUrl = URL.createObjectURL(blob);
    activeBlobUrls.add(blobUrl);
    window.open(blobUrl, '_blank');
    // Автоочистка через 2 минуты, когда вкладка уже загрузила картинку
    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
      activeBlobUrls.delete(blobUrl);
    }, 120000);
  };
  preventDrag(img);
  if (imageInfo) {
    getImageInfo(dataUrl).then(info => {
      const metaSpan = imageInfo.querySelector('.image-meta');
      if (metaSpan) {
        metaSpan.textContent = info;
      } else {
        imageInfo.textContent = info;
      }
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
    const preview = oldItem.querySelector('.cover-preview');
    if (preview && preview._tippy) {
      preview._tippy.destroy();
    }
    const newItem = createCoverItem(userCovers[index], index);
    container.replaceChild(newItem, oldItem);
    updateCoverCount();
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
  
  initSortable(disableDragAnimations);
}

// Удаление одного элемента обложки
function removeCoverItem(index) {
  const container = document.getElementById('covers-list');
  const item = container.querySelector(`[data-index="${index}"]`);
  
  if (item) {
    const preview = item.querySelector('.cover-preview');
    if (preview && preview._tippy) {
      preview._tippy.destroy();
    }
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
    
    initSortable(disableDragAnimations);
  }
}

// Рендер списка обложек
function renderCovers() {
  const container = document.getElementById('covers-list');
  
  
  const previews = container.querySelectorAll('.cover-preview');
  previews.forEach(p => {
    if (p._tippy) p._tippy.destroy();
  });

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

// Обновление счётчика и номеров действующих обложек
function updateCoverCount() {
  const container = document.getElementById('covers-list');
  if (!container) return;
  
  const items = container.querySelectorAll('.cover-item');
  let loadedCount = 0;
  
  items.forEach(item => {
    const preview = item.querySelector('.cover-preview');
    const isLoaded = preview && preview.classList.contains('has-image');
    const coverNumber = item.querySelector('.cover-number');
    const imageInfo = item.querySelector('.image-info');
    
    if (isLoaded) {
      loadedCount++;
      if (coverNumber) {
        coverNumber.textContent = `#${loadedCount}`;
      }
      if (imageInfo) {
        imageInfo.style.display = 'flex';
      }
    } else {
      if (coverNumber) {
        coverNumber.textContent = '';
      }
      if (imageInfo) {
        imageInfo.style.display = 'none';
      }
    }
  });
  
  const countElement = document.getElementById('cover-count');
  if (countElement) {
    countElement.textContent = loadedCount;
  }
}

// Инициализация SortableJS
function initSortable(disableDragAnimations = false) {
  const container = document.getElementById('covers-list');
  if (!container) return;
  
  // Если элементов меньше 2, не инициализируем drag-and-drop
  const items = container.querySelectorAll('.cover-item');
  if (items.length < 2) {
    if (container.sortableInstance) {
      container.sortableInstance.destroy();
      container.sortableInstance = null;
    }
    return;
  }
  
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
    filter: 'input, button, .btn-file, .btn-delete',
    preventOnFilter: false,
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
  updateCoverCount();
}

// Обработка загрузки файла
function handleFileUpload(index) {
  const fileInput = document.getElementById('file-input');
  fileInput.value = ''; // Сбрасываем значение, чтобы можно было повторно выбрать тот же файл
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

  // Пустая обложка из «Новая обложка» не сохраняется, пока не введён URL или не выбран файл
  const covers = userCovers.filter(cover => cover.url || cover.dataUrl);
  await updateTitleStore(['titleData'], currentSlug, ({ titleData }) => {
    const title = titleData[currentSlug] ??= { chapters: null, metadata: {}, covers: [] };
    title.covers = covers;
    // Обновляем cover в metadata для совместимости
    title.metadata ??= {};
    title.metadata.cover = covers.length > 0 ? (covers[0].url || covers[0].dataUrl) : '';
    // Обновляем timestamp кэша (продлеваем срок действия на 10 минут)
    title.cacheTimestamp = Date.now();
  });
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
