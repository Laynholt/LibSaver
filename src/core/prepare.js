let downloadData = null;
let selectedChapterIds = new Set();
let chaptersByVolume = {};
let metadataFields = {};
let coverQuality = 'ORIGINAL';
let tippyInstances = [];
let tooltipContents = [];
let autoScrollLogs = true; // Флаг для автоскролла логов

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
  
  // Инициализируем начальную статистику
  initializeStatistics();
  
  // Логируем настройки при загрузке страницы
  logDownloadSettings();
  
  // Настраиваем автоскролл логов
  setupLogAutoScroll();
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

function initializeStatistics() {
  // Инициализируем начальные значения статистики
  const statsTime = document.getElementById('stats-time');
  const statsEstimatedTime = document.getElementById('stats-estimated-time');
  const statsFileSize = document.getElementById('stats-file-size');
  const statsErrors = document.getElementById('stats-errors');
  const statsOldFormatChapters = document.getElementById('stats-old-format-chapters');
  const statsSkippedChapters = document.getElementById('stats-skipped-chapters');
  const statsSkippedImages = document.getElementById('stats-skipped-images');
  const statsTotalChapters = document.getElementById('stats-total-chapters');
  const statsTotalCovers = document.getElementById('stats-total-covers');
  const statsTotalImages = document.getElementById('stats-total-images');
  const statsRequestsPerMinute = document.getElementById('stats-requests-per-minute');

  if (statsTime) statsTime.textContent = '0';
  if (statsEstimatedTime) statsEstimatedTime.textContent = '0';
  if (statsFileSize) statsFileSize.textContent = '0 B';
  if (statsErrors) statsErrors.textContent = '0';
  if (statsOldFormatChapters) statsOldFormatChapters.textContent = '0';
  if (statsSkippedChapters) statsSkippedChapters.textContent = '0';
  if (statsSkippedImages) statsSkippedImages.textContent = '0';
  if (statsTotalChapters) statsTotalChapters.textContent = '0';
  if (statsTotalCovers) statsTotalCovers.textContent = '0';
  if (statsTotalImages) statsTotalImages.textContent = '0';

  // Скрываем поле "Главы старого формата" для манга сайтов
  chrome.storage.local.get(['siteType'], (result) => {
    const siteType = result.siteType || 'ranobe';
    const isManga = siteType === 'manga' || siteType === 'hentai' || siteType === 'shlib';
    if (isManga && statsOldFormatChapters) {
      statsOldFormatChapters.parentElement.style.display = 'none';
    }
  });
  
  // Вычисляем начальную скорость на основе количества глав
  const chapterCount = downloadData.chapters ? downloadData.chapters.length : 0;
  let initialSpeed = 60; // дефолтное значение
  if (chapterCount > 0) {
    // Используем ту же логику что в download.js
    if (chapterCount >= 50) {
      initialSpeed = 60;  // Большие тайтлы (>= 50 глав)
    } else {
      initialSpeed = 75;  // Малые тайтлы (< 50 глав)
    }
  }
  
  if (statsRequestsPerMinute) {
    statsRequestsPerMinute.textContent = `0 (0)`;
  }
  
  // Слушаем изменения storage для обновления "Запросов в минуту" в реальном времени
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
      // Если меняется режим ускорения - обновляем отдельно
      if (changes.speedMode) {
        if (statsRequestsPerMinute) {
          const current = changes.currentRequestsPerMinute?.newValue || 0;
          const max = changes.maxRequestsPerMinute?.newValue || (changes.speedMode.newValue ? 80 : initialSpeed);
          statsRequestsPerMinute.textContent = `${current} (${max})`;
        }
      }
      // Иначе обновляем из storage (только если меняется maxRequestsPerMinute)
      else if (changes.maxRequestsPerMinute) {
        const current = changes.currentRequestsPerMinute?.newValue || 0;
        const max = changes.maxRequestsPerMinute?.newValue;
        if (max !== undefined && statsRequestsPerMinute) {
          statsRequestsPerMinute.textContent = `${current} (${max})`;
        }
      }
    }
  });
}

let statisticsUpdateInterval = null;

function startStatisticsUpdate() {
  // Останавливаем предыдущий интервал если есть
  if (statisticsUpdateInterval) {
    clearInterval(statisticsUpdateInterval);
  }

  // Обновляем статистику каждые 500 мс
  statisticsUpdateInterval = setInterval(() => {
    updateStatisticsDisplay();
  }, 500);
}

