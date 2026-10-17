let downloadData = null;
let selectedChapterIds = new Set();
let chaptersByVolume = {};
let metadataFields = {};
let coverQuality = 'ORIGINAL';
let tippyInstances = [];
let tooltipContents = [];

// Функция получения имени переводчика
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

// Функция для обновления темы в tippy
function updateTippyTheme() {
  const isDark = !document.documentElement.hasAttribute('data-theme');

  // Обновляем backgroundColor всех tooltipContent
  tooltipContents.forEach(tooltipContent => {
    tooltipContent.style.backgroundColor = isDark ? 'rgba(10, 10, 10, 0.95)' : 'rgba(255, 255, 255, 0.95)';
  });

  // Обновляем theme всех tippy экземпляров
  tippyInstances.forEach(instance => {
    instance.setProps({ theme: isDark ? 'dark' : 'light' });
  });
}

// Слушатель сообщений для обновления темы (используем общий из theme.js)
setupThemeMessageListener(updateTippyTheme);

// Функция для загрузки изображения через background script (обход защиты)
async function fetchImageWithBypass(url) {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'fetchImage', url: url });
    if (response && response.success) {
      return response.data; // dataURL
    } else {
      console.error('[prepare.js] Failed to fetch image:', response?.error);
      return null;
    }
  } catch (e) {
    console.error('[prepare.js] Error fetching image:', e);
    return null;
  }
}

// Настройка Tippy для превью обложки
function setupTippyPreview(preview, imageUrl) {
  // Создаем контейнер для контента tooltip
  const tooltipContent = document.createElement('div');
  tooltipContent.style.display = 'flex';
  tooltipContent.style.alignItems = 'center';
  tooltipContent.style.justifyContent = 'center';
  const isDark = !document.documentElement.hasAttribute('data-theme');
  tooltipContent.style.backgroundColor = isDark ? 'rgba(10, 10, 10, 0.95)' : 'rgba(255, 255, 255, 0.95)';

  // Показываем иконку загрузки по умолчанию
  const loadingIcon = document.createElement('div');
  loadingIcon.innerHTML = '<i class="fa-solid fa-image" style="font-size: 48px; color: #666;"></i>';
  loadingIcon.className = 'tooltip-loading-icon';
  loadingIcon.style.width = '200px';
  loadingIcon.style.height = '300px';
  loadingIcon.style.display = 'flex';
  loadingIcon.style.alignItems = 'center';
  loadingIcon.style.justifyContent = 'center';
  tooltipContent.appendChild(loadingIcon);

  // Загружаем изображение для tooltip
  if (imageUrl.startsWith('data:')) {
    const tooltipImg = document.createElement('img');
    tooltipImg.style.maxWidth = '476px';
    tooltipImg.style.maxHeight = '476px';
    tooltipImg.style.objectFit = 'contain';
    tooltipImg.style.display = 'none';
    tooltipImg.style.borderRadius = '3px';
    tooltipImg.src = imageUrl;
    tooltipImg.onload = () => {
      const loadingIcon = tooltipContent.querySelector('.tooltip-loading-icon');
      if (loadingIcon) loadingIcon.remove();
      tooltipContent.appendChild(tooltipImg);
      tooltipImg.style.display = 'block';
    };
  } else {
    fetchImageWithBypass(imageUrl).then(dataUrl => {
      if (dataUrl) {
        const tooltipImg = document.createElement('img');
        tooltipImg.style.maxWidth = '476px';
        tooltipImg.style.maxHeight = '476px';
        tooltipImg.style.objectFit = 'contain';
        tooltipImg.style.display = 'none';
        tooltipImg.style.borderRadius = '3px';
        tooltipImg.src = dataUrl;
        tooltipImg.onload = () => {
          const loadingIcon = tooltipContent.querySelector('.tooltip-loading-icon');
          if (loadingIcon) loadingIcon.remove();
          tooltipContent.appendChild(tooltipImg);
          tooltipImg.style.display = 'block';
        };
      } else {
        // Используем иконку ошибки вместо текста
        const loadingIcon = tooltipContent.querySelector('.tooltip-loading-icon');
        if (loadingIcon) loadingIcon.remove();
        const errorIcon = document.createElement('div');
        errorIcon.innerHTML = '<i class="fa-solid fa-image" style="font-size: 48px; color: #666;"></i>';
        errorIcon.style.display = 'flex';
        errorIcon.style.alignItems = 'center';
        errorIcon.style.justifyContent = 'center';
        errorIcon.style.width = '200px';
        errorIcon.style.height = '300px';
        errorIcon.style.backgroundColor = isDark ? 'rgba(10, 10, 10, 0.95)' : 'rgba(255, 255, 255, 0.95)';
        tooltipContent.appendChild(errorIcon);
      }
    }).catch(() => {
      // Используем иконку ошибки вместо текста
      const loadingIcon = tooltipContent.querySelector('.tooltip-loading-icon');
      if (loadingIcon) loadingIcon.remove();
      const errorIcon = document.createElement('div');
      errorIcon.innerHTML = '<i class="fa-solid fa-image" style="font-size: 48px; color: #666;"></i>';
      errorIcon.style.display = 'flex';
      errorIcon.style.alignItems = 'center';
      errorIcon.style.justifyContent = 'center';
      errorIcon.style.width = '476px';
      errorIcon.style.height = '476px';
      errorIcon.style.backgroundColor = isDark ? 'rgba(10, 10, 10, 0.95)' : 'rgba(255, 255, 255, 0.95)';
      tooltipContent.appendChild(errorIcon);
    });
  }

  const instance = tippy(preview, {
    content: tooltipContent,
    placement: 'right',
    trigger: 'mouseenter',
    interactive: false,
    theme: isDark ? 'dark' : 'light',
    animation: 'scale-subtle',
    duration: [200, 200],
    offset: [20, 10],
    hideOnClick: true,
    maxWidth: 'none',
    arrow: false,
    onShow(instance) {
      instance.popper.style.transition = 'opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1)';
    },
    popperOptions: {
      strategy: 'fixed',
      modifiers: [
        {
          name: 'preventOverflow',
          options: {
            padding: { top: 50, bottom: 10, left: 10, right: 10 },
          },
        },
      ],
    },
  });

  tippyInstances.push(instance);
  tooltipContents.push(tooltipContent);
}

