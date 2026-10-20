// page-helpers.js - общее для PAGE_CALLS (page-calls.js). execPageCall внедряет этот файл во вкладку сайта перед каждым вызовом.
// Мир вкладки изолированный и общий с content scripts (там уже есть getSiteConfig из page-call.js) - отсюда приставка libsaver.
// Только объявления функций: файл внедряется в ту же вкладку много раз, повторный const или let упал бы

// Та же getSiteConfig, что в utils/page-call.js (тест сверяет их): меняются вместе
function libsaverSiteConfig(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch (e) {
    console.error('Invalid URL:', url, e);
    return null;
  }

  if (url.includes('ranobelib.me') || url.includes('novelslib.me')) {
    return {
      siteType: 'ranobelib',
      apiDomain: 'https://api.cdnlibs.org',
      slugPattern: /\/ru\/book\/([^-]+)(--[^?]+)?/,
      siteId: '3',
      serviceName: 'ranobelib',
      referer: `https://${hostname}/`
    };
  } else if (url.includes('mangalib.me') || url.includes('mangalib.org')) {
    return {
      siteType: 'mangalib',
      apiDomain: 'https://api.cdnlibs.org',
      slugPattern: /\/ru\/manga\/([^-]+)(--[^?]+)?/,
      siteId: '1',
      serviceName: 'mangalib',
      referer: `https://${hostname}/`
    };
  } else if (url.includes('hentailib.me') || url.includes('hentailib.org')) {
    return {
      siteType: 'hentailib',
      apiDomain: 'https://hapi.hentaicdn.org',
      slugPattern: /\/ru\/manga\/([^-]+)(--[^?]+)?/,
      siteId: '4',
      serviceName: 'hentailib',
      referer: `https://${hostname}/`
    };
  } else if (url.includes('v2.shlib.life') || url.includes('shlib.life')) {
    return {
      siteType: 'shlib',
      apiDomain: 'https://hapi.hentaicdn.org',
      slugPattern: /\/ru\/manga\/([^-]+)(--[^?]+)?/,
      siteId: '2',
      serviceName: 'shlib',
      referer: `https://${hostname}/`
    };
  } else if (url.includes('animelib.org') || url.includes('anilib.me')) {
    return {
      siteType: 'animelib',
      apiDomain: 'https://hapi.hentaicdn.org',
      slugPattern: /\/ru\/anime\/([^-]+)(--[^?]+)?/,
      siteId: '5',
      serviceName: 'animelib',
      referer: `https://${hostname}/`
    };
  }
  return null;
}

// Заголовки запроса к API сайта; вошедшему пользователю - и его JWT из localStorage/sessionStorage
function libsaverApiHeaders(config) {
  const RE = /^eyJ[\w\-+=/]+\.eyJ[\w\-+=/]+\.[\w\-+=/]+$/;

  function findJwt(val) {
    if (typeof val !== 'string' || !val) return null;
    if (RE.test(val)) return val;
    const bare = val.startsWith('Bearer ') ? val.slice(7) : null;
    if (bare && RE.test(bare)) return bare;
    try { return scanObj(JSON.parse(val)); } catch { return null; }
  }

  function scanObj(o) {
    if (!o || typeof o !== 'object') return null;
    for (const v of Object.values(o)) {
      const f = typeof v === 'string' ? findJwt(v) : scanObj(typeof v === 'object' && v ? v : null);
      if (f) return f;
    }
    return null;
  }

  let authToken = null;
  try {
    authToken = findJwt(localStorage.getItem('auth_token')) ||
               findJwt(localStorage.getItem('token')) ||
               findJwt(sessionStorage.getItem('auth_token')) ||
               findJwt(sessionStorage.getItem('token'));

    // Полный скан только если не найдено в известных местах
    if (!authToken) {
      for (const s of [localStorage, sessionStorage]) {
        for (let i = 0; i < s.length; i++) {
          const f = findJwt(s.getItem(s.key(i)));
          if (f) { authToken = f; break; }
        }
        if (authToken) break;
      }
    }
  } catch (e) {
    // Ошибка при извлечении JWT - продолжаем без токена
  }

  const headers = {
    'User-Agent': navigator.userAgent,
    'Accept': '*/*',
    'Accept-Language': 'ru,en-US;q=0.9,en;q=0.8',
    'Site-Id': config.siteId,
    'X-DL-Service': config.serviceName,
    'Content-Type': 'application/json',
    'Referer': config.referer,
    'Origin': config.referer
  };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  return headers;
}

// fetch с повторами: 429, 408 и 5xx ждут и повторяют. Возвращает только ответ с ok, иначе ошибка
async function libsaverFetchWithRetry(url, options = {}, maxRetries = 3, initialDelay = 2000) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;

      if (response.status === 429) {
        const delay = initialDelay * Math.pow(2, attempt) + 2000;
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      // 404/403 и прочие 4xx повтор не исправит — сразу ошибка
      if (response.status < 500 && response.status !== 408) {
        throw Object.assign(new Error(`HTTP ${response.status}`), { noRetry: true });
      }

      if (attempt < maxRetries) {
        const delay = initialDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } catch (error) {
      if (error.noRetry) throw error;
      lastError = error;
      if (attempt < maxRetries) {
        const delay = initialDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError || new Error('Max retries exceeded');
}
