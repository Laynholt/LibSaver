// Раздел окна LibSaver (?group=images|toc|cbz|pdf|txt|general|about): показываем только панели с data-group из списка (через запятую),
// без тулбара и раскладки колонок. Без ?group= - вся страница с тулбаром (старое окно настроек)
const GROUP_ALIASES = { general: ['general', 'storage'] };

function settingsGroupsFromUrl(search = location.search) {
  const value = new URLSearchParams(search).get('group');
  return value ? value.split(',').flatMap(group => GROUP_ALIASES[group] ?? [group]) : null;
}

const settingsGroups = settingsGroupsFromUrl();

function applyGroupMode() {
  if (!settingsGroups) return;
  document.body.classList.add('group-mode');
  document.querySelectorAll('.panel[data-group]').forEach(panel => {
    panel.classList.toggle('hidden', !settingsGroups.includes(panel.dataset.group));
  });
}

applyGroupMode();

// Дефолтные ссылки сайтов
const defaultSiteLinks = {
  mangalib: 'https://mangalib.me',
  hentailib: 'https://hentailib.me',
  shlib: 'https://v2.shlib.life',
  ranobelib: 'https://ranobelib.me',
  animelib: 'https://animelib.org'
};

// Отображение версии расширения
function displayVersion() {
  const manifest = chrome.runtime.getManifest();
  const versionElement = document.getElementById('extension-version');
  if (versionElement) {
    versionElement.textContent = `LibSaver v${manifest.version}`;
  }
}

// Обновление примера пользовательского формата
function updateCustomFormatExample() {
  const customFormat = document.getElementById('custom-toc-format').value;
  const hideChapterName = document.getElementById('hide-chapter-name').checked;
  const hideVolumeNumber = document.getElementById('hide-volume-number').checked;
  const exampleWithName = document.getElementById('custom-toc-format-example-with-name');
  const exampleWithoutName = document.getElementById('custom-toc-format-example-without-name');

  if (exampleWithName && typeof formatChapterTitle === 'function') {
    const example = formatChapterTitle('4', '31', 'Ёрико', 'custom', customFormat, hideChapterName, hideVolumeNumber);
    exampleWithName.textContent = example;
  }

  if (exampleWithoutName && typeof formatChapterTitle === 'function') {
    const example = formatChapterTitle('4', '31', '', 'custom', customFormat, hideChapterName, hideVolumeNumber);
    exampleWithoutName.textContent = example;
  }
}

// Функция сохранения темы
async function saveTheme(theme) {
  await chrome.storage.local.set({ theme });
  // Сохраняем в localStorage для синхронного доступа при загрузке
  localStorage.setItem('theme', theme);
  // Отправляем сообщение всем открытым окнам для обновления темы
  chrome.runtime.sendMessage({ action: 'updateTheme', theme });

  // Обновляем акцентный цвет для текущего окна сразу после смены темы
  chrome.storage.local.get(['sourceUrl', 'accentColor'], (result) => {
    if (result.accentColor && result.accentColor !== 'auto') {
      window.applyUserAccent(result.accentColor);
    } else if (result.sourceUrl) {
      window.applySiteAccent(result.sourceUrl);
    }
  });
}

// Функция применения выбранного пользователем акцентного цвета
function applyUserAccent(accent) {
  const root = document.documentElement;
  const isDark = !document.documentElement.hasAttribute('data-theme');

  const colors = {
    'manga': { dark: '#ef6c00', light: '#ff9100', hoverDark: '#d86201', hoverLight: '#fe9b18' },
    'hentai': { dark: '#b71c1c', light: '#f44336', hoverDark: '#a61a1a', hoverLight: '#f45449' },
    'slash': { dark: '#ad1457', light: '#d81b60', hoverDark: '#9d134f', hoverLight: '#da306e' },
    'ranobe': { dark: '#1565c0', light: '#2196f3', hoverDark: '#145cae', hoverLight: '#369ff3' },
    'anime': { dark: '#5e35b1', light: '#5e35b1', hoverDark: '#5631a0', hoverLight: '#6d48b7' },
    'social': { dark: '#526cfe', light: '#526cfe', hoverDark: '#425efa', hoverLight: '#425efa' },
    'pink': { dark: '#e91e63', light: '#e91e63', hoverDark: '#c2185b', hoverLight: '#c2185b' },
    'beige': { dark: '#d4a574', light: '#d4a574', hoverDark: '#b89564', hoverLight: '#b89564' },
    'yellow': { dark: '#ffc107', light: '#ffc107', hoverDark: '#ffb300', hoverLight: '#ffb300' },
    'green': { dark: '#4caf50', light: '#4caf50', hoverDark: '#43a047', hoverLight: '#43a047' },
    'mint': { dark: '#4db6ac', light: '#4db6ac', hoverDark: '#4db6ac', hoverLight: '#4db6ac' }
  };

  const color = colors[accent];
  if (color) {
    if (isDark) {
      root.style.setProperty('--accent-color', color.dark);
      root.style.setProperty('--accent-hover', color.hoverDark);
      root.style.setProperty('--accent-soft', `${color.dark}33`);
      root.style.setProperty('--checkbox-color', color.dark);
    } else {
      root.style.setProperty('--accent-color', color.light);
      root.style.setProperty('--accent-hover', color.hoverLight);
      root.style.setProperty('--accent-soft', `${color.light}33`);
      root.style.setProperty('--checkbox-color', color.light);
    }
  }
}

// Слушатель сообщений для обновления темы
setupThemeMessageListener();

// Дефолтные поля метаданных

// Функция загрузки SVG как inline для логотипов сайтов
async function loadInlineSvg() {
  const logoContainers = document.querySelectorAll('.site-menu-logo[data-svg]');

  for (const container of logoContainers) {
    const svgPath = container.getAttribute('data-svg');
    if (!svgPath) continue;

    try {
      const response = await fetch(chrome.runtime.getURL(svgPath));
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const svgText = await response.text();
      container.innerHTML = svgText;
    } catch (error) {
      console.error('Failed to load SVG:', svgPath, error);
    }
  }
}

// Инициализация drag-and-drop для site-menu-links
function initSiteMenuDragAndDrop() {
  const container = document.querySelector('.site-menu-links');
  if (!container) return;

  // Загружаем сохраненный порядок сайтов
  chrome.storage.local.get(['siteMenuOrder'], function(result) {
    if (result.siteMenuOrder) {
      result.siteMenuOrder.forEach(siteId => {
        const field = document.getElementById(siteId);
        if (field) {
          const fieldContainer = field.closest('.site-menu-field');
          if (fieldContainer) {
            container.appendChild(fieldContainer);
          }
        }
      });
    }
  });

  // Инициализируем SortableJS
  new Sortable(container, {
    animation: 150,
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    dragClass: 'sortable-drag',
    handle: '.site-menu-logo',
    onEnd: function(evt) {
      // Сохраняем новый порядок
      const fieldContainers = container.querySelectorAll('.site-menu-field');
      const newOrder = [];
      fieldContainers.forEach(fieldContainer => {
        const input = fieldContainer.querySelector('input');
        if (input) {
          newOrder.push(input.id);
        }
      });
      chrome.storage.local.set({ siteMenuOrder: newOrder });
    }
  });
}