document.addEventListener('DOMContentLoaded', async () => {
  // Регистрируем окно подготовки
  await chrome.storage.local.set({ currentOpenWindow: 'prepare' });

  // Очищаем регистрацию при закрытии
  window.addEventListener('beforeunload', async () => {
    await chrome.storage.local.remove('currentOpenWindow');
    // НЕ удаляем downloadData чтобы F5 работал для тестирования
    // Очистка происходит в popup.js при открытии popup
  });

  // Применяем акцентный цвет по сайту (используем функцию из theme.js)
  const result = await chrome.storage.local.get(['sourceUrl']);
  const sourceUrl = result.sourceUrl;
  if (sourceUrl) {
    window.applySiteAccent(sourceUrl);
  }

  await loadDownloadData();
  renderBookInfo();
  renderCovers();
  renderSettings();
  groupChaptersByVolume();
  renderChaptersList();
  setupEventListeners();
});

async function loadDownloadData() {
  const result = await chrome.storage.local.get(['downloadData', 'metadataFields', 'coverQuality']);
  if (!result.downloadData) {
    console.error('Download data not found');
    chrome.storage.local.remove('downloadData');
    window.close();
    return;
  }
  downloadData = result.downloadData;
  
  // Загружаем качество обложек
  coverQuality = result.coverQuality || 'ORIGINAL';
  
  // Загружаем настройки полей метаданных
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
  
  const chapters = downloadData.chapters || [];
  
  // Загружаем пользовательские данные для получения изменённых обложек, метаданных и переводчиков
  const slug = downloadData.slug;
  if (slug) {
    const titleDataResult = await getTitleStore(['titleData'], slug);
    const titleData = titleDataResult.titleData || {};
    
    // Если есть пользовательские обложки, используем их (даже если пустые)
    if (titleData[slug] && titleData[slug].covers !== undefined) {
      downloadData.allCovers = titleData[slug].covers;
    }
    
    // Если есть пользовательские метаданные, используем их
    if (titleData[slug] && titleData[slug].metadata) {
      downloadData.metadata = { ...downloadData.metadata, ...titleData[slug].metadata };
    }
    
    // Загружаем данные о переводчиках
    if (titleData[slug]) {
      downloadData.chapterBranchOverrides = titleData[slug].chapterBranchOverrides || {};
      downloadData.translatorPriority = titleData[slug].translatorPriority || [];

      // Загружаем сохранённые выбранные главы для этого тайтла
      if (titleData[slug].selectedChapterIds) {
        selectedChapterIds = new Set(titleData[slug].selectedChapterIds);
      } else {
        // По умолчанию выбираем все главы
        chapters.forEach(ch => selectedChapterIds.add(ch.id));
      }
    } else {
      // Если нет данных для этого slug, выбираем все главы
      chapters.forEach(ch => selectedChapterIds.add(ch.id));
    }
  } else {
    // Если нет slug, выбираем все главы
    chapters.forEach(ch => selectedChapterIds.add(ch.id));
  }
  
  // Вычисляем branches из данных глав (как в chapters.js)
  downloadData.branches = {};
  chapters.forEach(ch => {
      // Нормализуем branches: если это объект, конвертируем в массив
      let branchesList = ch.branches;
      if (branchesList && !Array.isArray(branchesList)) {
        branchesList = Object.values(branchesList);
      }
      
      if (branchesList && Array.isArray(branchesList) && branchesList.length > 0) {
        branchesList.forEach(branch => {
          const branchId = branch.branch_id === null ? 'null' : branch.branch_id;
          let teamId = 'unknown';
          if (branch.teams && branch.teams[0]) {
            teamId = branch.teams[0].id;
          } else if (branch.team) {
            teamId = branch.team.id;
          }
          const translatorKey = `${branchId}_${teamId}`;
          const translatorName = getTranslatorName(branch);
          
          if (!downloadData.branches[translatorKey]) {
            downloadData.branches[translatorKey] = translatorName;
          }
        });
      } else {
        const branchId = ch.branchId === null ? 'null' : ch.branchId;
        const teamName = ch.branchTeamName || 'Основной перевод';
        const translatorKey = `${branchId}_unknown`;
        if (!downloadData.branches[translatorKey]) {
          downloadData.branches[translatorKey] = teamName;
        }
      }
    });
}

