// Общий модуль для управления темами и акцентными цветами

// Вспомогательная функция определения системной тёмной темы
function isSystemDark() {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
  } catch (e) {}
  return true;
}

// Функция применения темы
function applyTheme(theme) {
  if (typeof document === 'undefined' || !document.documentElement) return;

  // Отключаем анимации при смене темы
  if (document.body) {
    document.body.classList.add('no-transition');
  }

  let effectiveTheme = theme;
  if (effectiveTheme === 'system') {
    // Внутри вложенного фрейма сверяемся с родителем (если доступен), иначе с системой
    try {
      if (typeof window !== 'undefined' && window.parent && window.parent !== window && window.parent.document && window.parent.document.documentElement) {
        effectiveTheme = window.parent.document.documentElement.hasAttribute('data-theme') ? 'light' : 'dark';
      } else {
        effectiveTheme = isSystemDark() ? 'dark' : 'light';
      }
    } catch (e) {
      effectiveTheme = isSystemDark() ? 'dark' : 'light';
    }
  }

  if (effectiveTheme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }

  // Если в документе есть дочерние фреймы (например, в panel.html), передаём тему им
  try {
    const childFrames = document.querySelectorAll('iframe');
    childFrames.forEach(frame => {
      try {
        if (frame.contentDocument && frame.contentDocument.documentElement) {
          if (effectiveTheme === 'light') {
            frame.contentDocument.documentElement.setAttribute('data-theme', 'light');
          } else {
            frame.contentDocument.documentElement.removeAttribute('data-theme');
          }
        }
      } catch (e) {}
    });
  } catch (e) {}

  // Chromium не всегда перекрашивает текст <select> при смене CSS-переменных: пересоздаём их отрисовку
  try {
    document.querySelectorAll('select').forEach(select => {
      const display = select.style.display;
      select.style.display = 'none';
      void select.offsetWidth;
      select.style.display = display;
    });
  } catch (e) {}

  // Включаем анимации после смены темы
  if (document.body) {
    setTimeout(() => {
      document.body.classList.remove('no-transition');
    }, 10);
  }
}

// Функция загрузки и применения темы
async function loadAndApplyTheme() {
  const result = await chrome.storage.local.get(['theme']);
  const theme = result.theme || 'dark';
  applyTheme(theme);
  return theme;
}