// Инициализация кнопок включения/отключения сайтов
function initSiteMenuToggles() {
  chrome.storage.local.get(['disabledSites'], function(result) {
    const disabledSites = result.disabledSites || {};

    // Применяем состояние к кнопкам
    document.querySelectorAll('.site-menu-toggle').forEach(button => {
      const site = button.getAttribute('data-site');
      if (disabledSites[site]) {
        button.closest('.site-menu-field').classList.add('disabled');
        button.querySelector('i').className = 'fa-solid fa-power-off';
        button.closest('.site-menu-field').querySelector('input').disabled = true;
      }
    });

    // Обработчик клика
    document.querySelectorAll('.site-menu-toggle').forEach(button => {
      button.addEventListener('click', function() {
        const site = this.getAttribute('data-site');
        const fieldContainer = this.closest('.site-menu-field');
        const icon = this.querySelector('i');
        const input = fieldContainer.querySelector('input');

        chrome.storage.local.get(['disabledSites'], function(result) {
          const disabledSites = result.disabledSites || {};

          if (disabledSites[site]) {
            // Включаем
            delete disabledSites[site];
            fieldContainer.classList.remove('disabled');
            icon.className = 'fa-solid fa-power-off';
            input.disabled = false;
          } else {
            // Отключаем
            disabledSites[site] = true;
            fieldContainer.classList.add('disabled');
            icon.className = 'fa-solid fa-power-off';
            input.disabled = true;
          }

          chrome.storage.local.set({ disabledSites: disabledSites });
        });
      });
    });
  });
}

// Сброс порядка сайтов на дефолтный
function resetSiteMenuOrder() {
  const container = document.querySelector('.site-menu-links');
  if (!container) return;

  // Дефолтный порядок
  const defaultOrder = ['site-mangalib', 'site-hentailib', 'site-shlib', 'site-ranobelib', 'site-animelib'];

  // Восстанавливаем порядок в DOM
  defaultOrder.forEach(siteId => {
    const field = document.getElementById(siteId);
    if (field) {
      const fieldContainer = field.closest('.site-menu-field');
      if (fieldContainer) {
        container.appendChild(fieldContainer);
      }
    }
  });
}

// Применение настроек к UI
function applySettingsToUI(settings) {
  document.getElementById('cover-quality').value = settings.coverQuality || 'ORIGINAL';
  document.getElementById('image-quality').value = settings.imageQuality || 'ORIGINAL';
  // Те же значения и умолчание (JPEG), что у загрузки с сайта
  document.getElementById('image-server').value = ['normal', 'compressed'].includes(settings.imageServer) ? settings.imageServer : 'compressed';
  document.getElementById('resize-method').value = settings.resizeMethod || 'MIN_SIDE';
  document.getElementById('adaptive-ratio').value = settings.adaptiveRatio || 3;
  document.getElementById('adaptive-ratio-value').textContent = (settings.adaptiveRatio || 3) + ':1';
  document.getElementById('jpeg-quality').value = settings.jpegQuality || 1.0;
  document.getElementById('jpeg-quality-value').textContent = settings.jpegQuality || 1.0;
  document.getElementById('image-format').value = settings.imageFormat || 'original';
  document.getElementById('disable-toc').checked = settings.disableToc || false;
  document.getElementById('enable-site-menu').checked = settings.enableSiteMenu !== false;

  // Site menu custom links - используем кастомные или дефолтные, показываем как есть
  const customSiteLinks = settings.customSiteLinks || {};
  document.getElementById('site-mangalib').value = customSiteLinks.mangalib || defaultSiteLinks.mangalib;
  document.getElementById('site-hentailib').value = customSiteLinks.hentailib || defaultSiteLinks.hentailib;
  document.getElementById('site-shlib').value = customSiteLinks.shlib || defaultSiteLinks.shlib;
  document.getElementById('site-ranobelib').value = customSiteLinks.ranobelib || defaultSiteLinks.ranobelib;
  document.getElementById('site-animelib').value = customSiteLinks.animelib || defaultSiteLinks.animelib;

  // Show/hide site menu links based on checkbox
  updateSiteMenuLinksVisibility();
  document.getElementById('debug-logging').checked = settings.debugLogging || false;
  document.getElementById('update-notifications').checked = settings.updateNotifications ?? true;
  document.getElementById('generate-comicinfo').checked = settings.generateComicInfo !== false;
  document.getElementById('same-width').checked = settings.sameWidth === true;

  // Chapters pagination settings
  document.getElementById('enable-pagination').checked = settings.enablePagination === true;
  document.getElementById('initial-chapters').value = settings.initialChapters || 500;
  document.getElementById('initial-chapters-value').textContent = settings.initialChapters || 500;
  document.getElementById('load-more-chapters').value = settings.loadMoreChapters || 500;
  document.getElementById('load-more-chapters-value').textContent = settings.loadMoreChapters || 500;

  // Show/hide pagination settings based on checkbox
  updatePaginationSettingsVisibility();

  // Storage settings
  document.getElementById('cleanup-on-title-change').checked = settings.cleanupOnTitleChange !== false;
  document.getElementById('cleanup-old-titles').checked = settings.cleanupOldTitles !== false;

  // PDF settings
  document.getElementById('pdf-font').value = settings.pdfFont || 'merriweather';
  // Применяем шрифт к select
  const fontSelect = document.getElementById('pdf-font');
  if (fontSelect) {
    const selectedOption = fontSelect.options[fontSelect.selectedIndex];
    if (selectedOption) {
      const fontName = selectedOption.textContent;
      fontSelect.style.fontFamily = fontName;
    }
  }
  document.getElementById('pdf-font-size').value = settings.pdfFontSize || 12;
  document.getElementById('pdf-page-size').value = settings.pdfPageSize || 'A5';
  document.getElementById('pdf-line-spacing').value = settings.pdfLineSpacing !== undefined ? String(settings.pdfLineSpacing) : '2';
  document.getElementById('pdf-paragraph-spacing').value = settings.pdfParagraphSpacing !== undefined ? String(settings.pdfParagraphSpacing) : '1';
  document.getElementById('pdf-image-format').value = settings.pdfImageFormat || 'original-png';
  document.getElementById('pdf-jpeg-quality').value = settings.pdfJpegQuality || 1.0;
  document.getElementById('pdf-jpeg-quality-value').textContent = settings.pdfJpegQuality || 1.0;

  // TOC format settings
  document.getElementById('toc-format').value = settings.tocFormat || 'default';
  document.getElementById('custom-toc-format').value = settings.customTocFormat || '~ [Том {vol}] ~ [Глава {num}] ~ [{name}] ~';
  document.getElementById('hide-chapter-name').checked = settings.hideChapterName || false;
  document.getElementById('hide-volume-number').checked = settings.hideVolumeNumber || false;

  // TXT settings
  document.getElementById('txt-image-marker').value = settings.txtImageMarker || 'numbered';
  document.getElementById('text-only').checked = settings.textOnly === true;

  // Show/hide custom format field and disable/enable checkboxes
  updateTocFormatFields();

  // Update custom format example
  updateCustomFormatExample();

  // Save original option texts
  saveOriginalOptionTexts();

  // Update option texts based on checkboxes
  updateTocOptionTexts();

  // Update resize method visibility
  updateResizeMethodVisibility();
}