function renderBookInfo() {
  const metadata = downloadData.metadata;
  const metadataContent = document.getElementById('metadata-content');
  const metadataZone = document.querySelector('.zone-metadata');

  if (!metadata || !metadataContent || !metadataZone) return;

  // Загружаем переименованные названия полей и порядок из storage
  chrome.storage.local.get(['fieldLabels', 'metadataFieldOrder'], (result) => {
    const fieldLabels = result.fieldLabels || {};
    const metadataFieldOrder = result.metadataFieldOrder || null;

    // Определяем все поля с их метками и соответствующими ключами настроек
    const fields = [
      { key: 'titleRu', label: 'Название (RU)', settingKey: 'title-ru' },
      { key: 'titleEn', label: 'Название (EN)', settingKey: 'title-en' },
      { key: 'titleOriginal', label: 'Название (SRC)', settingKey: 'title-original' },
      { key: 'titleAlt', label: 'Название (ALT)', settingKey: 'title-alt' },
      { key: 'author', label: 'Автор', settingKey: 'author' },
      { key: 'artist', label: 'Художник', settingKey: 'artist' },
      { key: 'year', label: 'Год', settingKey: 'year' },
      { key: 'status', label: 'Статус', settingKey: 'status' },
      { key: 'country', label: 'Тип', settingKey: 'country' },
      { key: 'releaseFormat', label: 'Формат', settingKey: 'release-format' },
      { key: 'publisher', label: 'Издательство', settingKey: 'publisher' },
      { key: 'ageRestriction', label: 'Возрастной рейтинг', settingKey: 'age-restriction' },
      { key: 'description', label: 'Описание', settingKey: 'description' },
      { key: 'genres', label: 'Жанры', settingKey: 'genres' },
      { key: 'tags', label: 'Метки', settingKey: 'tags' }
    ];

    // Сортируем поля по сохранённому порядку если есть
    if (metadataFieldOrder && metadataFieldOrder.length > 0) {
      fields.sort((a, b) => {
        const indexA = metadataFieldOrder.indexOf(a.settingKey);
        const indexB = metadataFieldOrder.indexOf(b.settingKey);
        // Если поле не в порядке - ставим в конец
        if (indexA === -1 && indexB === -1) return 0;
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        return indexA - indexB;
      });
    }
    
    // Очищаем контейнер
    metadataContent.innerHTML = '';
    
    let hasAnyField = false;
    
    fields.forEach(field => {
      // Проверяем, включено ли поле в настройках
      if (metadataFields[field.settingKey] === false) {
        return; // Пропускаем отключенные поля
      }
      
      let value = metadata[field.key];
      
      // Обработка массивов (жанры, метки)
      if (value && Array.isArray(value)) {
        value = value.join(', ');
      }
      
      // Если значение есть и не пустое, добавляем поле
      if (value && value.trim() !== '') {
        hasAnyField = true;
        
        const fieldDiv = document.createElement('div');
        fieldDiv.className = 'field';
        
        const fieldHeader = document.createElement('div');
        fieldHeader.className = 'field-header';
        // Используем переименованное название если есть, иначе дефолтное
        const displayLabel = fieldLabels[field.settingKey] || field.label;
        fieldHeader.innerHTML = `<label>${displayLabel}</label>`;
        
        const fieldValue = document.createElement('div');
        fieldValue.className = 'field-value';
        fieldValue.dataset.field = field.settingKey;
        fieldValue.textContent = value;
        
        fieldDiv.appendChild(fieldHeader);
        fieldDiv.appendChild(fieldValue);
        metadataContent.appendChild(fieldDiv);
      }
    });
    
    // Если нет ни одного поля, скрываем зону
    if (!hasAnyField) {
      metadataZone.style.display = 'none';
    } else {
      metadataZone.style.display = 'flex';
    }
  });
}