// Цвета акцентов (общие с content/site-ui.js: кнопки на сайте красятся так же, как окна расширения)
const ACCENT_COLORS = {
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

// Функция применения выбранного пользователем акцентного цвета
function applyUserAccent(accent) {
  const root = document.documentElement;
  const isDark = !document.documentElement.hasAttribute('data-theme');

  const color = ACCENT_COLORS[accent];
  if (color) {
    // Отключаем анимации при смене цвета
    document.body.classList.add('no-transition');

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

    // Включаем анимации после смены цвета
    setTimeout(() => {
      document.body.classList.remove('no-transition');
    }, 10);
  }
}

// Функция применения акцентного цвета по сайту
function applySiteAccent(url) {
  const root = document.documentElement;
  const isDark = !document.documentElement.hasAttribute('data-theme');

  // Сначала проверяем настройку пользователя
  chrome.storage.local.get(['accentColor'], (result) => {
    const userAccent = result.accentColor;
    if (userAccent && userAccent !== 'auto') {
      applyUserAccent(userAccent);
      return;
    }

    // Если настройка 'auto' или не задана, используем цвет по сайту
    if (!url) {
      // Если URL нет, оставляем значения из CSS (ranobe по умолчанию)
      return;
    }

    const isSupportedSite = url.includes('ranobelib.me') ||
                           url.includes('novelslib.me') ||
                           url.includes('mangalib.me') ||
                           url.includes('mangalib.org') ||
                           url.includes('hentailib.me') || url.includes('hentailib.org') ||
                           url.includes('v2.shlib.life') ||
                           url.includes('shlib.life') ||
                           url.includes('animelib.org') ||
                           url.includes('anilib.me');

    // Отключаем анимации при смене цвета
    document.body.classList.add('no-transition');

    if (isSupportedSite) {
      // Для поддерживаемых сайтов используем прямые значения цветов
      if (url.includes('ranobelib.me') || url.includes('novelslib.me')) {
        if (isDark) {
          root.style.setProperty('--accent-color', '#1565c0');
          root.style.setProperty('--accent-hover', '#145cae');
          root.style.setProperty('--accent-soft', 'rgba(21, 101, 192, 0.2)');
          root.style.setProperty('--checkbox-color', '#2196f3');
        } else {
          root.style.setProperty('--accent-color', '#2196f3');
          root.style.setProperty('--accent-hover', '#369ff3');
          root.style.setProperty('--accent-soft', 'rgba(33, 150, 243, 0.2)');
          root.style.setProperty('--checkbox-color', '#2196f3');
        }
      } else if (url.includes('mangalib.me') || url.includes('mangalib.org')) {
        if (isDark) {
          root.style.setProperty('--accent-color', '#ef6c00');
          root.style.setProperty('--accent-hover', '#d86201');
          root.style.setProperty('--accent-soft', 'rgba(239, 108, 0, 0.2)');
          root.style.setProperty('--checkbox-color', '#ff9100');
        } else {
          root.style.setProperty('--accent-color', '#ff9100');
          root.style.setProperty('--accent-hover', '#fe9b18');
          root.style.setProperty('--accent-soft', 'rgba(255, 145, 0, 0.2)');
          root.style.setProperty('--checkbox-color', '#ff9100');
        }
      } else if (url.includes('hentailib.me') || url.includes('hentailib.org')) {
        if (isDark) {
          root.style.setProperty('--accent-color', '#b71c1c');
          root.style.setProperty('--accent-hover', '#a61a1a');
          root.style.setProperty('--accent-soft', 'rgba(183, 28, 28, 0.2)');
          root.style.setProperty('--checkbox-color', '#f44336');
        } else {
          root.style.setProperty('--accent-color', '#f44336');
          root.style.setProperty('--accent-hover', '#f45449');
          root.style.setProperty('--accent-soft', 'rgba(244, 67, 54, 0.2)');
          root.style.setProperty('--checkbox-color', '#f44336');
        }
      } else if (url.includes('v2.shlib.life') || url.includes('shlib.life')) {
        if (isDark) {
          root.style.setProperty('--accent-color', '#ad1457');
          root.style.setProperty('--accent-hover', '#9d134f');
          root.style.setProperty('--accent-soft', 'rgba(173, 20, 87, 0.2)');
          root.style.setProperty('--checkbox-color', '#d81b60');
        } else {
          root.style.setProperty('--accent-color', '#d81b60');
          root.style.setProperty('--accent-hover', '#da306e');
          root.style.setProperty('--accent-soft', 'rgba(216, 27, 96, 0.2)');
          root.style.setProperty('--checkbox-color', '#d81b60');
        }
      } else if (url.includes('animelib.org') || url.includes('anilib.me')) {
        if (isDark) {
          root.style.setProperty('--accent-color', '#5e35b1');
          root.style.setProperty('--accent-hover', '#5631a0');
          root.style.setProperty('--accent-soft', 'rgba(94, 53, 177, 0.2)');
          root.style.setProperty('--checkbox-color', '#7e57c2');
        } else {
          root.style.setProperty('--accent-color', '#5e35b1');
          root.style.setProperty('--accent-hover', '#6d48b7');
          root.style.setProperty('--accent-soft', 'rgba(94, 53, 177, 0.2)');
          root.style.setProperty('--checkbox-color', '#5e35b1');
        }
      }
    } else {
      // Для неподдерживаемых сайтов - SocialLIB цвет
      if (isDark) {
        root.style.setProperty('--accent-color', '#526cfe');
        root.style.setProperty('--accent-hover', '#425efa');
        root.style.setProperty('--accent-soft', 'rgba(82, 108, 254, 0.2)');
        root.style.setProperty('--checkbox-color', '#526cfe');
      } else {
        root.style.setProperty('--accent-color', '#526cfe');
        root.style.setProperty('--accent-hover', '#425efa');
        root.style.setProperty('--accent-soft', 'rgba(82, 108, 254, 0.2)');
        root.style.setProperty('--checkbox-color', '#526cfe');
      }
    }

    // Включаем анимации после смены цвета
    setTimeout(() => {
      document.body.classList.remove('no-transition');
    }, 10);
  });
}

// Слушатель сообщений для обновления темы (универсальный)
function setupThemeMessageListener() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'updateTheme' && message.theme) {
      applyTheme(message.theme);
      // Обновляем акцентный цвет после смены темы (из storage)
      chrome.storage.local.get(['sourceUrl'], (result) => {
        if (result.sourceUrl) {
          applySiteAccent(result.sourceUrl);
        }
      });
    } else if (message.action === 'updateAccent' && message.accent) {
      // Обновляем акцентный цвет при смене настройки
      if (message.accent === 'auto') {
        chrome.storage.local.get(['sourceUrl'], (result) => {
          if (result.sourceUrl) {
            applySiteAccent(result.sourceUrl);
          }
        });
      } else {
        applyUserAccent(message.accent);
      }
    }
  });
}

// Живой слушатель системной темы при выборе 'system'
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  try {
    const sysMedia = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSystemThemeChange = () => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['theme'], (result) => {
          if (result && result.theme === 'system') {
            applyTheme('system');
            chrome.storage.local.get(['sourceUrl', 'accentColor'], (res) => {
              if (res.accentColor && res.accentColor !== 'auto') {
                applyUserAccent(res.accentColor);
              } else if (res.sourceUrl) {
                applySiteAccent(res.sourceUrl);
              }
            });
          }
        });
      }
    };
    if (sysMedia.addEventListener) {
      sysMedia.addEventListener('change', handleSystemThemeChange);
    } else if (sysMedia.addListener) {
      sysMedia.addListener(handleSystemThemeChange);
    }
  } catch (e) {}
}

// Слушатель изменения темы через storage (только на страницах расширения, не в content scripts сайтов)
const isExtensionPage = typeof location !== 'undefined' && (location.protocol === 'chrome-extension:' || location.protocol === 'moz-extension:');
if (isExtensionPage && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.theme) {
        applyTheme(changes.theme.newValue || 'dark');
      }
      if (changes.accentColor && chrome.storage.local) {
        if (changes.accentColor.newValue === 'auto') {
          chrome.storage.local.get(['sourceUrl'], (result) => {
            if (result.sourceUrl) {
              applySiteAccent(result.sourceUrl);
            }
          });
        } else {
          applyUserAccent(changes.accentColor.newValue);
        }
      }
    }
  });
}

// Экспортируем функции для использования в других файлах
if (typeof window !== 'undefined') {
  window.applyTheme = applyTheme;
  window.applyUserAccent = applyUserAccent;
  window.applySiteAccent = applySiteAccent;
  window.loadAndApplyTheme = loadAndApplyTheme;
  window.setupThemeMessageListener = setupThemeMessageListener;
}