// Показать/скрыть метод сжатия в зависимости от качества
function updateResizeMethodVisibility() {
  const coverQuality = document.getElementById('cover-quality')?.value || 'ORIGINAL';
  const imageQuality = document.getElementById('image-quality')?.value || 'ORIGINAL';
  const resizeMethodField = document.getElementById('resize-method')?.closest('.field');
  const adaptiveField = document.getElementById('adaptive-ratio-field');
  
  if (!resizeMethodField || !adaptiveField) return;
  
  // Скрываем метод сжатия только если нет сжатия вообще:
  // - Оба ORIGINAL (без сжатия)
  // - Оба NONE (без картинок/обложек)
  // - Один ORIGINAL, другой NONE
  const hasCompression = (coverQuality !== 'ORIGINAL' && coverQuality !== 'NONE') || 
                         (imageQuality !== 'ORIGINAL' && imageQuality !== 'NONE');
  
  if (!hasCompression) {
    resizeMethodField.style.display = 'none';
    adaptiveField.style.display = 'none';
  } else {
    resizeMethodField.style.display = 'flex';
    // Показать/скрыть адаптивное поле в зависимости от выбранного метода
    if (document.getElementById('resize-method').value === 'ADAPTIVE') {
      adaptiveField.style.display = 'block';
    } else {
      adaptiveField.style.display = 'none';
    }
  }
}

// Показать/скрыть ссылки сайтов в зависимости от чекбокса
function updateSiteMenuLinksVisibility() {
  const enableSiteMenu = document.getElementById('enable-site-menu').checked;
  const siteMenuLinks = document.querySelector('.site-menu-links');

  if (enableSiteMenu) {
    siteMenuLinks.classList.remove('hidden');
  } else {
    siteMenuLinks.classList.add('hidden');
  }
}

// Показать/скрыть ползунок качества в зависимости от формата
function updateJpegQualityFieldVisibility() {
  const imageFormat = document.getElementById('image-format')?.value || 'original';
  const jpegQualityField = document.getElementById('jpeg-quality-field');
  const jpegQualityLabel = document.getElementById('jpeg-quality-label');
  if (!jpegQualityField) return;

  if (imageFormat === 'jpeg' || imageFormat === 'webp') {
    jpegQualityField.style.display = 'block';
    // Обновляем название в зависимости от формата
    if (jpegQualityLabel) {
      jpegQualityLabel.textContent = imageFormat === 'jpeg' ? 'Качество JPEG' : 'Качество WebP';
    }
  } else {
    jpegQualityField.style.display = 'none';
  }
}

// Показать/скрыть ползунок качества JPEG для PDF в зависимости от формата
function updatePdfJpegQualityFieldVisibility() {
  const pdfImageFormat = document.getElementById('pdf-image-format')?.value || 'original-png';
  const pdfJpegQualityField = document.getElementById('pdf-jpeg-quality-field');
  if (!pdfJpegQualityField) return;

  // Ползунок нужен только для "Исходный, иначе JPEG" (для WebP/AVIF/GIF)
  if (pdfImageFormat === 'original-jpeg') {
    pdfJpegQualityField.style.display = 'block';
  } else {
    pdfJpegQualityField.style.display = 'none';
  }
}

