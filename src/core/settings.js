// Раздел окна LibSaver (?group=images|toc|formats|cbz|pdf|txt|video|general|about): показываем только панели с data-group из списка (через запятую),
// без тулбара и раскладки колонок. Без ?group= - вся страница с тулбаром (старое окно настроек)
const GROUP_ALIASES = { general: ['general', 'storage'], formats: ['profiles', 'files', 'cbz', 'pdf', 'txt'], video: ['profiles', 'video'] };

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
  animelib: 'https://v5.animelib.org'
};

// Вкладка настроек (без ?group=): слева разделы, справа панели одного раздела. Раздел - в #адресе: ссылка и «назад» его помнят
const TAB_SECTIONS = [
  { id: 'general', title: 'Общие', icon: 'fa-sliders', groups: ['general', 'storage'] },
  { id: 'images', title: 'Картинки', icon: 'fa-image', groups: ['images'] },
  { id: 'toc', title: 'Оглавление', icon: 'fa-list-ol', groups: ['toc'] },
  { id: 'formats', title: 'Форматы', icon: 'fa-file-export', groups: ['profiles', 'files', 'cbz', 'pdf', 'txt'] },
  { id: 'video', title: 'Видео', icon: 'fa-film', groups: ['video'] },
  { id: 'about', title: 'О LibSaver', icon: 'fa-circle-info', groups: ['about'] }
];

