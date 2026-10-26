// Раннее применение темы и акцентного цвета до загрузки контента
(function() {
  // Отключаем анимации при начальной загрузке (если body уже загружен)
  if (document.body) {
    document.body.classList.add('no-transition');
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
    const theme = localStorage.getItem('theme') || 'dark';
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

  // Устанавливаем дефолтный цвет (ранобе) сразу
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

  // Включаем анимации после начальной загрузки (если body загружен)
  if (document.body) {
    setTimeout(() => {
      document.body.classList.remove('no-transition');
    }, 10);
  }
})();