// Показать/скрыть настройки пагинации в зависимости от чекбокса
function updatePaginationSettingsVisibility() {
  const enablePagination = document.getElementById('enable-pagination')?.checked;
  const initialChaptersField = document.getElementById('initial-chapters-field');
  const loadMoreChaptersField = document.getElementById('load-more-chapters-field');
  
  if (initialChaptersField) {
    initialChaptersField.style.display = enablePagination ? 'flex' : 'none';
  }
  if (loadMoreChaptersField) {
    loadMoreChaptersField.style.display = enablePagination ? 'flex' : 'none';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // Загружаем SVG логотипы сайтов
  loadInlineSvg();

  // Инициализируем drag-and-drop для site-menu-links
  initSiteMenuDragAndDrop();

  // Инициализируем кнопки включения/отключения сайтов
  initSiteMenuToggles();

  // Отображаем версию расширения
  displayVersion();

  // Отображаем размер storage
  updateStorageSizeDisplay();

  // Кнопка очистки старых данных
  document.getElementById('btn-cleanup').addEventListener('click', cleanupOldTitles);

  // Проверка обновлений («О LibSaver»); во время проверки кнопка недоступна
  const checkButton = document.getElementById('btn-check-updates');
  checkButton.addEventListener('click', async () => {
    checkButton.disabled = true;
    try {
      await checkForUpdates();
    } finally {
      checkButton.disabled = false;
    }
  });

  // Загружаем и применяем тему
  const theme = await loadAndApplyTheme();

  // Применяем акцентный цвет по сайту (из storage)
  const result = await chrome.storage.local.get(['sourceUrl']);
  const sourceUrl = result.sourceUrl;
  if (sourceUrl) {
    window.applySiteAccent(sourceUrl);
  }
  
  // Настраиваем dropdown для темы
  const themeSelect = document.getElementById('theme-select');
  const themeDropdown = document.getElementById('theme-dropdown');
  const themeOptions = document.querySelectorAll('.theme-dropdown-option');
  
  if (themeSelect && themeDropdown) {
    // Устанавливаем текущую тему
    const themeLabels = {
      'dark': 'Тёмная',
      'light': 'Светлая',
      'system': 'Системная'
    };
    themeSelect.textContent = themeLabels[theme] || 'Тёмная';
    
    // Обновляем selected класс
    themeOptions.forEach(option => {
      option.classList.remove('selected');
      if (option.dataset.value === theme) {
        option.classList.add('selected');
      }
    });
    
    // Открытие dropdown при клике
    themeSelect.addEventListener('click', (e) => {
      e.stopPropagation();
      themeDropdown.style.display = themeDropdown.style.display === 'none' ? 'block' : 'none';
      // Закрываем accent dropdown если открыт
      if (accentDropdown) {
        accentDropdown.style.display = 'none';
      }
    });
    
    // Выбор опции
    themeOptions.forEach(option => {
      option.addEventListener('click', (e) => {
        e.stopPropagation();
        const newTheme = option.dataset.value;
        
        // Обновляем UI
        themeSelect.textContent = themeLabels[newTheme];
        themeOptions.forEach(opt => opt.classList.remove('selected'));
        option.classList.add('selected');
        themeDropdown.style.display = 'none';
        
        // Применяем и сохраняем тему
        applyTheme(newTheme);
        saveTheme(newTheme);
      });
    });
    
    // Закрытие dropdown при клике вне
    document.addEventListener('click', () => {
      themeDropdown.style.display = 'none';
    });
  }

  // Настраиваем dropdown для акцентного цвета
  const accentSelect = document.getElementById('accent-select');
  const accentDropdown = document.getElementById('accent-dropdown');
  const accentOptions = document.querySelectorAll('.accent-dropdown-option');

  if (accentSelect && accentDropdown) {
    // Загружаем сохранённый акцентный цвет
    const accentResult = await chrome.storage.local.get(['accentColor']);
    const userAccent = accentResult.accentColor || 'auto';

    // Названия цветов
    const accentLabels = {
      'auto': 'Авто',
      'manga': 'MangaLIB',
      'hentai': 'HentaiLIB',
      'slash': 'SlashLIB',
      'ranobe': 'RanobeLIB',
      'anime': 'AnimeLIB',
      'social': 'SocialLIB',
      'pink': 'Розовый',
      'beige': 'Бежевый',
      'yellow': 'Жёлтый',
      'green': 'Зелёный',
      'mint': 'Мятный'
    };

    accentSelect.textContent = accentLabels[userAccent] || 'Авто';

    // Обновляем selected класс
    accentOptions.forEach(option => {
      option.classList.remove('selected');
      if (option.dataset.value === userAccent) {
        option.classList.add('selected');
      }
    });

    // Открытие dropdown при клике
    accentSelect.addEventListener('click', (e) => {
      e.stopPropagation();
      accentDropdown.style.display = accentDropdown.style.display === 'none' ? 'block' : 'none';
      // Закрываем theme dropdown если открыт
      if (themeDropdown) {
        themeDropdown.style.display = 'none';
      }
    });

    // Выбор опции
    accentOptions.forEach(option => {
      option.addEventListener('click', (e) => {
        e.stopPropagation();
        const newAccent = option.dataset.value;

        // Обновляем UI
        accentSelect.textContent = accentLabels[newAccent];
        accentOptions.forEach(opt => opt.classList.remove('selected'));
        option.classList.add('selected');
        accentDropdown.style.display = 'none';

        // Сохраняем и применяем акцентный цвет
        chrome.storage.local.set({ accentColor: newAccent });

        if (newAccent === 'auto') {
          // При выборе "Авто" применяем цвет по сайту
          window.applySiteAccent(sourceUrl);
        } else {
          window.applyUserAccent(newAccent);
        }

        // Отправляем сообщение всем открытым окнам для обновления цвета
        chrome.runtime.sendMessage({ action: 'updateAccent', accent: newAccent });
      });
    });

    // Закрытие dropdown при клике вне
    document.addEventListener('click', () => {
      accentDropdown.style.display = 'none';
    });
  }

  const settings = await chrome.storage.local.get([
    'coverQuality',
    'imageQuality',
    'imageServer',
    'resizeMethod',
    'adaptiveRatio',
    'jpegQuality',
    'imageFormat',
    'disableToc',
    'enableSiteMenu',
    'customSiteLinks',
    'debugLogging',
    'updateNotifications',
    'generateComicInfo',
    'sameWidth',
    'tocFormat',
    'customTocFormat',
    'hideChapterName',
    'hideVolumeNumber',
    'enablePagination',
    'initialChapters',
    'loadMoreChapters',
    'txtImageMarker',
    'textOnly',
    'pdfFont',
    'pdfFontSize',
    'pdfPageSize',
    'pdfLineSpacing',
    'pdfParagraphSpacing',
    'pdfImageFormat',
    'pdfJpegQuality'
  ]);
  
  // Применяем сохраненные настройки
  applySettingsToUI(settings);
  // Сервер картинок есть только у манги (сайт - по siteType, как в быстром окошке)
  const { siteType } = await chrome.storage.local.get('siteType');
  document.getElementById('image-server-field').style.display = siteType === 'manga' ? '' : 'none';
  appliedToc = tocSignature(readTocControls()); // по этому формату главы уже оформлены

  // Инициализация видимости полей
  updateJpegQualityFieldVisibility();
  updatePdfJpegQualityFieldVisibility();
  updatePaginationSettingsVisibility();

  // Обновление значения ползунка адаптивного соотношения
  document.getElementById('adaptive-ratio').addEventListener('input', (e) => {
    document.getElementById('adaptive-ratio-value').textContent = e.target.value + ':1';
  });

  // Обновление значения ползунка качества JPEG
  document.getElementById('jpeg-quality').addEventListener('input', (e) => {
    document.getElementById('jpeg-quality-value').textContent = e.target.value;
  });

  // Обновление значения ползунка качества JPEG для PDF
  document.getElementById('pdf-jpeg-quality').addEventListener('input', (e) => {
    document.getElementById('pdf-jpeg-quality-value').textContent = e.target.value;
  });

  // Обновление значения ползунка количества глав
  document.getElementById('initial-chapters').addEventListener('input', (e) => {
    document.getElementById('initial-chapters-value').textContent = e.target.value;
  });

  document.getElementById('load-more-chapters').addEventListener('input', (e) => {
    document.getElementById('load-more-chapters-value').textContent = e.target.value;
  });

  // Показать/скрыть настройки пагинации при изменении чекбокса
  document.getElementById('enable-pagination').addEventListener('change', updatePaginationSettingsVisibility);

  document.getElementById('image-format').addEventListener('change', updateJpegQualityFieldVisibility);
  document.getElementById('pdf-image-format').addEventListener('change', updatePdfJpegQualityFieldVisibility);

  // Отслеживаем изменения качества
  document.getElementById('cover-quality').addEventListener('change', updateResizeMethodVisibility);
  document.getElementById('image-quality').addEventListener('change', updateResizeMethodVisibility);
  document.getElementById('resize-method').addEventListener('change', updateResizeMethodVisibility);

  // Инициализация отображения
  updateResizeMethodVisibility();
  updateJpegQualityFieldVisibility();
  updatePdfJpegQualityFieldVisibility();

  // TOC format change handler
  document.getElementById('toc-format').addEventListener('change', updateTocFormatFields);

  // Custom format input change handler
  document.getElementById('custom-toc-format').addEventListener('input', updateCustomFormatExample);

  // Checkbox change handlers for visual option updates
  document.getElementById('hide-chapter-name').addEventListener('change', () => {
    updateTocOptionTexts();
    updateCustomFormatExample();
  });
  document.getElementById('hide-volume-number').addEventListener('change', () => {
    updateTocOptionTexts();
    updateCustomFormatExample();
  });

  // Показать/скрыть ссылки сайтов при изменении чекбокса
  document.getElementById('enable-site-menu').addEventListener('change', updateSiteMenuLinksVisibility);

  // Показать предупреждение о перезагрузке при изменении настройки меню
  const originalEnableSiteMenu = document.getElementById('enable-site-menu').checked;
  document.getElementById('enable-site-menu').addEventListener('change', function() {
    const currentValue = this.checked;
    if (currentValue !== originalEnableSiteMenu) {
      document.getElementById('reload-warning').style.display = 'flex';
    } else {
      document.getElementById('reload-warning').style.display = 'none';
    }
  });

  // Обработчики кнопок сброса по группам
  document.querySelectorAll('.btn-reset-group').forEach(button => {
    button.addEventListener('click', () => {
      const group = button.getAttribute('data-group');
      resetGroupSettings(group);
      if (group === 'toc') tocCommitted = true; // сброс - подтверждённая правка формата
      notifyChanged(); // значения сброшены кодом, событий input нет
    });
  });

  // Автосохранение вместо кнопки «Сохранить»
  watchTocCommit();
  enableAutosave({ save: saveSettings });
});