function showTabSection(id) {
  const section = TAB_SECTIONS.find(candidate => candidate.id === id) || TAB_SECTIONS[0];
  document.querySelectorAll('.panel[data-group]').forEach(panel => {
    panel.classList.toggle('hidden', !section.groups.includes(panel.dataset.group));
  });
  document.querySelectorAll('.settings-nav a').forEach(link => {
    const on = link.dataset.section === section.id;
    link.classList.toggle('on', on);
    if (on) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
}

function applyTabMode() {
  const nav = document.getElementById('settings-nav');
  if (settingsGroups || !nav) return;
  document.body.classList.add('tab-mode');
  for (const section of TAB_SECTIONS) {
    const link = document.createElement('a');
    link.href = `#${section.id}`;
    link.dataset.section = section.id;
    const icon = document.createElement('i');
    icon.className = `fa-solid ${section.icon}`;
    link.append(icon, document.createTextNode(section.title));
    nav.append(link);
  }
  window.addEventListener('hashchange', () => showTabSection(location.hash.slice(1)));
  showTabSection(location.hash.slice(1));
}

applyTabMode();

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

  // Применяем тему локально (синхронно обновляет и тему, и акцентный цвет без задержек и переливов)
  applyTheme(theme);

  // Если окно во фрейме панели, синхронизируем родителя
  try {
    if (window.parent && window.parent !== window && typeof window.parent.applyTheme === 'function') {
      window.parent.applyTheme(theme);
    }
  } catch (e) {}

  // Отправляем сообщение всем открытым окнам для обновления темы
  chrome.runtime.sendMessage({ action: 'updateTheme', theme });
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
  // Те же значения и умолчание (сжатые), что у загрузки с сайта
  document.getElementById('image-server').value = ['normal', 'compressed'].includes(settings.imageServer) ? settings.imageServer : 'compressed';
  document.getElementById('resize-method').value = settings.resizeMethod || 'MIN_SIDE';
  document.getElementById('adaptive-ratio').value = settings.adaptiveRatio || 3;
  document.getElementById('adaptive-ratio-value').textContent = (settings.adaptiveRatio || 3) + ':1';
  document.getElementById('jpeg-quality').value = settings.jpegQuality || 1.0;
  document.getElementById('jpeg-quality-value').textContent = settings.jpegQuality || 1.0;
  document.getElementById('image-format').value = settings.imageFormat || 'original';
  document.getElementById('disable-toc').checked = settings.disableToc || false;
  document.getElementById('enable-site-menu').checked = settings.enableSiteMenu !== false;
  document.getElementById('use-custom-site-links').checked = settings.useCustomSiteLinks !== false;
  document.getElementById('enable-mirror-search').checked = settings.enableMirrorSearch !== false;

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
  document.getElementById('anime-quality').value = settings.animeQuality || 'max';
  document.getElementById('anime-save-info').checked = settings.animeSaveInfo !== false;
  document.getElementById('anime-save-text').checked = settings.animeSaveText !== false;
  document.getElementById('anime-save-poster').checked = settings.animeSavePoster !== false;

  // Chapters pagination settings
  document.getElementById('initial-chapters').value = settings.initialChapters || 100;
  document.getElementById('initial-chapters-value').textContent = settings.initialChapters || 100;
  document.getElementById('load-more-chapters').value = settings.loadMoreChapters || 100;
  document.getElementById('load-more-chapters-value').textContent = settings.loadMoreChapters || 100;

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

  document.getElementById('split-chapters').value = Number(settings.splitChapters) > 0 ? settings.splitChapters : 0;

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

// Показать/скрыть подчинённые настройки меню сайтов в зависимости от главного чекбокса
function updateSiteMenuLinksVisibility() {
  const enableSiteMenu = document.getElementById('enable-site-menu').checked;
  const useCustomField = document.getElementById('use-custom-site-links-field');
  const siteMenuLinks = document.querySelector('.site-menu-links');

  if (useCustomField) {
    useCustomField.classList.toggle('hidden', !enableSiteMenu);
  }
  if (siteMenuLinks) {
    siteMenuLinks.classList.toggle('hidden', !enableSiteMenu);
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

// Настройки под тип сайта (siteType пишет окно на странице тайтла): data-site-type="manga" - сервер картинок, одинаковая ширина, CBZ/ZIP;
// data-site-type="ranobe" - текст PDF и TXT, data-site-type="anime" - видео. Тип не известен - видно всё
function applySiteFilter(siteType) {
  if (!['manga', 'ranobe', 'anime'].includes(siteType)) return;
  document.querySelectorAll('[data-site-type]').forEach(el => el.classList.toggle('site-hidden', el.dataset.siteType !== siteType));
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
      'system': 'Системная',
      'dark': 'Тёмная',
      'light': 'Светлая'
    };
    themeSelect.textContent = themeLabels[theme] || 'Системная';
    
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
        try { localStorage.setItem('accentColor', newAccent); } catch (e) {}
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
    'useCustomSiteLinks',
    'customSiteLinks',
    'enableMirrorSearch',
    'debugLogging',
    'updateNotifications',
    'generateComicInfo',
    'sameWidth',
    'animeQuality',
    'animeSaveInfo',
    'animeSaveText',
    'animeSavePoster',
    'tocFormat',
    'customTocFormat',
    'hideChapterName',
    'hideVolumeNumber',
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
    'pdfJpegQuality',
    'splitChapters'
  ]);
  
  // Применяем сохраненные настройки
  applySettingsToUI(settings);
  applySiteFilter((await chrome.storage.local.get('siteType')).siteType);
  appliedToc = tocSignature(readTocControls()); // по этому формату главы уже оформлены

  // Инициализация видимости полей
  updateJpegQualityFieldVisibility();
  updatePdfJpegQualityFieldVisibility();

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
  general: ['enableSiteMenu', 'useCustomSiteLinks', 'customSiteLinks', 'debugLogging', 'initialChapters', 'loadMoreChapters', 'enableMirrorSearch', 'updateNotifications'],
  images: ['coverQuality', 'imageQuality', 'imageServer', 'resizeMethod', 'adaptiveRatio', 'jpegQuality', 'imageFormat', 'sameWidth'],
  toc: ['disableToc', 'tocFormat', 'customTocFormat', 'hideChapterName', 'hideVolumeNumber'],
  cbz: ['generateComicInfo'],
  pdf: ['pdfFont', 'pdfFontSize', 'pdfPageSize', 'pdfLineSpacing', 'pdfParagraphSpacing', 'pdfImageFormat', 'pdfJpegQuality'],
  txt: ['txtImageMarker', 'textOnly'],
  video: ['animeQuality', 'animeSaveInfo', 'animeSaveText', 'animeSavePoster'],
  storage: ['cleanupOnTitleChange', 'cleanupOldTitles'],
  files: ['splitChapters']
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
let replacingSettings = false; // настройки меняет профиль или импорт: автосохранение старых значений из полей их бы перебило

async function saveSettings() {
  if (replacingSettings) return; // поля показывают значения до профиля или импорта
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
    useCustomSiteLinks: document.getElementById('use-custom-site-links').checked,

    // Site menu custom links - сохраняем как есть (чтобы пользователь видел ошибку), но если пустое - дефолт
    customSiteLinks: {
      mangalib: document.getElementById('site-mangalib').value.trim() || defaultSiteLinks.mangalib,
      hentailib: document.getElementById('site-hentailib').value.trim() || defaultSiteLinks.hentailib,
      shlib: document.getElementById('site-shlib').value.trim() || defaultSiteLinks.shlib,
      ranobelib: document.getElementById('site-ranobelib').value.trim() || defaultSiteLinks.ranobelib,
      animelib: document.getElementById('site-animelib').value.trim() || defaultSiteLinks.animelib
    },
    debugLogging: document.getElementById('debug-logging').checked,
    enableMirrorSearch: document.getElementById('enable-mirror-search').checked,
    updateNotifications: document.getElementById('update-notifications').checked,
    generateComicInfo: document.getElementById('generate-comicinfo').checked,
    sameWidth: document.getElementById('same-width').checked,
    animeQuality: document.getElementById('anime-quality').value,
    animeSaveInfo: document.getElementById('anime-save-info').checked,
    animeSaveText: document.getElementById('anime-save-text').checked,
    animeSavePoster: document.getElementById('anime-save-poster').checked,
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
    initialChapters: parseInt(document.getElementById('initial-chapters').value),
    loadMoreChapters: parseInt(document.getElementById('load-more-chapters').value),
    cleanupOnTitleChange: document.getElementById('cleanup-on-title-change').checked,
    cleanupOldTitles: document.getElementById('cleanup-old-titles').checked,
    splitChapters: Math.max(0, parseInt(document.getElementById('split-chapters').value, 10) || 0)
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
    await resetChapterTitles();
  }
}

// Формат заголовков сменился: сохранённые displayTitle всех тайтлов сбрасываются, открытые окна глав переформатируют свои
async function resetChapterTitles() {
  {
    await withTitleStoreLock(async () => {
      const titleData = await getAllTitleData();
      for (const slug in titleData) {
        if (titleData[slug].chapters) {
          titleData[slug].chapters.forEach(ch => {
            delete ch.displayTitle;
          });
        }
      }
      await setTitleStore({ titleData });
    });
    // Отправляем сообщение для переформатирования в открытых окнах
    chrome.runtime.sendMessage({ action: 'reformatChapters' });
  }
}

// Дефолтные значения по группам
const DEFAULT_SETTINGS_BY_GROUP = {
  general: {
    'enable-site-menu': true,
    'use-custom-site-links': true,
    'enable-mirror-search': true,
    'debug-logging': false,
    'update-notifications': true,
    'initial-chapters': 100,
    'load-more-chapters': 100
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
  video: {
    'anime-quality': 'max',
    'anime-save-info': true,
    'anime-save-text': true,
    'anime-save-poster': true
  },
  storage: {
    'cleanup-on-title-change': true,
    'cleanup-old-titles': true
  },
  files: {
    'split-chapters': 0
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
      } else if (element.type === 'range' || element.type === 'number' || element.tagName === 'SELECT') {
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
    useCustomSiteLinks: true,
    enableMirrorSearch: true,
    customSiteLinks: {
      mangalib: 'https://mangalib.me',
      hentailib: 'https://hentailib.me',
      shlib: 'https://v2.shlib.life',
      ranobelib: 'https://ranobelib.me',
      animelib: 'https://v5.animelib.org'
    },
    debugLogging: false,
    updateNotifications: true,
    tocFormat: 'default',
    customTocFormat: '~ [Том {vol}] ~ [Глава {num}] ~ [{name}] ~',
    hideChapterName: false,
    hideVolumeNumber: false,
    pdfImageFormat: 'original-png',
    pdfJpegQuality: 1.0,
    initialChapters: 100,
    loadMoreChapters: 100,
    splitChapters: 0
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

  tocCommitted = true;
  notifyChanged(); // значения сброшены кодом, событий input нет
});



// Проверка обновлений по последнему релизу на GitHub (utils/update-check.js)
async function checkForUpdates() {
  const versionElement = document.getElementById('extension-version');
  const currentVersion = chrome.runtime.getManifest().version;
  const originalText = `LibSaver v${currentVersion}`;
  const showBriefly = (text, color) => {
    versionElement.textContent = text;
    versionElement.style.color = color;
    setTimeout(() => {
      versionElement.textContent = originalText;
      versionElement.style.color = '';
    }, 4000);
  };

  versionElement.textContent = 'Проверка...';
  versionElement.style.color = '#999';
  versionElement.onclick = null;
  versionElement.classList.remove('clickable-version');

  try {
    const release = await fetchLatestRelease();
    await chrome.storage.local.set({ lastUpdateCheck: { at: Date.now(), release } }); // значок на иконке и панель узнают сразу
    if (compareVersions(release.version, currentVersion) > 0) {
      // Обновление есть - надпись остаётся и по клику скачивает релиз
      versionElement.textContent = `v${currentVersion} → v${release.version} · скачать`;
      versionElement.style.color = '#4CAF50';
      versionElement.classList.add('clickable-version');
      versionElement.onclick = () => openUpdate(release);
    } else {
      showBriefly('Актуальная версия', '#4CAF50');
    }
  } catch (error) {
    let errorMessage = 'Ошибка';
    if (error.name === 'AbortError') {
      errorMessage = 'Таймаут';
    } else if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      errorMessage = 'Нет соединения';
    } else if (error.message === 'HTTP 404') {
      errorMessage = 'Релизов пока нет';
    } else if (error.message.startsWith('HTTP ')) {
      errorMessage = 'GitHub недоступен';
    }
    console.error('Ошибка проверки обновлений:', error);
    showBriefly(errorMessage, '#f44336');
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

// Форма issue (.github/ISSUE_TEMPLATE/bug_report.yml): версия, страница тайтла и браузер подставляются по id полей формы
async function buildIssueUrl() {
  const { sourceUrl } = await chrome.storage.local.get(['sourceUrl']);
  const params = new URLSearchParams({
    template: 'bug_report.yml',
    version: chrome.runtime.getManifest().version,
    page: sourceUrl || '',
    browser: navigator.userAgent
  });
  return `https://github.com/${ISSUES_REPO}/issues/new?${params}`;
}

// Подсказка tippy вставляется в body, поэтому клик ловим делегированием
document.addEventListener('click', async (event) => {
  if (!event.target.closest('.issue-btn')) return;
  event.preventDefault();
  openTab(await buildIssueUrl());
});

window.addEventListener('beforeunload', () => {
  if (tippyInstance) {
    tippyInstance.destroy();
  }
});

// Профиль скачивания: формат файла и всё, что задаёт сборку (не общие настройки)
const FORMAT_KEYS = ['selectedFormat_manga', 'selectedFormat_ranobe', 'selectedFormat_anime'];
const PROFILE_KEYS = [...['images', 'toc', 'cbz', 'pdf', 'txt', 'video', 'files'].flatMap(group => SETTING_KEYS_BY_GROUP[group]), ...FORMAT_KEYS];
// Резервная копия: все настройки и профили. Тайтлы (titleData:*), учёт скачанных глав, история и служебное состояние в неё не входят
const BACKUP_KEYS = [...Object.values(SETTING_KEYS_BY_GROUP).flat(), ...FORMAT_KEYS, 'theme', 'accentColor', 'siteMenuOrder', 'disabledSites',
  'metadataFields', 'fieldLabels', 'metadataFieldOrder', 'speedMode', 'coversZoomLevel', 'plaqueCorner', 'downloadProfiles'];
const BACKUP_APP = 'LibSaver';

// Файл резервной копии -> настройки только из known (чужие ключи отбрасываются). Неверный файл - исключение с текстом для пользователя
function parseSettingsBackup(text, known) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('Это не JSON-файл');
  }
  if (data?.app !== BACKUP_APP || !data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)) {
    throw new Error('Это не резервная копия настроек LibSaver');
  }
  const settings = Object.fromEntries(Object.entries(data.settings).filter(([key, value]) => known.includes(key) && value !== null));
  if (Object.keys(settings).length === 0) throw new Error('В файле нет настроек LibSaver');
  return settings;
}