function stopStatisticsUpdate() {
  if (statisticsUpdateInterval) {
    clearInterval(statisticsUpdateInterval);
    statisticsUpdateInterval = null;
  }
}

// Экспортируем функции в window для доступа из download.js
window.stopStatisticsUpdate = stopStatisticsUpdate;

function updateStatisticsDisplay() {
  const statsTime = document.getElementById('stats-time');
  const statsFileSize = document.getElementById('stats-file-size');
  const statsErrors = document.getElementById('stats-errors');
  const statsOldFormatChapters = document.getElementById('stats-old-format-chapters');
  const statsSkippedChapters = document.getElementById('stats-skipped-chapters');
  const statsSkippedImages = document.getElementById('stats-skipped-images');
  const statsTotalChapters = document.getElementById('stats-total-chapters');
  const statsTotalCovers = document.getElementById('stats-total-covers');
  const statsTotalImages = document.getElementById('stats-total-images');

  // Получаем текущие значения из statistics.js
  const currentChapterIndex = window.getStatisticsValue('currentChapterIndex') || 0;
  const totalChapters = window.getStatisticsValue('totalChapters') || 0;
  const totalCovers = window.getStatisticsValue('totalCovers') || 0;
  const totalImages = window.getStatisticsValue('totalImages') || 0;
  const totalErrorCount = window.getStatisticsValue('totalErrorCount') || 0;
  const skippedChaptersCount = window.getStatisticsValue('skippedChaptersCount') || 0;
  const skippedImagesCount = window.getStatisticsValue('skippedImagesCount') || 0;
  const oldFormatChaptersCount = window.getStatisticsValue('oldFormatChaptersCount') || 0;
  const totalFileSize = window.getStatisticsValue('totalFileSize') || 0;

  // Обновляем время загрузки
  if (statsTime && window.getStatisticsValue('downloadStartTime')) {
    const elapsed = Math.floor((Date.now() - window.getStatisticsValue('downloadStartTime')) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    statsTime.textContent = minutes > 0 ? `${minutes}м ${seconds}с` : `${seconds}с`;
  }

  // Обновляем размер файла
  if (statsFileSize) {
    const sizeMB = (totalFileSize / (1024 * 1024)).toFixed(2);
    statsFileSize.textContent = `${sizeMB} MB`;
  }

  // Обновляем ошибки
  if (statsErrors) {
    statsErrors.textContent = totalErrorCount;
  }

  // Обновляем главы старого формата
  if (statsOldFormatChapters) {
    statsOldFormatChapters.textContent = oldFormatChaptersCount;
  }

  // Обновляем пропущенные главы
  if (statsSkippedChapters) {
    statsSkippedChapters.textContent = skippedChaptersCount;
  }

  // Обновляем пропущенные картинки
  if (statsSkippedImages) {
    statsSkippedImages.textContent = skippedImagesCount;
  }

  // Обновляем загруженные главы (текущий индекс)
  if (statsTotalChapters) {
    statsTotalChapters.textContent = `${currentChapterIndex} / ${totalChapters}`;
  }

  // Обновляем загруженные обложки
  if (statsTotalCovers) {
    statsTotalCovers.textContent = totalCovers;
  }

  // Обновляем загруженные картинки
  if (statsTotalImages) {
    statsTotalImages.textContent = totalImages;
  }
}

function logDownloadSettings() {
  const logContainer = document.getElementById('log');
  if (!logContainer) return;

  // Получаем настройки логирования
  chrome.storage.local.get(['debugLogging'], (result) => {
    const debugMode = result.debugLogging || false;

    addLogToContainer('=== НАСТРОЙКИ СКАЧИВАНИЯ ===');
    addLogToContainer(`Качество картинок: ${downloadData.quality || 'ORIGINAL'}`);
    addLogToContainer(`Качество обложек: ${downloadData.coverQuality || 'ORIGINAL'}`);
    if (downloadData.resizeMethod) {
      addLogToContainer(`Метод сжатия: ${downloadData.resizeMethod}`);
    }
    if (debugMode) {
      const imageFormat = downloadData.imageFormat || 'original';
      const pdfImageFormat = downloadData.pdfImageFormat || 'original-png';
      addLogToContainer(`Формат изображений: ${imageFormat}`);
      addLogToContainer(`Формат изображений в PDF: ${pdfImageFormat}`);

      const jpegQuality = downloadData.jpegQuality !== undefined ? downloadData.jpegQuality : 1.0;
      const pdfJpegQuality = downloadData.pdfJpegQuality !== undefined ? downloadData.pdfJpegQuality : 1.0;
      addLogToContainer(`Качество JPEG/WebP: ${jpegQuality}`);
      addLogToContainer(`Качество JPEG в PDF: ${pdfJpegQuality}`);
    }
    addLogToContainer(`Оглавление: ${downloadData.disableToc ? 'Отключено' : 'Включено'}`);
    addLogToContainer(`Подробное логирование: ${debugMode ? 'Включено' : 'Отключено'}`);
    addLogToContainer('============================');
  });
}

function logDownloadSettingsOnStart(selectedChapterIds) {
  const logContainer = document.getElementById('log');
  if (!logContainer) return;

  // Получаем настройки логирования
  chrome.storage.local.get(['debugLogging'], (result) => {
    const debugMode = result.debugLogging || false;

    const totalChapters = downloadData.chapters ? downloadData.chapters.length : 0;
    const selectedChapters = selectedChapterIds ? selectedChapterIds.length : 0;

    addLogToContainer('=== НАСТРОЙКИ СКАЧИВАНИЯ ===');
    addLogToContainer(`Качество картинок: ${downloadData.quality || 'ORIGINAL'}`);
    addLogToContainer(`Качество обложек: ${downloadData.coverQuality || 'ORIGINAL'}`);
    if (downloadData.resizeMethod) {
      addLogToContainer(`Метод сжатия: ${downloadData.resizeMethod}`);
    }
    if (debugMode) {
      const imageFormat = downloadData.imageFormat || 'original';
      const pdfImageFormat = downloadData.pdfImageFormat || 'original-png';
      addLogToContainer(`Формат изображений: ${imageFormat} (PDF: ${pdfImageFormat})`);

      const jpegQuality = downloadData.jpegQuality !== undefined ? downloadData.jpegQuality : 1.0;
      const pdfJpegQuality = downloadData.pdfJpegQuality !== undefined ? downloadData.pdfJpegQuality : 1.0;
      addLogToContainer(`Качество JPEG: ${jpegQuality} (PDF: ${pdfJpegQuality})`);
    }
    addLogToContainer(`Оглавление: ${downloadData.disableToc ? 'Отключено' : 'Включено'}`);
    addLogToContainer(`Подробное логирование: ${debugMode ? 'Включено' : 'Отключено'}`);
    addLogToContainer('============================');

    // Логируем количество глав после группы настроек
    addLogToContainer(`Всего глав: ${totalChapters}`);
    addLogToContainer(`Глав выбрано: ${selectedChapters}`);

    // Логируем количество обложек
    const allCovers = downloadData.allCovers ? downloadData.allCovers : [downloadData.metadata?.cover || downloadData.originalCover || ''];
    const coverCount = allCovers.filter(c => c).length;
    addLogToContainer(`Обложек: ${coverCount}`);
  });
}

function addLogToContainer(message, isError = false, color = null) {
  const logContainer = document.getElementById('log');
  if (!logContainer) return;

  const logEntry = document.createElement('div');
  logEntry.className = 'log-entry';
  if (color) {
    logEntry.style.color = color;
  } else if (isError) {
    logEntry.style.color = '#c62828';
  }
  logEntry.textContent = message;
  logContainer.appendChild(logEntry);

  // Автоскролл к низу если включен
  if (autoScrollLogs) {
    const logsPanel = document.getElementById('logs-panel');
    if (logsPanel) {
      logsPanel.scrollTop = logsPanel.scrollHeight
    }
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

window.restoreDownloadControls = restoreDownloadControls;

// Экспортируем функции для использования в download.js
window.addLogToContainer = addLogToContainer;

function setupLogAutoScroll() {
  const logsPanel = document.getElementById('logs-panel');
  if (!logsPanel) return;
  
  // Отслеживаем скролл для отключения автоскролла
  logsPanel.addEventListener('scroll', () => {
    const isAtBottom = logsPanel.scrollHeight - logsPanel.scrollTop <= logsPanel.clientHeight + 50;
    
    if (!isAtBottom && autoScrollLogs) {
      autoScrollLogs = false;
      showScrollToBottomButton();
    } else if (isAtBottom && !autoScrollLogs) {
      autoScrollLogs = true;
      hideScrollToBottomButton();
    }
  });
  
  // Создаем кнопку скролла вниз
  createScrollToBottomButton();
}

function createScrollToBottomButton() {
  const logsPanel = document.getElementById('logs-panel');
  if (!logsPanel) return;

  // Находим zone-content чтобы поместить кнопку туда
  const zoneContent = logsPanel.closest('.zone-content');
  if (!zoneContent) return;

  const button = document.createElement('button');
  button.id = 'scroll-to-bottom-btn';
  button.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
  button.style.cssText = `
    position: absolute;
    bottom: 20px;
    right: 20px;
    width: 36px;
    height: 36px;
    border-radius: var(--border-radius);
    background-color: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    cursor: pointer;
    display: none;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    z-index: 10;
    transition: border-color 0.15s ease-in-out, background-color 0.15s ease-in-out;
  `;

  // Помещаем кнопку в zone-content
  zoneContent.style.position = 'relative';  // Для работы position: absolute
  zoneContent.appendChild(button);
  
  button.addEventListener('mouseenter', () => {
    button.style.backgroundColor = 'var(--bg-secondary)';
    button.style.borderColor = 'var(--border-hover)';
  });
  
  button.addEventListener('mouseleave', () => {
    button.style.backgroundColor = 'var(--bg-tertiary)';
    button.style.borderColor = 'var(--border-color)';
  });
  
  button.addEventListener('click', () => {
    autoScrollLogs = true;
    logsPanel.scrollTop = logsPanel.scrollHeight;
    hideScrollToBottomButton();
  });
}

function showScrollToBottomButton() {
  const button = document.getElementById('scroll-to-bottom-btn');
  if (button) {
    button.style.display = 'flex';
  }
}

function hideScrollToBottomButton() {
  const button = document.getElementById('scroll-to-bottom-btn');
  if (button) {
    button.style.display = 'none';
  }
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

// Экспортируем функции для использования в download.js
window.disableControls = disableControls;
window.enableControls = enableControls;
window.showScrollToBottomButton = showScrollToBottomButton;
window.hideScrollToBottomButton = hideScrollToBottomButton;

// Слушаем изменения качества в реальном времени
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
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
      btnDownload.disabled = true;
      try {
        await chrome.storage.local.set({ downloadData });
        // Обновляем логи с актуальными настройками перед началом скачивания
        logDownloadSettingsOnStart(Array.from(selectedChapterIds));
        
        // Отключаем чекбоксы глав
        disableChapterCheckboxes();
        disableVolumeCheckboxes();

        // Отключаем кнопки формата, сервера и "Только текст"
        disableControls();

        // Скрываем кнопку Скачать и показываем прогресс-бар
        btnDownload.style.display = 'none';
        const downloadToolbar = document.getElementById('download-toolbar');
        if (downloadToolbar) {
          downloadToolbar.style.display = 'flex';
        }
        // Разворачиваем зону логов
        const logsZone = document.querySelector('.zone-logs');
        if (logsZone) {
          logsZone.classList.remove('collapsed');
        }

        // Запускаем обновление статистики в реальном времени
        startStatisticsUpdate();

        // Запускаем загрузку
        if (typeof startDownload === 'function') {
          await startDownload();
        } else {
          throw new Error('Загрузчик недоступен');
        }
      } catch (error) {
        stopStatisticsUpdate();
        restoreDownloadControls();
        showToast(`Не удалось начать загрузку: ${error.message}`, 'error');
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
        const isChecked = e.target.checked;
        // Устанавливаем режим ускорения в protection module
        setSpeedMode(isChecked);
        // Сохраняем состояние в storage
        chrome.storage.local.set({ speedMode: isChecked });
        
        // Немедленно обновляем статистику через storage
        if (isChecked) {
          chrome.storage.local.set({ maxRequestsPerMinute: 80 });
        } else {
          // Восстанавливаем начальную скорость
          const chapterCount = downloadData.chapters ? downloadData.chapters.length : 0;
          const initialSpeed = chapterCount >= 50 ? 60 : 75;
          chrome.storage.local.set({ maxRequestsPerMinute: initialSpeed });
        }
      });
      
      // Загружаем сохраненное состояние при загрузке
      chrome.storage.local.get(['speedMode'], (result) => {
        if (result.speedMode) {
          speedModeCheckbox.checked = true;
          setSpeedMode(true);  // Синхронизируем с protection module
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
      setTitleStore({ titleData });
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