// Show/hide custom format fields based on selection
function updateTocFormatFields() {
  const tocFormat = document.getElementById('toc-format').value;
  const customField = document.getElementById('custom-toc-format-field');
  const hideChapterNameCheckbox = document.getElementById('hide-chapter-name');
  const hideVolumeNumberCheckbox = document.getElementById('hide-volume-number');

  if (tocFormat === 'custom') {
    customField.style.display = 'flex';
    // Блокируем галочки при пользовательском формате
    hideChapterNameCheckbox.disabled = true;
    // Обновляем пример при открытии поля
    updateCustomFormatExample();
    hideVolumeNumberCheckbox.disabled = true;
  } else {
    customField.style.display = 'none';
    // Разблокируем галочки для встроенных форматов
    hideChapterNameCheckbox.disabled = false;
    hideVolumeNumberCheckbox.disabled = false;
  }
}

// Save original option texts
function saveOriginalOptionTexts() {
  const tocSelect = document.getElementById('toc-format');
  const options = tocSelect.querySelectorAll('option');
  options.forEach(option => {
    option.setAttribute('data-original-text', option.textContent);
  });
}

// Update option texts based on checkboxes
function updateTocOptionTexts() {
  const hideChapterName = document.getElementById('hide-chapter-name').checked;
  const hideVolumeNumber = document.getElementById('hide-volume-number').checked;
  const tocSelect = document.getElementById('toc-format');
  const options = tocSelect.querySelectorAll('option');
  
  // Сначала показываем все option'ы
  options.forEach(option => {
    option.style.display = '';
  });
  
  const textCounts = {};
  
  options.forEach(option => {
    const originalText = option.getAttribute('data-original-text');
    if (!originalText) return;
    
    // Не меняем текст для пользовательского формата
    if (option.value === 'custom') {
      option.textContent = originalText;
      return;
    }
    
    let text = originalText;
    
    // Применяем те же преобразования, что и в popup.js
    if (hideVolumeNumber) {
      // Убираем всё до "Глава" включительно
      text = text.replace(/.*Глава\s*/, 'Глава ');
    }
    
    if (hideChapterName) {
      // Убираем всё после номера главы (в option'ах используется Y как номер)
      // Сначала проверяем, есть ли точка сразу после Y
      const hasDotAfterY = /Глава\s+Y\./.test(text);
      
      // Убираем всё после номера главы
      text = text.replace(/(Глава\s+Y).*$/, '$1').trim();
      
      // Если была точка сразу после Y, возвращаем её
      if (hasDotAfterY) {
        text += '.';
      }
    }
    
    option.textContent = text.trim();
    
    // Считаем количество одинаковых текстов (кроме пользовательского формата)
    if (option.value !== 'custom') {
      textCounts[text] = (textCounts[text] || 0) + 1;
    }
  });
  
  // Скрываем дубликаты (оставляем первый из каждого)
  const seenTexts = new Set();
  options.forEach(option => {
    if (option.value === 'custom') return; // Пользовательский формат всегда видим
    
    const text = option.textContent;
    if (textCounts[text] > 1) {
      if (seenTexts.has(text)) {
        option.style.display = 'none';
      } else {
        seenTexts.add(text);
      }
    }
  });
}

// Ключи storage по группам панелей. Раздел окна пишет только свои ключи: остальные разделы живут в соседних фреймах и могли изменить свои позже
const SETTING_KEYS_BY_GROUP = {
  general: ['enableSiteMenu', 'customSiteLinks', 'debugLogging', 'updateNotifications', 'enablePagination', 'initialChapters', 'loadMoreChapters'],
  images: ['coverQuality', 'imageQuality', 'imageServer', 'resizeMethod', 'adaptiveRatio', 'jpegQuality', 'imageFormat', 'sameWidth'],
  toc: ['disableToc', 'tocFormat', 'customTocFormat', 'hideChapterName', 'hideVolumeNumber'],
  cbz: ['generateComicInfo'],
  pdf: ['pdfFont', 'pdfFontSize', 'pdfPageSize', 'pdfLineSpacing', 'pdfParagraphSpacing', 'pdfImageFormat', 'pdfJpegQuality'],
  txt: ['txtImageMarker', 'textOnly'],
  storage: ['cleanupOnTitleChange', 'cleanupOldTitles']
};

// Формат заголовков глав. Значение пишется автосохранением на каждую паузу ввода, а переформатирование глав (сброс displayTitle у всех тайтлов,
// это стирает ручные правки) - один раз на подтверждённую правку: change поля (потеря фокуса, выбор в списке) или уход со страницы
const TOC_CONTROLS = { tocFormat: 'toc-format', customTocFormat: 'custom-toc-format', hideChapterName: 'hide-chapter-name', hideVolumeNumber: 'hide-volume-number' };
let tocCommitted = false; // правка формата подтверждена, но главы ещё не переформатированы
let appliedToc = null; // подпись формата, по которому главы переформатированы в последний раз (null - неизвестно)

const tocSignature = values => JSON.stringify(Object.keys(TOC_CONTROLS).map(key => values[key]));

function readTocControls() {
  return Object.fromEntries(Object.entries(TOC_CONTROLS).map(([key, id]) => {
    const element = document.getElementById(id);
    return [key, element.type === 'checkbox' ? element.checked : element.value];
  }));
}

function watchTocCommit() {
  document.addEventListener('change', event => {
    if (Object.values(TOC_CONTROLS).includes(event.target?.id)) tocCommitted = true;
  });
  // Закрыли окно, пока поле формата в фокусе: change не было, а значение уже могло уйти в storage
  window.addEventListener('pagehide', () => {
    if (appliedToc === null || tocSignature(readTocControls()) === appliedToc) return;
    tocCommitted = true;
    saveSettings().catch(error => console.error('[LibSaver] settings', error));
  });
}