// Профили: [{ name, values }]; повреждённые записи пропускаются
async function readProfiles() {
  const { downloadProfiles } = await chrome.storage.local.get('downloadProfiles');
  return Array.isArray(downloadProfiles) ? downloadProfiles.filter(profile => typeof profile?.name === 'string' && profile.values && typeof profile.values === 'object') : [];
}

// Записать values вместо текущих настроек keys: ключи, которых в values нет, удаляются (вернутся к умолчанию).
// Затем перезагружаются все открытые разделы настроек - их поля показывают старые значения
async function replaceSettings(values, keys) {
  replacingSettings = true;
  const before = tocSignature(await chrome.storage.local.get(Object.keys(TOC_CONTROLS)));
  await chrome.storage.local.set(Object.fromEntries(keys.filter(key => key in values).map(key => [key, values[key]])));
  await chrome.storage.local.remove(keys.filter(key => !(key in values)));
  if (before !== tocSignature(await chrome.storage.local.get(Object.keys(TOC_CONTROLS)))) await resetChapterTitles();
  if (keys.includes('theme')) {
    const theme = values.theme || 'system';
    const accent = values.accentColor || 'auto';
    try {
      localStorage.setItem('theme', theme);
      localStorage.setItem('accentColor', accent);
    } catch (e) { /* без localStorage тема подхватится из storage */ }
    chrome.runtime.sendMessage({ action: 'updateTheme', theme }).catch(() => {});
    chrome.runtime.sendMessage({ action: 'updateAccent', accent }).catch(() => {});
  }
  chrome.runtime.sendMessage({ action: 'settingsReplaced' }).catch(() => {});
  location.reload();
}

