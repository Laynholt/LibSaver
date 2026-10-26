// Раннее применение темы и акцентного цвета до загрузки контента
(function() {
  // Отключаем анимации при начальной загрузке
  if (typeof document !== 'undefined') {
    if (document.documentElement) document.documentElement.classList.add('no-transition');
    if (document.body) document.body.classList.add('no-transition');
  }

  // Если фрейм находится внутри того же origin (panel.html), копируем тему родителя
  let parentThemeAttr = null;
  try {
    if (window.parent && window.parent !== window && window.parent.document && window.parent.document.documentElement) {
      if (window.parent.document.documentElement.hasAttribute('data-theme')) {
        parentThemeAttr = window.parent.document.documentElement.getAttribute('data-theme') || 'light';
      } else {
        parentThemeAttr = '';
      }
    }
  } catch (e) {}

  if (parentThemeAttr !== null) {
    if (parentThemeAttr) {
      document.documentElement.setAttribute('data-theme', parentThemeAttr);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  } else {
    let theme = 'system';
    try {
      theme = localStorage.getItem('theme') || 'system';
    } catch (e) {}
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else if (theme === 'system') {
      const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (!prefersDark) {
        document.documentElement.setAttribute('data-theme', 'light');
      }
    }
  }

  // Раннее применение акцентного цвета для уменьшения мерцания
  const root = document.documentElement;
  const isDark = !document.documentElement.hasAttribute('data-theme');
  let savedAccent = null;
  try {
    savedAccent = localStorage.getItem('accentColor');
  } catch (e) {}

  const ACCENTS = {
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

  const color = (savedAccent && savedAccent !== 'auto' && ACCENTS[savedAccent]) ? ACCENTS[savedAccent] : ACCENTS['ranobe'];
  if (color && root) {
    if (isDark) {
      root.style.setProperty('--accent-color', color.dark);
      root.style.setProperty('--accent-hover', color.hoverDark);
      root.style.setProperty('--accent-soft', color.dark + '33');
      root.style.setProperty('--checkbox-color', color.dark);
    } else {
      root.style.setProperty('--accent-color', color.light);
      root.style.setProperty('--accent-hover', color.hoverLight);
      root.style.setProperty('--accent-soft', color.light + '33');
      root.style.setProperty('--checkbox-color', color.light);
    }
  }

  // Включаем анимации после начальной загрузки (с принудительным reflow)
  if (document.body) {
    void document.body.offsetHeight;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document.documentElement?.classList?.remove('no-transition');
          document.body?.classList?.remove('no-transition');
        });
      });
    } else {
      setTimeout(() => {
        document.documentElement?.classList?.remove('no-transition');
        document.body?.classList?.remove('no-transition');
      }, 50);
    }
  }
})();