// Сохранение настроек (автосохранение, enableAutosave)
async function saveSettings() {
  const all = {
    coverQuality: document.getElementById('cover-quality').value,
    imageQuality: document.getElementById('image-quality').value,
    imageServer: document.getElementById('image-server').value,
    resizeMethod: document.getElementById('resize-method').value,
    adaptiveRatio: parseFloat(document.getElementById('adaptive-ratio').value),
    jpegQuality: parseFloat(document.getElementById('jpeg-quality').value),
    imageFormat: document.getElementById('image-format').value,
    disableToc: document.getElementById('disable-toc').checked,
    enableSiteMenu: document.getElementById('enable-site-menu').checked,

    // Site menu custom links - сохраняем как есть (чтобы пользователь видел ошибку), но если пустое - дефолт
    customSiteLinks: {
      mangalib: document.getElementById('site-mangalib').value.trim() || defaultSiteLinks.mangalib,
      hentailib: document.getElementById('site-hentailib').value.trim() || defaultSiteLinks.hentailib,
      shlib: document.getElementById('site-shlib').value.trim() || defaultSiteLinks.shlib,
      ranobelib: document.getElementById('site-ranobelib').value.trim() || defaultSiteLinks.ranobelib,
      animelib: document.getElementById('site-animelib').value.trim() || defaultSiteLinks.animelib
    },
    debugLogging: document.getElementById('debug-logging').checked,
    updateNotifications: document.getElementById('update-notifications').checked,
    generateComicInfo: document.getElementById('generate-comicinfo').checked,
    sameWidth: document.getElementById('same-width').checked,
    tocFormat: document.getElementById('toc-format').value,
    customTocFormat: document.getElementById('custom-toc-format').value,
    hideChapterName: document.getElementById('hide-chapter-name').checked,
    hideVolumeNumber: document.getElementById('hide-volume-number').checked,
    txtImageMarker: document.getElementById('txt-image-marker').value,
    textOnly: document.getElementById('text-only').checked,
    pdfFont: document.getElementById('pdf-font').value,
    pdfFontSize: parseInt(document.getElementById('pdf-font-size').value),
    pdfPageSize: document.getElementById('pdf-page-size').value,
    pdfLineSpacing: parseInt(document.getElementById('pdf-line-spacing').value),
    pdfParagraphSpacing: parseFloat(document.getElementById('pdf-paragraph-spacing').value),
    pdfImageFormat: document.getElementById('pdf-image-format').value,
    pdfJpegQuality: parseFloat(document.getElementById('pdf-jpeg-quality').value),
    enablePagination: document.getElementById('enable-pagination').checked,
    initialChapters: parseInt(document.getElementById('initial-chapters').value),
    loadMoreChapters: parseInt(document.getElementById('load-more-chapters').value),
    cleanupOnTitleChange: document.getElementById('cleanup-on-title-change').checked,
    cleanupOldTitles: document.getElementById('cleanup-old-titles').checked
  };
  const groups = settingsGroups ?? Object.keys(SETTING_KEYS_BY_GROUP);
  const settings = Object.fromEntries(groups.flatMap(group => SETTING_KEYS_BY_GROUP[group] ?? []).map(key => [key, all[key]]));

  await chrome.storage.local.set(settings);

  // Если подтверждён другой формат заголовков - переформатируем главы (appliedToc обновляется до первого await: два сохранения подряд не задвоят проход)
  if (tocCommitted && Object.keys(TOC_CONTROLS).every(key => key in settings)) {
    tocCommitted = false;
    const signature = tocSignature(settings);
    if (signature === appliedToc) return;
    appliedToc = signature;
    // Удаляем сохранённые displayTitle из titleData
    const titleData = await getAllTitleData();
    if (titleData) {
      for (const slug in titleData) {
        if (titleData[slug].chapters) {
          titleData[slug].chapters.forEach(ch => {
            delete ch.displayTitle;
          });
        }
      }
      await setTitleStore({ titleData });
    }
    // Отправляем сообщение для переформатирования в открытых окнах
    chrome.runtime.sendMessage({ action: 'reformatChapters' });
  }
}

// Дефолтные значения по группам
const DEFAULT_SETTINGS_BY_GROUP = {
  general: {
    'enable-site-menu': true,
    'debug-logging': false,
    'update-notifications': true,
    'enable-pagination': false,
    'initial-chapters': 500,
    'load-more-chapters': 500
  },
  images: {
    'cover-quality': 'ORIGINAL',
    'image-quality': 'ORIGINAL',
    'image-server': 'compressed',
    'resize-method': 'MIN_SIDE',
    'adaptive-ratio': 3,
    'jpeg-quality': 1.0,
    'image-format': 'original',
    'same-width': false
  },
  toc: {
    'disable-toc': false,
    'toc-format': 'default',
    'custom-toc-format': '~ [Том {vol}] ~ [Глава {num}] ~ [{name}] ~',
    'hide-chapter-name': false,
    'hide-volume-number': false
  },
  cbz: {
    'generate-comicinfo': true
  },
  txt: {
    'txt-image-marker': 'numbered',
    'text-only': false
  },
  pdf: {
    'pdf-font': 'merriweather',
    'pdf-font-size': 12,
    'pdf-page-size': 'A5',
    'pdf-line-spacing': 2,
    'pdf-paragraph-spacing': 1,
    'pdf-image-format': 'original-png',
    'pdf-jpeg-quality': 1.0
  },
  storage: {
    'cleanup-on-title-change': true,
    'cleanup-old-titles': true
  }
};

// Сброс настроек конкретной группы
function resetGroupSettings(group) {
  const defaults = DEFAULT_SETTINGS_BY_GROUP[group];
  if (!defaults) return;

  if (group === 'toc') {
    // Сброс настроек оглавления с восстановлением текстов option'ов
    const tocSelect = document.getElementById('toc-format');
    const options = tocSelect.querySelectorAll('option');
    options.forEach(option => {
      option.style.display = '';
      const originalText = option.getAttribute('data-original-text');
      if (originalText) {
        option.textContent = originalText;
      }
    });

    for (const [key, value] of Object.entries(defaults)) {
      const element = document.getElementById(key);
      if (!element) continue;

      if (element.type === 'checkbox') {
        element.checked = value;
        // Убираем inline стили, чтобы CSS работал корректно
        const indicator = element.parentElement.querySelector('.control__indicator');
        if (indicator) {
          const checkedIcon = indicator.querySelector('i[data-state="checked"]');
          const defaultIcon = indicator.querySelector('i[data-state="default"]');
          if (checkedIcon) checkedIcon.style.display = '';
          if (defaultIcon) defaultIcon.style.display = '';
          if (checkedIcon) checkedIcon.style.color = '';
        }
      } else if (element.tagName === 'SELECT' || element.tagName === 'INPUT') {
        element.value = value;
      }
    }

    // Обновляем видимость полей после сброса
    updateTocFormatFields();
    updateCustomFormatExample();
  } else if (group === 'txt') {
    // Сброс настроек TXT
    for (const [key, value] of Object.entries(defaults)) {
      const element = document.getElementById(key);
      if (!element) continue;

      if (element.type === 'checkbox') {
        element.checked = value;
      } else if (element.tagName === 'SELECT' || element.tagName === 'INPUT') {
        element.value = value;
      }
    }

    // Обновляем видимость полей после сброса
    updateJpegQualityFieldVisibility();
  } else if (group === 'pdf') {
    // Сброс настроек PDF
    for (const [key, value] of Object.entries(defaults)) {
      const element = document.getElementById(key);
      if (!element) continue;

      if (element.tagName === 'SELECT' || element.tagName === 'INPUT') {
        // Используем String() для правильной конвертации чисел
        element.value = String(value);
      }
    }

    // Обновляем видимость полей после сброса
    updatePdfJpegQualityFieldVisibility();
  } else if (group === 'general') {
    // Сброс настроек "Общие"
    for (const [key, value] of Object.entries(defaults)) {
      const element = document.getElementById(key);
      if (!element) continue;

      if (element.type === 'checkbox') {
        element.checked = value;
        // Убираем inline стили, чтобы CSS работал корректно
        const indicator = element.parentElement.querySelector('.control__indicator');
        if (indicator) {
          const checkedIcon = indicator.querySelector('i[data-state="checked"]');
          const defaultIcon = indicator.querySelector('i[data-state="default"]');
          if (checkedIcon) checkedIcon.style.display = '';
          if (defaultIcon) defaultIcon.style.display = '';
          if (checkedIcon) checkedIcon.style.color = '';
        }
      } else if (element.type === 'range' || element.tagName === 'SELECT') {
        element.value = value;
        // Обновляем отображение значений для range
        if (key === 'initial-chapters') {
          document.getElementById('initial-chapters-value').textContent = value;
        }
        if (key === 'load-more-chapters') {
          document.getElementById('load-more-chapters-value').textContent = value;
        }
      }
    }

    // Обновляем видимость полей пагинации после сброса
    updatePaginationSettingsVisibility();

    // Сбрасываем кастомные ссылки сайтов (заполняем дефолтными значениями)
    document.getElementById('site-mangalib').value = defaultSiteLinks.mangalib;
    document.getElementById('site-hentailib').value = defaultSiteLinks.hentailib;
    document.getElementById('site-shlib').value = defaultSiteLinks.shlib;
    document.getElementById('site-ranobelib').value = defaultSiteLinks.ranobelib;
    document.getElementById('site-animelib').value = defaultSiteLinks.animelib;

    // Сбрасываем порядок сайтов и включаем все сайты
    chrome.storage.local.remove('siteMenuOrder');
    chrome.storage.local.remove('disabledSites');
    resetSiteMenuOrder();

    // Сбрасываем состояние кнопок
    document.querySelectorAll('.site-menu-field').forEach(field => {
      field.classList.remove('disabled');
      const icon = field.querySelector('.site-menu-toggle i');
      const input = field.querySelector('input');
      if (icon) {
        icon.className = 'fa-solid fa-power-off';
      }
      if (input) {
        input.disabled = false;
      }
    });
  } else {
    // Сброс обычных настроек (images, cbz)
    for (const [key, value] of Object.entries(defaults)) {
      const element = document.getElementById(key);
      if (!element) continue;

      if (element.type === 'checkbox') {
        element.checked = value;
        // Убираем inline стили, чтобы CSS работал корректно
        const indicator = element.parentElement.querySelector('.control__indicator');
        if (indicator) {
          const checkedIcon = indicator.querySelector('i[data-state="checked"]');
          const defaultIcon = indicator.querySelector('i[data-state="default"]');
          if (checkedIcon) checkedIcon.style.display = '';
          if (defaultIcon) defaultIcon.style.display = '';
          if (checkedIcon) checkedIcon.style.color = '';
        }
      } else if (element.type === 'range' || element.tagName === 'SELECT') {
        element.value = value;
        // Обновляем отображение значений для range
        if (key === 'adaptive-ratio') {
          document.getElementById('adaptive-ratio-value').textContent = value + ':1';
        }
        if (key === 'jpeg-quality') {
          document.getElementById('jpeg-quality-value').textContent = value;
        }
        if (key === 'pdf-jpeg-quality') {
          document.getElementById('pdf-jpeg-quality-value').textContent = value;
        }
      }
    }
  }

  // Обновляем видимость полей после сброса (для групп без специальной обработки)
  if (group === 'images') {
    updateResizeMethodVisibility();
    updateJpegQualityFieldVisibility();
  }

  // Применяем шрифт к select после сброса PDF группы
  if (group === 'pdf') {
    const fontSelect = document.getElementById('pdf-font');
    if (fontSelect) {
      const selectedOption = fontSelect.options[fontSelect.selectedIndex];
      if (selectedOption) {
        const fontName = selectedOption.textContent;
        fontSelect.style.fontFamily = fontName;
      }
    }
  }
}

