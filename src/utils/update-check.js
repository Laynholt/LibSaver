// update-check.js - обновления по релизам GitHub: тег последнего релиза (v2.0.0) против версии манифеста
// Релизы и сообщения об ошибках — в репозитории автора (dfy-dpg)
const RELEASES_REPO = 'dfy-dpg/LibSaver';
const ISSUES_REPO = 'dfy-dpg/LibSaver';
const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases/latest`;
const RELEASE_ASSET_PREFIX = `https://github.com/${RELEASES_REPO}/releases/download/`;

// 1, если v1 новее v2; -1, если старее; 0 - равны ('2.0' и '2.0.0' равны)
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;
    if (num1 !== num2) return num1 > num2 ? 1 : -1;
  }
  return 0;
}

// Последний релиз: { version, page, zip?, xpi? }. zip/xpi - файлы релиза, только из этого репозитория
async function fetchLatestRelease(timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const release = await response.json();
    const version = String(release.tag_name || '').replace(/^v/i, '');
    if (!/^\d+(\.\d+)*$/.test(version)) throw new Error('Нет версии в релизе');
    const asset = test => (release.assets || [])
      .find(file => test(String(file.name)) && String(file.browser_download_url).startsWith(RELEASE_ASSET_PREFIX))
      ?.browser_download_url;
    return {
      version,
      page: RELEASES_PAGE,
      zip: asset(name => /\.zip$/i.test(name) && !/firefox/i.test(name)),
      xpi: asset(name => /\.xpi$/i.test(name))
    };
  } finally {
    clearTimeout(timer);
  }
}

// Обновление из последней проверки (lastUpdateCheck пишет фон раз в 6 часов); null - его нет или уведомления выключены
async function storedUpdate() {
  const { updateNotifications, lastUpdateCheck } = await chrome.storage.local.get(['updateNotifications', 'lastUpdateCheck']);
  const release = lastUpdateCheck?.release;
  if (updateNotifications === false || !release?.version) return null;
  return compareVersions(release.version, chrome.runtime.getManifest().version) > 0 ? release : null;
}

// Окну расширения внутри страницы сайта Firefox не даёт chrome.tabs: там ссылка открывается обычной новой вкладкой
function openTab(url) {
  if (chrome.tabs?.create) chrome.tabs.create({ url });
  else window.open(url, '_blank', 'noopener');
}

// Само себя расширение не перезапишет: Firefox ставит подписанный .xpi, открытый во вкладке; в Chrome скачиваем архив
// и открываем страницу релиза - там сказано, как заменить папку и нажать «Обновить» на chrome://extensions
function openUpdate(release) {
  const isFirefox = navigator.userAgent.includes('Firefox');
  if (isFirefox && release.xpi) {
    openTab(release.xpi);
    return;
  }
  if (!isFirefox && release.zip) chrome.downloads.download({ url: release.zip }).catch(() => {});
  openTab(release.page);
}