// Другой раздел настроек применил профиль или импорт: перечитываем значения
chrome.runtime.onMessage.addListener(message => {
  if (message?.action !== 'settingsReplaced') return;
  replacingSettings = true;
  location.reload();
});

// Поля профилей и импорта - не настройки: автосохранение (слушает input/change на document) их не видит
function isolateFromAutosave(...elements) {
  for (const element of elements) {
    for (const type of ['input', 'change']) element?.addEventListener(type, event => event.stopPropagation());
  }
}

function setPanelStatus(id, text, isError = false) {
  const status = document.getElementById(id);
  if (!status) return;
  status.textContent = text;
  status.classList.toggle('error', isError);
}

async function initProfiles() {
  const select = document.getElementById('profile-select');
  if (!select) return;
  const nameInput = document.getElementById('profile-name');
  const applyButton = document.getElementById('btn-profile-apply');
  const deleteButton = document.getElementById('btn-profile-delete');
  isolateFromAutosave(select, nameInput);

  const render = async selected => {
    const profiles = await readProfiles();
    select.replaceChildren(...(profiles.length ? profiles.map(profile => new Option(profile.name, profile.name, false, profile.name === selected)) : [new Option('Профилей пока нет', '')]));
    select.disabled = applyButton.disabled = deleteButton.disabled = profiles.length === 0;
  };

  document.getElementById('btn-profile-save').addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) {
      setPanelStatus('profile-status', 'Введите название профиля', true);
      nameInput.focus();
      return;
    }
    await saveSettings(); // правка этого раздела могла ещё не дойти до storage
    const values = await chrome.storage.local.get(PROFILE_KEYS);
    const profiles = (await readProfiles()).filter(profile => profile.name !== name);
    await chrome.storage.local.set({ downloadProfiles: [...profiles, { name, values }] });
    nameInput.value = '';
    await render(name);
    setPanelStatus('profile-status', `Профиль «${name}» сохранён`);
  });

  applyButton.addEventListener('click', async () => {
    const profile = (await readProfiles()).find(candidate => candidate.name === select.value);
    if (!profile) return;
    setPanelStatus('profile-status', `Применяю «${profile.name}»…`);
    await replaceSettings(profile.values, PROFILE_KEYS);
  });

  deleteButton.addEventListener('click', async () => {
    const name = select.value;
    if (!name || !confirm(`Удалить профиль «${name}»?`)) return;
    await chrome.storage.local.set({ downloadProfiles: (await readProfiles()).filter(profile => profile.name !== name) });
    await render();
    setPanelStatus('profile-status', `Профиль «${name}» удалён`);
  });

  await render();
}

function initSettingsBackup() {
  const exportButton = document.getElementById('btn-settings-export');
  if (!exportButton) return;
  const fileInput = document.getElementById('settings-import-file');
  isolateFromAutosave(fileInput);

  exportButton.addEventListener('click', async () => {
    await saveSettings();
    const settings = await chrome.storage.local.get(BACKUP_KEYS);
    const data = { app: BACKUP_APP, version: chrome.runtime.getManifest().version, exportedAt: new Date().toISOString(), settings };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `LibSaver-settings-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setPanelStatus('backup-status', 'Файл настроек сохранён в загрузки');
  });

  document.getElementById('btn-settings-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const settings = parseSettingsBackup(await file.text(), BACKUP_KEYS);
      if (!confirm('Заменить текущие настройки и профили настройками из файла?')) return;
      await replaceSettings(settings, BACKUP_KEYS);
    } catch (error) {
      setPanelStatus('backup-status', `Не удалось импортировать: ${error.message}`, true);
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initProfiles().catch(error => console.error('[LibSaver] profiles', error));
  initSettingsBackup();
});