// Сброс настроек к значениям по умолчанию
document.getElementById('btn-reset').addEventListener('click', async () => {
  const defaultSettings = {
    coverQuality: 'ORIGINAL',
    imageQuality: 'ORIGINAL',
    resizeMethod: 'MIN_SIDE',
    adaptiveRatio: 3,
    enableMetadataEditor: true,
    enableCoverEditor: true,
    enableChaptersEditor: true,
    disableToc: false,
    enableSiteMenu: true,
    customSiteLinks: {
      mangalib: 'https://mangalib.me',
      hentailib: 'https://hentailib.me',
      shlib: 'https://v2.shlib.life',
      ranobelib: 'https://ranobelib.me',
      animelib: 'https://animelib.org'
    },
    debugLogging: false,
    updateNotifications: true,
    tocFormat: 'default',
    customTocFormat: '~ [Том {vol}] ~ [Глава {num}] ~ [{name}] ~',
    hideChapterName: false,
    hideVolumeNumber: false,
    pdfImageFormat: 'original-png',
    pdfJpegQuality: 1.0,
    enablePagination: false,
    initialChapters: 500,
    loadMoreChapters: 500
  };

  // Сбрасываем тексты option'ов к оригинальным
  const tocSelect = document.getElementById('toc-format');
  const options = tocSelect.querySelectorAll('option');
  options.forEach(option => {
    option.style.display = '';
    const originalText = option.getAttribute('data-original-text');
    if (originalText) {
      option.textContent = originalText;
    }
  });

  // Применяем дефолтные настройки к UI (но не сохраняем в storage)
  applySettingsToUI(defaultSettings);

  // Сбрасываем порядок сайтов и включаем все сайты
  chrome.storage.local.remove('siteMenuOrder');
  chrome.storage.local.remove('disabledSites');
  resetSiteMenuOrder();

  // Сбрасываем состояние кнопок
  document.querySelectorAll('.site-menu-field').forEach(field => {
    field.classList.remove('disabled');
    const icon = field.querySelector('.site-menu-toggle i');
    const input = field.querySelector('input');
    if (icon) {
      icon.className = 'fa-solid fa-power-off';
    }
    if (input) {
      input.disabled = false;
    }
  });

  // Применяем шрифт к select после полного сброса
  const fontSelect = document.getElementById('pdf-font');
  if (fontSelect) {
    const selectedOption = fontSelect.options[fontSelect.selectedIndex];
    if (selectedOption) {
      const fontName = selectedOption.textContent;
      fontSelect.style.fontFamily = fontName;
    }
  }

  // Обновляем видимость полей после сброса
  updateTocFormatFields();
  updateResizeMethodVisibility();
  updateJpegQualityFieldVisibility();
  updatePdfJpegQualityFieldVisibility();
  updateTocOptionTexts();
  updatePaginationSettingsVisibility();

  tocCommitted = true;
  notifyChanged(); // значения сброшены кодом, событий input нет
});

// Переопределяем слушатель сообщений для обновления темы
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'updateTheme' && message.theme) {
    applyTheme(message.theme);
  }
});

// Сравнение версий (semver)
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  const maxLength = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLength; i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;

    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }

  return 0;
}

