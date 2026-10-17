// page-call.js - выбор вкладки сайта и вызов PAGE_CALLS в ней. Нужен и странице расширения, и service worker.

// Функция для определения сайта и API endpoint (глобальная для popup/prepare)
function getSiteConfig(url) {
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

// Сайт (siteType из getSiteConfig) по URL; null - не страница LIB-сайта
function siteKeyOf(url) {
  return getSiteConfig(url)?.siteType || null;
}

// Сайт вкладки, если вызывающий не знает его заранее
async function siteKeyOfTab(tabId) {
  return siteKeyOf((await chrome.tabs.get(tabId)).url);
}

// Шаблоны URL сайтов - те же, что content_scripts.matches в manifest.json
const SITE_TAB_PATTERNS = {
  ranobelib: ['https://ranobelib.me/*', 'https://*.ranobelib.me/*', 'https://novelslib.me/*', 'https://*.novelslib.me/*'],
  mangalib: ['https://mangalib.me/*', 'https://*.mangalib.me/*', 'https://mangalib.org/*', 'https://*.mangalib.org/*'],
  hentailib: ['https://hentailib.me/*', 'https://*.hentailib.me/*', 'https://hentailib.org/*', 'https://*.hentailib.org/*'],
  shlib: ['https://shlib.life/*', 'https://*.shlib.life/*'],
  animelib: ['https://animelib.org/*', 'https://*.animelib.org/*', 'https://anilib.me/*', 'https://*.anilib.me/*']
};

// Ссылки на главные страницы сайта: https://<домен> (без поддоменных шаблонов)
function siteLinks(siteKey) {
  return (SITE_TAB_PATTERNS[siteKey] || []).filter(pattern => !pattern.includes('*.')).map(pattern => pattern.slice(0, -2));
}

// Вызов страницы без chrome.tabs/scripting (offscreen в Chrome) идёт через service worker (см. background.js)
const hasTabApi = () => !!(chrome.tabs && chrome.scripting);

async function viaServiceWorker(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response && response.ok) return response.result;
  throw Object.assign(new Error(response?.error || 'Нет ответа от service worker'), { tabGone: !!response?.tabGone });
}

// Выгруженная вкладка не выполнит вызов
const isLoadedTab = tab => tab.status !== 'unloaded' && tab.discarded !== true;

// Вкладка сайта: предпочтительная, пока она жива, загружена и на том же сайте; иначе любая загруженная вкладка этого сайта
async function findSiteTab(siteKey, preferredTabId) {
  if (!hasTabApi()) return viaServiceWorker({ action: 'pageCall:findTab', siteKey, preferredTabId });
  if (preferredTabId != null) {
    try {
      const preferred = await chrome.tabs.get(preferredTabId);
      if (siteKeyOf(preferred.url) === siteKey && isLoadedTab(preferred)) return preferredTabId;
    } catch (e) { /* вкладки уже нет - ищем другую */ }
  }
  const tabs = await chrome.tabs.query({ url: SITE_TAB_PATTERNS[siteKey] || [] });
  const tab = tabs.find(isLoadedTab);
  return tab ? tab.id : null;
}

// Вкладка закрыта или фрейм удалён, пока шёл вызов
const TAB_GONE = /No tab with id|tab was closed|Frame with ID \d+ was removed|frame was removed/i;

async function execPageCall(tabId, name, args) {
  if (!hasTabApi()) return viaServiceWorker({ action: 'pageCall:exec', tabId, name, args });
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: PAGE_CALLS[name], args });
    return results[0]?.result;
  } catch (e) {
    if (TAB_GONE.test(e.message)) throw Object.assign(new Error(e.message), { tabGone: true });
    throw e;
  }
}

// Что делать, когда вкладки сайта нет: по умолчанию ошибка, UI подменяет на "откройте сайт и ждите"
const defaultNoTabHandler = async () => { throw new Error('Откройте страницу сайта'); };
let noTabHandler = defaultNoTabHandler;
function setNoTabHandler(fn) {
  noTabHandler = fn || defaultNoTabHandler;
}

// Выполнить PAGE_CALLS[name] во вкладке сайта; нет вкладки - ждём handler, вкладка пропала - через секунду ищем заново
async function pageCall(siteKey, name, args, preferredTabId) {
  for (;;) {
    const tabId = await findSiteTab(siteKey, preferredTabId);
    if (tabId == null) {
      await noTabHandler(siteKey);
      continue;
    }
    try {
      return await execPageCall(tabId, name, args);
    } catch (e) {
      if (!e.tabGone) throw e;
      await new Promise(resolve => setTimeout(resolve, 1000)); // вкладка, что падает раз за разом, не крутит цикл вхолостую
    }
  }
}