function renderCovers() {
  const coversGallery = document.getElementById('covers-gallery');
  const coversZone = document.querySelector('.zone-covers');
  
  if (!coversGallery || !coversZone) return;
  
  // Если качество обложек NONE, скрываем зону
  if (coverQuality === 'NONE') {
    coversZone.style.display = 'none';
    return;
  }
  
  // Получаем обложки из разных источников
  let allCovers = downloadData.allCovers;
  const hasUserCovers = downloadData.allCovers !== undefined;
  
  // Если пользовательских обложек нет, пробуем metadata.covers
  if (!hasUserCovers && downloadData.metadata && downloadData.metadata.covers) {
    allCovers = downloadData.metadata.covers;
  }
  
  // Если всё ещё нет обложек, используем единичную обложку (только если нет пользовательских)
  if (!hasUserCovers && (!allCovers || allCovers.length === 0)) {
    const singleCover = downloadData.metadata?.cover || downloadData.originalCover || '';
    if (singleCover) {
      allCovers = [singleCover];
    }
  }
  
  if (!allCovers || allCovers.length === 0) {
    coversZone.style.display = 'none';
    return;
  }
  
  coversZone.style.display = 'flex';
  
  // Отображаем галерею обложек
  coversGallery.innerHTML = '';
  allCovers.forEach((cover, index) => {
    let coverUrl = cover;
    let coverType = 'url';
    
    if (typeof cover === 'object' && cover !== null) {
      coverUrl = cover.dataUrl || cover.url || cover.orig || cover.default || cover.cover || '';
      coverType = cover.type || (cover.dataUrl ? 'file' : 'url');
    }
    
    if (!coverUrl || typeof coverUrl !== 'string') return;
    
    // Создаем миниатюру для галереи
    const thumbnail = document.createElement('div');
    thumbnail.className = 'cover-thumbnail';
    
    const imgWrapper = document.createElement('div');
    imgWrapper.className = 'img-wrapper';
    
    const loadingIcon = document.createElement('div');
    loadingIcon.innerHTML = '<i class="fa-solid fa-image" style="font-size: 16px; color: #666;"></i>';
    loadingIcon.className = 'loading-icon';
    loadingIcon.style.display = 'flex';
    loadingIcon.style.alignItems = 'center';
    loadingIcon.style.justifyContent = 'center';
    loadingIcon.style.width = '100%';
    loadingIcon.style.height = '100%';
    loadingIcon.style.borderRadius = '3px';
    loadingIcon.style.backgroundColor = 'var(--bg-tertiary)';
    imgWrapper.appendChild(loadingIcon);
    
    const imgContainer = document.createElement('div');
    imgContainer.className = 'img-container';
    
    const img = document.createElement('img');
    img.style.borderRadius = '3px';
    img.style.maxWidth = '100%';
    img.style.maxHeight = '100%';
    img.style.objectFit = 'contain';
    img.style.display = 'none';
    
    imgContainer.appendChild(img);
    imgWrapper.appendChild(imgContainer);
    thumbnail.appendChild(imgWrapper);
    
    // Загружаем изображение
    if (coverUrl.startsWith('data:')) {
      // Data URL - локальное изображение
      img.src = coverUrl;
      img.onload = () => {
        const loadingIcon = imgWrapper.querySelector('.loading-icon');
        if (loadingIcon) loadingIcon.remove();
        img.classList.add('loaded');
        img.style.display = 'block';
        imgWrapper.classList.add('has-image');
        thumbnail.style.backgroundColor = 'var(--bg-tertiary)';
      };
      img.onerror = () => {
        console.error('[prepare.js] Failed to load data URL image:', coverUrl.substring(0, 50) + '...');
        const loadingIcon = imgWrapper.querySelector('.loading-icon');
        if (loadingIcon) loadingIcon.remove();
        const errorIcon = document.createElement('div');
        errorIcon.innerHTML = '<i class="fa-solid fa-image" style="font-size: 16px; color: #666;"></i>';
        errorIcon.style.display = 'flex';
        errorIcon.style.alignItems = 'center';
        errorIcon.style.justifyContent = 'center';
        errorIcon.style.width = '100%';
        errorIcon.style.height = '100%';
        errorIcon.style.borderRadius = '3px';
        errorIcon.style.backgroundColor = 'var(--bg-tertiary)';
        imgWrapper.appendChild(errorIcon);
        thumbnail.classList.add('error');
      };
      setupTippyPreview(thumbnail, coverUrl);
      
      // При клике открываем в отдельном окне
      thumbnail.onclick = () => openCoverInNewWindow(coverUrl, coverType);
    } else if (coverUrl.startsWith('http://') || coverUrl.startsWith('https://')) {
      // Внешний URL - загружаем через bypass
      fetchImageWithBypass(coverUrl).then(dataUrl => {
        if (dataUrl) {
          img.src = dataUrl;
          img.onload = () => {
            const loadingIcon = imgWrapper.querySelector('.loading-icon');
            if (loadingIcon) loadingIcon.remove();
            img.classList.add('loaded');
            img.style.display = 'block';
            imgWrapper.classList.add('has-image');
            thumbnail.style.backgroundColor = 'var(--bg-tertiary)';
          };
          setupTippyPreview(thumbnail, coverUrl);
          thumbnail.onclick = () => openCoverInNewWindow(coverUrl, coverType);
        } else {
          console.error('[prepare.js] Failed to fetch image:', coverUrl);
          const loadingIcon = imgWrapper.querySelector('.loading-icon');
          if (loadingIcon) loadingIcon.remove();
          const errorIcon = document.createElement('div');
          errorIcon.innerHTML = '<i class="fa-solid fa-image" style="font-size: 16px; color: #666;"></i>';
          errorIcon.style.display = 'flex';
          errorIcon.style.alignItems = 'center';
          errorIcon.style.justifyContent = 'center';
          errorIcon.style.width = '100%';
          errorIcon.style.height = '100%';
          errorIcon.style.borderRadius = '3px';
        errorIcon.style.backgroundColor = 'var(--bg-tertiary)';
          imgWrapper.appendChild(errorIcon);
          thumbnail.classList.add('error');
        }
      }).catch((error) => {
        console.error('[prepare.js] Failed to fetch image with error:', error, coverUrl);
        const loadingIcon = imgWrapper.querySelector('.loading-icon');
        if (loadingIcon) loadingIcon.remove();
        const errorIcon = document.createElement('div');
        errorIcon.innerHTML = '<i class="fa-solid fa-image" style="font-size: 16px; color: #666;"></i>';
        errorIcon.style.display = 'flex';
        errorIcon.style.alignItems = 'center';
        errorIcon.style.justifyContent = 'center';
        errorIcon.style.width = '100%';
        errorIcon.style.height = '100%';
        errorIcon.style.borderRadius = '3px';
        errorIcon.style.backgroundColor = 'var(--bg-tertiary)';
        imgWrapper.appendChild(errorIcon);
        thumbnail.classList.add('error');
      });
    } else {
      // Локальный файл (относительный путь) - не поддерживается в prepare
      console.warn('[prepare.js] Local file path not supported in prepare:', coverUrl);
      const loadingIcon = imgWrapper.querySelector('.loading-icon');
      if (loadingIcon) loadingIcon.remove();
      const errorIcon = document.createElement('div');
      errorIcon.innerHTML = '<i class="fa-solid fa-image" style="font-size: 16px; color: #666;"></i>';
      errorIcon.style.display = 'flex';
      errorIcon.style.alignItems = 'center';
      errorIcon.style.justifyContent = 'center';
      errorIcon.style.width = '100%';
      errorIcon.style.height = '100%';
      errorIcon.style.borderRadius = '3px';
      errorIcon.style.backgroundColor = 'var(--bg-tertiary)';
      imgWrapper.appendChild(errorIcon);
      thumbnail.classList.add('error');
    }
    
    coversGallery.appendChild(thumbnail);
  });
}