// Проверка обновлений
async function checkForUpdates() {
  const versionElement = document.getElementById('extension-version');
  const manifest = chrome.runtime.getManifest();
  const currentVersion = manifest.version;
  const originalText = `LibSaver v${currentVersion}`;

  versionElement.textContent = 'Проверка...';
  versionElement.style.color = '#999';
  versionElement.onclick = null;
  versionElement.classList.remove('clickable-version');

  try {
    console.log('Текущая версия:', currentVersion);

    // Таймаут 30 секунд для fetch
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const response = await fetch('https://cdn.jsdelivr.net/gh/dfy-dpg/LibSaver@latest/src/manifest.json', {
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const manifest = await response.json();
    if (!manifest || !manifest.version) {
      throw new Error('Нет версии в manifest');
    }

    const latestVersion = manifest.version;

    console.log('Версия на GitHub:', latestVersion);

    // Фейковая задержка 1 секунда после успешного ответа
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Семантическое сравнение версий
    if (compareVersions(latestVersion, currentVersion) > 0) {
      // Обновление доступно - показываем постоянно, кликабельно
      versionElement.textContent = `v${currentVersion} → v${latestVersion}`;
      versionElement.style.color = '#4CAF50';
      versionElement.classList.add('clickable-version');
      console.log(`Доступно обновление: v${currentVersion} → v${latestVersion}`);

      // При клике открываем GitHub releases (последний релиз)
      versionElement.onclick = () => {
        chrome.tabs.create({ url: 'https://github.com/dfy-dpg/LibSaver/releases/latest' });
      };
    } else {
      // Актуальная версия - показываем 4 секунды, не кликабельно
      versionElement.textContent = 'Актуальная версия';
      versionElement.style.color = '#4CAF50';

      setTimeout(() => {
        versionElement.textContent = originalText;
        versionElement.style.color = '';
      }, 4000);
    }
  } catch (error) {
    // Определяем тип ошибки для более информативного сообщения
    let errorMessage = 'Ошибка';
    if (error.name === 'AbortError') {
      errorMessage = 'Таймаут';
    } else if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      errorMessage = 'Нет соединения';
    } else if (error.message.includes('HTTP 4') || error.message.includes('HTTP 5')) {
      errorMessage = 'CDN недоступен';
    }

    // Ошибка - показываем 4 секунды, не кликабельно (без задержки)
    versionElement.textContent = errorMessage;
    versionElement.style.color = '#f44336';
    console.error('Ошибка проверки обновлений:', error);

    setTimeout(() => {
      versionElement.textContent = originalText;
      versionElement.style.color = '';
    }, 4000);
  }
}

// Отображение размера storage
async function updateStorageSizeDisplay() {
  try {
    const bytes = await new Promise((resolve) => {
      chrome.storage.local.getBytesInUse(null, resolve);
    });
    const mb = (bytes / (1024 * 1024)).toFixed(2);
    const display = document.getElementById('storage-size-display');
    if (display) {
      display.textContent = `${mb} MB`;
    }
  } catch (error) {
    console.error('Ошибка при получении размера storage:', error);
  }
}

// Очистка старых данных по клику
async function cleanupOldTitles() {
  try {
    const all = await chrome.storage.local.get(null);
    // Не удаляем ни тайтл из окна LibSaver (?slug=), ни последний открытый
    const keep = [all.currentSlug, new URLSearchParams(location.search).get('slug')];

    const titleKeys = Object.keys(all).filter(k => k.startsWith('titleData:'));
    const toDelete = [];

    for (const key of titleKeys) {
      const slug = key.split(':')[1];
      if (!keep.includes(slug)) {
        toDelete.push(key, `originalTitleData:${slug}`);
      }
    }

    if (toDelete.length > 0) {
      await chrome.storage.local.remove(toDelete);
      await updateStorageSizeDisplay();
    }
  } catch (error) {
    // Ошибка при очистке - игнорируем
  }
}

// Инициализируем после загрузки DOM
document.addEventListener('DOMContentLoaded', () => {
  // Загружаем шрифты для превью в селекторе
  const fontSelect = document.getElementById('pdf-font');
  if (fontSelect) {
    const fonts = [
      { name: 'DejaVu Sans', path: 'assets/fonts/DejaVuSans.ttf' },
      { name: 'Inter', path: 'assets/fonts/Inter-Regular.ttf' },
      { name: 'Merriweather', path: 'assets/fonts/Merriweather-Regular.ttf' },
      { name: 'Montserrat', path: 'assets/fonts/Montserrat-Regular.ttf' },
      { name: 'Open Sans', path: 'assets/fonts/OpenSans-Regular.ttf' },
      { name: 'Roboto', path: 'assets/fonts/Roboto-Regular.ttf' },
      { name: 'Playfair Display', path: 'assets/fonts/PlayfairDisplay-Regular.ttf' },
      { name: 'Noto Serif', path: 'assets/fonts/NotoSerif-Regular.ttf' },
      { name: 'Lora', path: 'assets/fonts/Lora-Regular.ttf' },
      { name: 'Crimson Text', path: 'assets/fonts/CrimsonText-Regular.ttf' }
    ];

    // Загружаем каждый шрифт через FontFace API
    fonts.forEach(font => {
      const fontUrl = chrome.runtime.getURL(font.path);
      const fontFace = new FontFace(font.name, `url(${fontUrl})`);
      fontFace.load().then(loadedFace => {
        document.fonts.add(loadedFace);
      }).catch(err => {
        console.error(`Failed to load font ${font.name}:`, err);
      });
    });

    // Применяем шрифт к селектору при изменении
    fontSelect.addEventListener('change', () => {
      const selectedOption = fontSelect.options[fontSelect.selectedIndex];
      const fontName = selectedOption.textContent;
      fontSelect.style.fontFamily = fontName;
    });

    // Применяем шрифт к текущему выбранному option
    const currentOption = fontSelect.options[fontSelect.selectedIndex];
    if (currentOption) {
      const fontName = currentOption.textContent;
      fontSelect.style.fontFamily = fontName;
    }
  }
});

// Инициализация tippy для кнопки помощи на toolbar
let tippyInstance = null;

function initToolbarTippy() {
  if (typeof window.tippy === 'undefined') {
    console.error('tippy library not loaded');
    return;
  }

  if (tippyInstance) {
    tippyInstance.destroy();
  }

  const helpButton = document.querySelector('.btn-help-toolbar');
  if (helpButton) {
    const tooltipText = helpButton.getAttribute('data-tooltip');
    if (tooltipText) {
      tippyInstance = window.tippy(helpButton, {
        content: `<div class="toolbar-tooltip-wrapper">${tooltipText}</div>`,
        allowHTML: true,
        placement: 'bottom',
        trigger: 'mouseenter',
        interactive: true,
        arrow: false,
        hideOnClick: false,
        offset: [0, 4]
      });
    }
  }
}

// Инициализируем после загрузки DOM
document.addEventListener('DOMContentLoaded', () => {
  initToolbarTippy();
});

// Ссылка на новый issue в репозитории автора с заранее заполненным шаблоном
async function buildIssueUrl() {
  const { sourceUrl } = await chrome.storage.local.get(['sourceUrl']);
  const body = [
    '### Что произошло',
    '<!-- Кратко опишите проблему -->',
    '',
    '### Как повторить',
    '1. ',
    '2. ',
    '3. ',
    '',
    '### Что ожидалось',
    '',
    '',
    '### Скриншоты и логи',
    '<!-- Перетащите сюда скриншоты. Логи можно скопировать из раздела «Логи» в окне загрузки -->',
    '',
    '### Окружение',
    `- Версия LibSaver: ${chrome.runtime.getManifest().version}`,
    `- Страница тайтла: ${sourceUrl || ''}`,
    '- Формат файла: ',
    `- Браузер: ${navigator.userAgent}`
  ].join('\n');
  return `https://github.com/dfy-dpg/LibSaver/issues/new?title=${encodeURIComponent('[Баг] ')}&body=${encodeURIComponent(body)}`;
}

// Подсказка tippy вставляется в body, поэтому клик ловим делегированием
document.addEventListener('click', async (event) => {
  if (!event.target.closest('.issue-btn')) return;
  event.preventDefault();
  chrome.tabs.create({ url: await buildIssueUrl() });
});

window.addEventListener('beforeunload', () => {
  if (tippyInstance) {
    tippyInstance.destroy();
  }
});
