// Управление задержкой при открытии окон для уменьшения мерцания
(function() {
  // После загрузки DOM - создаём экран загрузки
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLoader);
  } else {
    initLoader();
  }

  function initLoader() {
    if (!document.body) {
      return;
    }

    // Создаём экран загрузки с skeleton toolbar
    const loader = document.createElement('div');
    loader.className = 'window-loader';
    loader.innerHTML = '<div class="skeleton-toolbar"></div>';
    document.documentElement.appendChild(loader);

    const MIN_DELAY = 50;
    const MAX_DELAY = 500;
    const STABILITY_TIME = 60;

    let startTime = Date.now();
    let lastMutationTime = Date.now();
    let timeoutId = null;

    // Проверяем когда цвет применён
    function isColorApplied() {
      const root = document.documentElement;
      const computedStyle = getComputedStyle(root);
      const accentColor = computedStyle.getPropertyValue('--accent-color').trim();
      return accentColor && accentColor !== '' && accentColor !== 'none';
    }

    // Проверяем через requestAnimationFrame
    function checkReady() {
      const elapsed = Date.now() - startTime;
      const stableTime = Date.now() - lastMutationTime;

      // Если прошло минимум MIN_DELAY и DOM стабилен и цвет применён
      if (elapsed >= MIN_DELAY && stableTime >= STABILITY_TIME && isColorApplied()) {
        hideLoader();
        return;
      }

      // Если прошло максимум MAX_DELAY - показываем в любом случае
      if (elapsed >= MAX_DELAY) {
        hideLoader();
        return;
      }

      // Продолжаем проверку
      requestAnimationFrame(checkReady);
    }

    function hideLoader() {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      document.body.style.opacity = '1';
      loader.remove();
    }

    // MutationObserver для отслеживания изменений в DOM
    const observer = new MutationObserver(() => {
      lastMutationTime = Date.now();
    });

    // Начинаем наблюдение за body
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class']
    });

    // Начинаем проверку готовности
    requestAnimationFrame(checkReady);
  }
})();