async function openCoverInNewWindow(coverUrl, coverType) {
  let imageUrl = coverUrl;
  
  // Если это внешний URL, загружаем через bypass
  if (coverType !== 'file' && !coverUrl.startsWith('data:')) {
    const dataUrl = await fetchImageWithBypass(coverUrl);
    if (dataUrl) {
      imageUrl = dataUrl;
    } else {
      console.error('[prepare.js] Failed to fetch image for new window:', coverUrl);
      return;
    }
  }
  
  const newWindow = window.open('', '_blank');
  newWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Обложка</title>
      <style>
        body {
          margin: 0;
          padding: 0;
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          background-color: #0a0a0a;
        }
        img {
          max-width: 100%;
          max-height: 100vh;
          object-fit: contain;
        }
      </style>
    </head>
    <body>
      <img src="${imageUrl}" alt="Обложка">
    </body>
    </html>
  `);
  newWindow.document.close();
}

function renderSettings() {
  const qualityMap = {
    'ORIGINAL': 'Без сжатия',
    '2K': '1600px',
    'QHD': '1440px',
    'FHD': '1080px',
    'HD': '720px',
    'qHD': '540px',
    'SD': '480px',
    'NONE': 'Отключено'
  };
  
  const imageQuality = downloadData.quality || 'ORIGINAL';
  const coverQuality = downloadData.coverQuality || 'ORIGINAL';
  
  const imageQualityDisplay = document.getElementById('image-quality-display');
  const coverQualityDisplay = document.getElementById('cover-quality-display');
  
  if (imageQualityDisplay) {
    imageQualityDisplay.textContent = qualityMap[imageQuality] || 'Без сжатия';
  }
  if (coverQualityDisplay) {
    coverQualityDisplay.textContent = qualityMap[coverQuality] || 'Без сжатия';
  }
}

function restoreDownloadControls() {
  enableControls();
  enableVolumeCheckboxes();
  document.querySelectorAll('.chapter-checkbox').forEach(checkbox => {
    checkbox.disabled = false;
  });
  const button = document.getElementById('btn-start-download');
  button.disabled = false;
  button.style.display = '';
}

function disableChapterCheckboxes() {
  // Отключаем все чекбоксы глав
  const chapterCheckboxes = document.querySelectorAll('.chapter-checkbox');
  chapterCheckboxes.forEach(checkbox => {
    checkbox.disabled = true;
  });
}

function disableVolumeCheckboxes() {
  const volumeCheckboxes = document.querySelectorAll('.volume-checkbox');
  volumeCheckboxes.forEach(checkbox => {
    checkbox.disabled = true;
    checkbox.style.cursor = 'default';
    // Добавляем класс disabled к родительскому checkbox-group
    const checkboxGroup = checkbox.closest('.checkbox-group');
    if (checkboxGroup) {
      checkboxGroup.classList.add('checkbox-group-disabled');
    }
  });
}

function disableControls() {
  for (const id of ['format-select', 'server-select', 'text-only-checkbox']) {
    const control = document.getElementById(id);
    if (control) control.disabled = true;
  }
}

function enableControls() {
  for (const id of ['format-select', 'server-select', 'text-only-checkbox']) {
    const control = document.getElementById(id);
    if (control) control.disabled = false;
  }
}

function enableVolumeCheckboxes() {
  const volumeCheckboxes = document.querySelectorAll('.volume-checkbox');
  volumeCheckboxes.forEach(checkbox => {
    checkbox.disabled = false;
    checkbox.style.cursor = 'pointer';
    // Удаляем класс disabled из родительского checkbox-group
    const checkboxGroup = checkbox.closest('.checkbox-group');
    if (checkboxGroup) {
      checkboxGroup.classList.remove('checkbox-group-disabled');
    }
  });
}

// «Ускорить» можно переключить в разделе «Загрузки»: галочка здесь следует за storage
function followSpeedMode(changes) {
  const checkbox = document.getElementById('speed-mode-checkbox');
  if (checkbox && changes.speedMode) checkbox.checked = !!changes.speedMode.newValue;
}

// Слушаем изменения качества в реальном времени
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    followSpeedMode(changes);
    if (changes.imageQuality || changes.coverQuality) {
      // Обновляем downloadData
      if (changes.imageQuality) {
        downloadData.quality = changes.imageQuality.newValue;
      }
      if (changes.coverQuality) {
        downloadData.coverQuality = changes.coverQuality.newValue;
      }
      // Перерисовываем настройки
      renderSettings();
    }
  }
});

function groupChaptersByVolume() {
  const chapters = downloadData.chapters || [];
  chaptersByVolume = {};
  
  chapters.forEach(ch => {
    const volume = ch.volume || '1';
    if (!chaptersByVolume[volume]) {
      chaptersByVolume[volume] = [];
    }
    chaptersByVolume[volume].push(ch);
  });
  
  Object.keys(chaptersByVolume).forEach(volume => {
    chaptersByVolume[volume].sort((a, b) => {
      const numA = parseFloat(a.number) || 0;
      const numB = parseFloat(b.number) || 0;
      return numA - numB;
    });
  });
}

function renderChaptersList() {
  const chaptersList = document.getElementById('chapters-list');
  const chaptersZone = document.querySelector('.zone-chapters');

  if (!chaptersList || !chaptersZone) return;

  chaptersList.innerHTML = '';

  const sortedVolumes = Object.keys(chaptersByVolume).sort((a, b) => parseFloat(a) - parseFloat(b));

  // Если нет глав, скрываем зону
  if (sortedVolumes.length === 0) {
    chaptersZone.style.display = 'none';
    return;
  }

  chaptersZone.style.display = 'flex';

  sortedVolumes.forEach(volume => {
    const volumeDiv = document.createElement('div');
    volumeDiv.className = 'volume-group';
    volumeDiv.dataset.volume = volume;

    const volumeHeader = document.createElement('div');
    volumeHeader.className = 'volume-header';
    volumeHeader.innerHTML = `
      <label class="checkbox-group">
        <input type="checkbox" class="volume-checkbox" id="volume-${volume}" checked />
        <span class="control__indicator" data-type="checkbox">
          <svg class="svg-inline--fa fa-square-check fa-fw" aria-hidden="true" focusable="false" data-prefix="fas" data-icon="square-check" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512" data-state="checked"><path fill="currentColor" d="M64 32C28.7 32 0 60.7 0 96L0 416c0 35.3 28.7 64 64 64l320 0c35.3 0 64-28.7 64-64l0-320c0-35.3-28.7-64-64-64L64 32zM337 209L209 337c-9.4 9.4-24.6 9.4-33.9 0l-64-64c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0l47 47L303 175c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9z"></path></svg>
          <svg class="svg-inline--fa fa-square fa-fw" aria-hidden="true" focusable="false" data-prefix="far" data-icon="square" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512" data-state="default"><path fill="currentColor" d="M384 80c8.8 0 16 7.2 16 16l0 320c0 8.8-7.2 16-16 16L64 432c-8.8 0-16-7.2-16-16L48 96c0-8.8 7.2-16 16-16l320 0zM64 32C28.7 32 0 60.7 0 96L0 416c0 35.3 28.7 64 64 64l320 0c35.3 0 64-28.7 64-64l0-320c0-35.3-28.7-64-64-64L64 32z"></path></svg>
        </span>
      </label>
      <i class="fa-solid fa-chevron-right volume-toggle-icon"></i>
      <span class="volume-label">Том ${volume}</span>
      <span class="chapter-count">${chaptersByVolume[volume].length}</span>
    `;

    const volumeChapters = document.createElement('div');
    volumeChapters.className = 'volume-chapters collapsed';
    volumeChapters.dataset.volume = volume;

    chaptersByVolume[volume].forEach(ch => {
      const chapterDiv = document.createElement('div');
      chapterDiv.className = 'chapter-item';
      chapterDiv.dataset.chapterId = ch.id;

      // Получаем переводчика для главы
      let translatorName = '';

      // Сначала проверяем есть ли override
      if (downloadData.chapterBranchOverrides && downloadData.chapterBranchOverrides[ch.id]) {
        const translatorKey = downloadData.chapterBranchOverrides[ch.id];
        // Ищем имя переводчика по translatorKey из branches
        if (downloadData.branches && downloadData.branches[translatorKey]) {
          translatorName = downloadData.branches[translatorKey];
        }
      }
      // Если нет override, пробуем получить из данных главы
      else if (ch.translator) {
        translatorName = ch.translator;
      }
      else if (ch.branchTeamName) {
        translatorName = ch.branchTeamName;
      }
      // Если всё ещё нет переводчика, пробуем получить из branches главы
      else if (ch.branches && Array.isArray(ch.branches) && ch.branches.length > 0) {
        const firstBranch = ch.branches[0];
        translatorName = getTranslatorName(firstBranch);
      }

      const translatorHtml = translatorName ? `<span class="chapter-translator">${translatorName}</span>` : '';

      chapterDiv.innerHTML = `
        <label class="checkbox-group">
          <input type="checkbox" class="chapter-checkbox" id="chapter-${ch.id}" checked />
          <span class="control__indicator" data-type="checkbox">
            <svg class="svg-inline--fa fa-square-check fa-fw" aria-hidden="true" focusable="false" data-prefix="fas" data-icon="square-check" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512" data-state="checked"><path fill="currentColor" d="M64 32C28.7 32 0 60.7 0 96L0 416c0 35.3 28.7 64 64 64l320 0c35.3 0 64-28.7 64-64l0-320c0-35.3-28.7-64-64-64L64 32zM337 209L209 337c-9.4 9.4-24.6 9.4-33.9 0l-64-64c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0l47 47L303 175c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9z"></path></svg>
            <svg class="svg-inline--fa fa-square fa-fw" aria-hidden="true" focusable="false" data-prefix="far" data-icon="square" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512" data-state="default"><path fill="currentColor" d="M384 80c8.8 0 16 7.2 16 16l0 320c0 8.8-7.2 16-16 16L64 432c-8.8 0-16-7.2-16-16L48 96c0-8.8 7.2-16 16-16l320 0zM64 32C28.7 32 0 60.7 0 96L0 416c0 35.3 28.7 64 64 64l320 0c35.3 0 64-28.7 64-64l0-320c0-35.3-28.7-64-64-64L64 32z"></path></svg>
          </span>
          <span class="chapter-label">${ch.displayTitle}</span>
        </label>
        ${translatorHtml}
      `;
      volumeChapters.appendChild(chapterDiv);
    });

    volumeDiv.appendChild(volumeHeader);
    volumeDiv.appendChild(volumeChapters);
    chaptersList.appendChild(volumeDiv);
  });

  // Загружаем сохранённые галочки после рендеринга
  loadSavedCheckboxes();
}

function loadSavedCheckboxes() {
  const slug = downloadData.slug;
  if (!slug) return;

  getTitleStore(['titleData'], slug).then((result) => {
    const titleData = result.titleData || {};
    const savedData = titleData[slug];

    if (savedData && savedData.selectedChapterIds && Array.isArray(savedData.selectedChapterIds)) {
      const savedIds = new Set(savedData.selectedChapterIds);

      // Сбрасываем все галочки
      document.querySelectorAll('.chapter-checkbox').forEach(cb => {
        const chapterId = parseInt(cb.id.replace('chapter-', ''));
        cb.checked = savedIds.has(chapterId);
      });

      // Обновляем состояние чекбоксов томов
      document.querySelectorAll('.volume-chapters').forEach(volumeChapters => {
        const volume = volumeChapters.dataset.volume;
        const chapterCheckboxes = volumeChapters.querySelectorAll('.chapter-checkbox');
        const volumeCheckbox = document.getElementById(`volume-${volume}`);

        if (volumeCheckbox && chapterCheckboxes.length > 0) {
          const allChecked = Array.from(chapterCheckboxes).every(chCb => chCb.checked);
          volumeCheckbox.checked = allChecked;
        }
      });

      // Обновляем selectedChapterIds
      selectedChapterIds.clear();
      savedIds.forEach(id => selectedChapterIds.add(id));
    }
  });
}

function populateFormatSelector(siteType) {
  const formatSelect = document.getElementById('format-select');
  
  if (!formatSelect) return;
  
  // Опции по типу сайта
  const formatOptions = {
    'ranobe': [
      { value: 'epub', label: 'EPUB' },
      { value: 'fb2', label: 'FB2' },
      { value: 'pdf', label: 'PDF' },
      { value: 'txt', label: 'TXT' },
      { value: 'html', label: 'HTML' }
    ],
    'manga': [
      { value: 'cbz', label: 'CBZ' },
      { value: 'zip', label: 'ZIP' },
      { value: 'pdf', label: 'PDF' },
      { value: 'epub', label: 'EPUB' },
      { value: 'html', label: 'HTML' }
    ],
    'anime': [
      { value: 'mkv', label: 'MKV' }
    ]
  };
  
  const options = formatOptions[siteType] || formatOptions['ranobe'];
  const defaultFormat = siteType === 'manga' ? 'cbz' : (siteType === 'anime' ? 'mkv' : 'epub');
  
  // Очищаем dropdown
  formatSelect.innerHTML = '';
  
  options.forEach(opt => {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    formatSelect.appendChild(option);
  });
  formatSelect.value = defaultFormat;

  return defaultFormat;
}

// Ставит снимок в очередь движка: ensureEngine -> порт -> enqueue; движок отвечает enqueueResult
async function enqueueSnapshot(snapshot) {
  await chrome.runtime.sendMessage({ action: 'ensureEngine' });
  const port = chrome.runtime.connect({ name: 'libsaver-engine' });
  try {
    return await new Promise((resolve, reject) => {
      port.onMessage.addListener(message => {
        if (message.type === 'enqueueResult') resolve(message);
      });
      port.onDisconnect.addListener(() => reject(new Error('Движок загрузки недоступен')));
      port.postMessage({ cmd: 'enqueue', snapshot });
    });
  } finally {
    port.disconnect();
  }
}

// Раздел «Загрузки» (downloads.html) вместо панели логов: iframe создаётся при первом «Скачать»
function showDownloadsView() {
  const frame = document.getElementById('downloads-frame');
  if (!frame.getAttribute('src')) frame.setAttribute('src', 'downloads.html');
  const zone = document.getElementById('zone-downloads');
  zone.style.display = 'flex';
  zone.classList.remove('collapsed');
}

async function enqueueAndShow(snapshot) {
  const result = await enqueueSnapshot(snapshot);
  if (!result.ok && result.reason !== 'already-queued') throw new Error(result.reason || 'Очередь отклонила тайтл');
  if (!result.ok) showToast('Этот тайтл уже в очереди', 'info');
  showDownloadsView();
}

function setupEventListeners() {
  // Сначала заполняем селектор формата на основе siteType
  chrome.storage.local.get(['siteType'], (result) => {
    const siteType = result.siteType || 'ranobe';
    const defaultFormat = populateFormatSelector(siteType);
    
    // Показываем селектор сервера только для manga сайтов
    const imageServerSelector = document.getElementById('image-server-selector');
    if (imageServerSelector) {
      imageServerSelector.style.display = (siteType === 'manga') ? 'block' : 'none';
    }
    
    const formatSelect = document.getElementById('format-select');
    const serverSelect = document.getElementById('server-select');
    const textOnlyToggle = document.getElementById('text-only-toggle');
    const textOnlyCheckbox = document.getElementById('text-only-checkbox');
    const formatKey = siteType === 'manga' ? 'selectedFormat_manga' : 'selectedFormat_ranobe';

    function updateTextOnlyVisibility() {
      textOnlyToggle.style.display = formatSelect.value === 'txt' ? 'block' : 'none';
    }

    chrome.storage.local.get([formatKey, 'imageServer', 'textOnly'], result => {
      if (Array.from(formatSelect.options).some(option => option.value === result[formatKey])) {
        formatSelect.value = result[formatKey];
      }
      if (['normal', 'compressed'].includes(result.imageServer)) {
        serverSelect.value = result.imageServer;
      }
      textOnlyCheckbox.checked = result.textOnly === true;
      updateTextOnlyVisibility();
    });
    updateTextOnlyVisibility();

    formatSelect.addEventListener('change', () => {
      chrome.storage.local.set({ [formatKey]: formatSelect.value });
      updateTextOnlyVisibility();
    });
    serverSelect.addEventListener('change', () => {
      chrome.storage.local.set({ imageServer: serverSelect.value });
    });
    textOnlyCheckbox.addEventListener('change', () => {
      chrome.storage.local.set({ textOnly: textOnlyCheckbox.checked });
    });

    const btnDownload = document.getElementById('btn-start-download');
    btnDownload.addEventListener('click', async () => {
      if (selectedChapterIds.size === 0) {
        showToast('Выберите хотя бы одну главу', 'error');
        return;
      }
      
      downloadData.selectedChapterIds = Array.from(selectedChapterIds);
      downloadData.selectedFormat = formatSelect.value;
      downloadData.textOnly = textOnlyCheckbox.checked;
      downloadData.imageServer = serverSelect.value;
      // Пока снимок собирается и уходит в очередь, выбор не меняем
      btnDownload.disabled = true;
      disableChapterCheckboxes();
      disableVolumeCheckboxes();
      disableControls();
      try {
        // downloadData остаётся в storage только для перезагрузки (F5) окна
        await chrome.storage.local.set({ downloadData });
        const { sourceUrl } = await chrome.storage.local.get('sourceUrl');
        const snapshot = await buildDownloadSnapshot({
          slug: downloadData.slug,
          tabId: downloadData.tabId,
          sourceUrl,
          selectedChapterIds: downloadData.selectedChapterIds,
          format: downloadData.selectedFormat,
          imageServer: downloadData.imageServer,
          textOnly: downloadData.textOnly
          // «Ускорить» снимок читает из storage: там единый флаг, общий с разделом «Загрузки»
        });
        await enqueueAndShow(snapshot);
      } catch (error) {
        showToast(`Не удалось начать загрузку: ${error.message}`, 'error');
      } finally {
        restoreDownloadControls();
      }
    });
    
    document.querySelectorAll('.volume-header').forEach(header => {
      header.addEventListener('click', (e) => {
        // Если клик был внутри checkbox-group, не обрабатываем разворачивание
        if (e.target.closest('.checkbox-group')) {
          return;
        }
        
        const volumeChapters = header.nextElementSibling;
        const icon = header.querySelector('.volume-toggle-icon');
        
        volumeChapters.classList.toggle('collapsed');
        header.classList.toggle('expanded');
      });
    });
    
    document.querySelectorAll('.volume-checkbox').forEach(cb => {
      cb.addEventListener('click', (e) => {
        // Предотвращаем всплытие события, чтобы не срабатывал клик на заголовке
        e.stopPropagation();
      });
      
      cb.addEventListener('change', (e) => {
        const volume = e.target.id.replace('volume-', '');
        const volumeChapters = document.querySelector(`.volume-chapters[data-volume="${volume}"]`);
        const chapterCheckboxes = volumeChapters.querySelectorAll('.chapter-checkbox');
        
        chapterCheckboxes.forEach(chCb => {
          chCb.checked = e.target.checked;
        });
        
        updateSelectedChapters();
      });
    });
    
    document.querySelectorAll('.chapter-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const volumeChapters = e.target.closest('.volume-chapters');
        const volume = volumeChapters.dataset.volume;
        const volumeCheckbox = document.getElementById(`volume-${volume}`);
        const chapterCheckboxes = volumeChapters.querySelectorAll('.chapter-checkbox');
        
        const allChecked = Array.from(chapterCheckboxes).every(chCb => chCb.checked);
        volumeCheckbox.checked = allChecked;
        
        updateSelectedChapters();
      });
    });
    
    // Обработка разворачивания/сворачивания зон
    document.querySelectorAll('.zone-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const zoneId = btn.dataset.zone;
        const zone = document.querySelector(`.${zoneId}`);
        if (zone) {
          zone.classList.toggle('collapsed');
        }
      });
    });
    
    // Клик по заголовку зоны также разворачивает/сворачивает (но не на кнопке)
    document.querySelectorAll('.zone-header').forEach(header => {
      header.addEventListener('click', (e) => {
        // Если клик был на кнопке toggle, не обрабатываем
        if (e.target.closest('.zone-toggle')) {
          return;
        }
        const zone = header.closest('.zone');
        if (zone) {
          zone.classList.toggle('collapsed');
        }
      });
    });
    
    // Галочка "Ускорить"
    const speedModeCheckbox = document.getElementById('speed-mode-checkbox');
    if (speedModeCheckbox) {
      speedModeCheckbox.addEventListener('change', (e) => {
        // Идущую загрузку переключает раздел «Загрузки»; здесь значение попадёт в снимок следующего тайтла
        chrome.storage.local.set({ speedMode: e.target.checked });
      });
      
      // Загружаем сохраненное состояние при загрузке
      chrome.storage.local.get(['speedMode'], (result) => {
        if (result.speedMode) {
          speedModeCheckbox.checked = true;
        }
      });
    }
  });
}

// Очистка tippy instances при закрытии окна
window.addEventListener('beforeunload', () => {
  tippyInstances.forEach(instance => instance.destroy());
  tippyInstances = [];
});

function updateSelectedChapters() {
  selectedChapterIds.clear();
  
  document.querySelectorAll('.chapter-checkbox:checked').forEach(cb => {
    const chapterId = parseInt(cb.id.replace('chapter-', ''));
    selectedChapterIds.add(chapterId);
  });
  
  // Сохраняем выбранные главы для текущего тайтла
  const slug = downloadData.slug;
  if (slug) {
    getTitleStore(['titleData'], slug).then((result) => {
      const titleData = result.titleData || {};
      if (!titleData[slug]) {
        titleData[slug] = {};
      }
      titleData[slug].selectedChapterIds = Array.from(selectedChapterIds);
      return setTitleStore({ titleData });
    });
  }
}

// Локальная функция toast для prepare (простая, без иконок)
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('show');
  }, 10);

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
