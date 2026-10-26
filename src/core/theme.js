// Общий модуль для управления темами и акцентными цветами

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

// Функция отключения анимаций на документе
function disableTransitions(doc) {
  if (!doc) return;
  try {
    if (doc.documentElement) doc.documentElement.classList.add('no-transition');
    if (doc.body) doc.body.classList.add('no-transition');
  } catch (e) {}
}

// Функция мгновенного применения стилей и снятия no-transition в следующем кадре
function enableTransitionsDeferred(doc) {
  if (!doc) return;
  try {
    const root = doc.documentElement;
    const body = doc.body;
    if (body) {
      void body.offsetHeight;
    } else if (root) {
      void root.offsetHeight;
    }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          root?.classList?.remove('no-transition');
          body?.classList?.remove('no-transition');
        });
      });
    } else {
      setTimeout(() => {
        root?.classList?.remove('no-transition');
        body?.classList?.remove('no-transition');
      }, 50);
    }
  } catch (e) {}
}

// Синхронная установка CSS-переменных акцента на элемент
function setAccentVariables(el, color, isDark) {
  if (!el || !color) return;
  try {
    if (isDark) {
      el.style.setProperty('--accent-color', color.dark);
      el.style.setProperty('--accent-hover', color.hoverDark);
      el.style.setProperty('--accent-soft', color.dark + '33');
      el.style.setProperty('--checkbox-color', color.dark);
    } else {
      el.style.setProperty('--accent-color', color.light);
      el.style.setProperty('--accent-hover', color.hoverLight);
      el.style.setProperty('--accent-soft', color.light + '33');
      el.style.setProperty('--checkbox-color', color.light);
    }
  } catch (e) {}
}

// Вспомогательная функция определения системной тёмной темы
function isSystemDark() {
  try {
    if (typeof window !== 'undefined' && window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
  } catch (e) {}
  return true;
}

// Функция применения темы
function applyTheme(theme) {
  if (typeof document === 'undefined' || !document.documentElement) return;

  // Отключаем анимации при смене темы на html и body
  disableTransitions(document);

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

  const isDark = effectiveTheme !== 'light';
  if (effectiveTheme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }

  // Синхронно обновляем акцентный цвет под новую тему (светлую/тёмную),
  // чтобы переключение цвета происходило в том же кадре, без задержек и переливов
  let currentAccent = null;
  try {
    currentAccent = localStorage.getItem('accentColor') || document.documentElement.getAttribute('data-accent');
  } catch (e) {
    currentAccent = document.documentElement.getAttribute('data-accent');
  }
  if (currentAccent && currentAccent !== 'auto' && ACCENT_COLORS[currentAccent]) {
    setAccentVariables(document.documentElement, ACCENT_COLORS[currentAccent], isDark);
  }

  // Если в документе есть дочерние фреймы (например, в panel.html), передаём тему и акцент им
  try {
    const childFrames = document.querySelectorAll('iframe');
    childFrames.forEach(frame => {
      try {
        if (frame.contentDocument && frame.contentDocument.documentElement) {
          const frameDoc = frame.contentDocument;
          disableTransitions(frameDoc);
          if (effectiveTheme === 'light') {
            frameDoc.documentElement.setAttribute('data-theme', 'light');
          } else {
            frameDoc.documentElement.removeAttribute('data-theme');
          }
          if (currentAccent && currentAccent !== 'auto' && ACCENT_COLORS[currentAccent]) {
            setAccentVariables(frameDoc.documentElement, ACCENT_COLORS[currentAccent], isDark);
          }
          enableTransitionsDeferred(frameDoc);
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

  // Включаем анимации после смены темы с принудительным reflow
  enableTransitionsDeferred(document);
}

// Функция загрузки и применения темы
async function loadAndApplyTheme() {
  const result = await chrome.storage.local.get(['theme']);
  const theme = result.theme || 'system';
  applyTheme(theme);
  return theme;
}

// Функция применения выбранного пользователем акцентного цвета
function applyUserAccent(accent) {
  if (!accent) return;
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      localStorage.setItem('accentColor', accent);
    }
  } catch (e) {}

  const root = document.documentElement;
  if (!root) return;
  root.setAttribute('data-accent', accent);
  const isDark = !root.hasAttribute('data-theme');

  const color = ACCENT_COLORS[accent];
  if (color) {
    // Отключаем анимации при смене цвета на html и body
    disableTransitions(document);

    setAccentVariables(root, color, isDark);

    // Передаем акцент дочерним фреймам
    try {
      const childFrames = document.querySelectorAll('iframe');
      childFrames.forEach(frame => {
        try {
          if (frame.contentDocument && frame.contentDocument.documentElement) {
            const frameDoc = frame.contentDocument;
            disableTransitions(frameDoc);
            frameDoc.documentElement.setAttribute('data-accent', accent);
            const frameDark = !frameDoc.documentElement.hasAttribute('data-theme');
            setAccentVariables(frameDoc.documentElement, color, frameDark);
            enableTransitionsDeferred(frameDoc);
          }
        } catch (e) {}
      });
    } catch (e) {}

    // Передаем родителю, если мы внутри фрейма
    try {
      if (window.parent && window.parent !== window && window.parent.document && window.parent.document.documentElement) {
        if (typeof window.parent.applyUserAccent === 'function' && window.parent._lastAppliedAccent !== accent) {
          window.parent._lastAppliedAccent = accent;
          window.parent.applyUserAccent(accent);
        }
      }
    } catch (e) {}

    // Включаем анимации после смены цвета с принудительным reflow
    enableTransitionsDeferred(document);
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
      applyUserAccent('ranobe');
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
    disableTransitions(document);

    if (isSupportedSite) {
      if (url.includes('ranobelib.me') || url.includes('novelslib.me')) {
        setAccentVariables(root, ACCENT_COLORS['ranobe'], isDark);
      } else if (url.includes('mangalib.me') || url.includes('mangalib.org')) {
        setAccentVariables(root, ACCENT_COLORS['manga'], isDark);
      } else if (url.includes('hentailib.me') || url.includes('hentailib.org')) {
        setAccentVariables(root, ACCENT_COLORS['hentai'], isDark);
      } else if (url.includes('v2.shlib.life') || url.includes('shlib.life')) {
        setAccentVariables(root, ACCENT_COLORS['slash'], isDark);
      } else if (url.includes('animelib.org') || url.includes('anilib.me')) {
        setAccentVariables(root, ACCENT_COLORS['anime'], isDark);
      }
    } else {
      setAccentVariables(root, ACCENT_COLORS['social'], isDark);
    }

    // Включаем анимации после смены цвета с принудительным reflow
    enableTransitionsDeferred(document);
  });
}

// Слушатель сообщений для обновления темы (универсальный)
function setupThemeMessageListener() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'updateTheme' && message.theme) {
      applyTheme(message.theme);
      chrome.storage.local.get(['sourceUrl'], (result) => {
        if (result.sourceUrl) {
          applySiteAccent(result.sourceUrl);
        }
      });
    } else if (message.action === 'updateAccent' && message.accent) {
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
        applyTheme(changes.theme.newValue || 'system');
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
  window.ACCENT_COLORS = ACCENT_COLORS;
  window.applyTheme = applyTheme;
  window.applyUserAccent = applyUserAccent;
  window.applySiteAccent = applySiteAccent;
  window.loadAndApplyTheme = loadAndApplyTheme;
  window.setupThemeMessageListener = setupThemeMessageListener;
}
