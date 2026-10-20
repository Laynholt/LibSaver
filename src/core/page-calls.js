// page-calls.js - функции, которые выполняются внутри вкладки сайта (chrome.scripting.executeScript).
// Внешних переменных не видят: общее (конфиг сайта, заголовки API, повторы) берут из page-helpers.js, его execPageCall внедряет перед вызовом.
const PAGE_CALLS = {
  chapters: async () => {
    const url = window.location.href;
    const config = libsaverSiteConfig(url);
    if (!config) {
      return { success: false, error: 'Неподдерживаемый сайт' };
    }

    const slugMatch = url.match(config.slugPattern);
    const slug = slugMatch ? slugMatch[1] + (slugMatch[2] || '') : '';
    const headers = libsaverApiHeaders(config);
    // Главы SlashLIB API отдаёт с Site-Id 4
    if (config.serviceName === 'shlib') headers['Site-Id'] = '4';

    let title = 'Тайтл';
    const h1 = document.querySelector('h1');
    if (h1) title = h1.innerText.trim();

    try {
      const response = await libsaverFetchWithRetry(`${config.apiDomain}/api/manga/${slug}/chapters`, { headers });
      const json = await response.json();

      if (!json || typeof json !== 'object') {
        throw new Error('Неверный формат ответа API');
      }
      if (!json.data || !Array.isArray(json.data)) {
        throw new Error('Главы не найдены или неверный формат данных');
      }

      return { success: true, title, slug, chapters: json.data, itemsCount: json.items_count };
    } catch (e) {
      return { success: false, title, error: e.toString() };
    }
  },
  metadata: () => {
    const url = window.location.href;
    const config = libsaverSiteConfig(url);
    if (!config) {
      return { slug: '', description: '', config: null };
    }

    const slugMatch = url.match(config.slugPattern);
    const slug = slugMatch ? slugMatch[1] + (slugMatch[2] || '') : '';

    // Описание - ищем в разных местах (нет в API)
    const descriptionElement = document.querySelector('.yi_b4 .text-content') ||
                               document.querySelector('.yi_b4') ||
                               document.querySelector('.description') ||
                               document.querySelector('.book-description') ||
                               document.querySelector('.content-description');
    const description = descriptionElement ? descriptionElement.textContent.trim() : '';

    return { slug, description, config };
  },
  metadataExtra: async (slug, config) => {
    try {
      const url = `${config.apiDomain}/api/manga/${slug}?fields[]=background&fields[]=eng_name&fields[]=otherNames&fields[]=summary&fields[]=releaseDate&fields[]=type_id&fields[]=caution&fields[]=views&fields[]=close_view&fields[]=rate_avg&fields[]=rate&fields[]=genres&fields[]=tags&fields[]=teams&fields[]=user&fields[]=franchise&fields[]=authors&fields[]=publisher&fields[]=userRating&fields[]=moderated&fields[]=metadata&fields[]=metadata.count&fields[]=metadata.close_comments&fields[]=translation_quality_rating&fields[]=manga_status_id&fields[]=chap_count&fields[]=status_id&fields[]=artists&fields[]=format`;
      const response = await libsaverFetchWithRetry(url, { headers: libsaverApiHeaders(config) });
      return await response.json();
    } catch (e) {
      return null;
    }
  },
  covers: async (slug) => {
    const config = libsaverSiteConfig(window.location.href);
    if (!config) {
      return null;
    }

    try {
      const headers = libsaverApiHeaders(config);
      // Обложки SlashLIB API отдаёт с Site-Id 4
      if (config.serviceName === 'shlib') headers['Site-Id'] = '4';
      const response = await libsaverFetchWithRetry(`${config.apiDomain}/api/manga/${slug}/covers`, { headers });
      return await response.json();
    } catch (e) {
      return null;
    }
  },
  mangaChapterPages: async (chapterId, volume, number, slug, serverSelection, branchId) => {
    const config = libsaverSiteConfig(window.location.href);
    if (!config) {
      return { success: false, error: 'Неизвестный сайт' };
    }

    // Формируем URL для API
    // Добавляем branch_id если он указан и не равен null (для выбора перевода)
    // Конвертируем строку 'null' обратно в null для корректного URL
    const effectiveBranchId = (branchId === 'null' || branchId === null) ? null : branchId;
    const branchParam = effectiveBranchId ? `&branch_id=${effectiveBranchId}` : '';
    const apiUrl = `${config.apiDomain}/api/manga/${slug}/chapter?volume=${volume}&number=${number}${branchParam}`;

    let lastError = null;
    let data = null;

    try {
      const headers = libsaverApiHeaders(config);
      delete headers['Content-Type']; // один GET на главу: без лишнего заголовка, как было всегда
      // Без повторов: ошибку главы base.js отдаёт пользователю (повторить или пропустить)
      const response = await fetch(apiUrl, { headers });

      if (response.ok) {
        const json = await response.json();

        if (json && json.data) {
          data = json;
        }
      }
    } catch (e) {
      lastError = e;
    }

    if (!data) {
      return { success: false, error: lastError?.message || 'Failed to fetch chapter data' };
    }

    // API возвращает массив данных
    const chapterData = Array.isArray(data.data) ? data.data[0] : data.data;
    const pages = chapterData.pages || [];

    // Сохраняем информацию о переводчике для логирования
    const downloadedTranslatorName = (chapterData.teams && chapterData.teams.length > 0)
      ? chapterData.teams[0].name || 'Неизвестный'
      : 'Неизвестный';
    const downloadedBranchId = chapterData.branch_id;

    // Определяем CDN домен на основе сервиса и выбора сервера
    const effectiveServer = serverSelection || 'normal'; // normal = img2, compressed = img3

    let cdnDomain;
    if (config.serviceName === 'hentailib') {
      // HentaiLIB использует img2h/img3h или img2/img3
      const serverPrefix = effectiveServer === 'compressed' ? 'img3h' : 'img2h';
      cdnDomain = `${serverPrefix}.hentaicdn.org`;
    } else if (config.serviceName === 'shlib') {
      // SlashLIB использует img2/img3 на hentaicdn.org или img2h/img3h (исторически)
      const serverPrefix = effectiveServer === 'compressed' ? 'img3' : 'img2';
      cdnDomain = `${serverPrefix}.hentaicdn.org`;
    } else if (config.serviceName === 'animelib') {
      const serverPrefix = effectiveServer === 'compressed' ? 'img3' : 'img2';
      cdnDomain = `${serverPrefix}.animelib.org`;
    } else {
      // MangaLIB: normal = img2.imglib.info, compressed = img3.cdnlibs.org
      if (effectiveServer === 'compressed') {
        cdnDomain = 'img3.cdnlibs.org';
      } else {
        cdnDomain = 'img2.imglib.info';
      }
    }

    // Формируем полные URL для изображений
    const formattedPages = pages.map(page => {
      let fullUrl = page.url;
      // API отдаёт путь вида //manga/..., добавляем домен и схлопываем двойной слэш
      if (fullUrl && fullUrl.startsWith('//')) {
        fullUrl = `https://${cdnDomain}${fullUrl.replace(/^\/+/, '/')}`;
      }
      return {
        ...page,
        url: fullUrl
      };
    });

    return {
      success: true,
      pages: formattedPages,
      translatorInfo: {
        downloadedTranslatorName,
        downloadedBranchId
      }
    };
  },
  // AnimeLIB: GET к API сайта из его страницы (Referer ставит браузер, без него API отвечает 403). Только пути /api/...
  animeApi: async (path) => {
    if (typeof path !== 'string' || !path.startsWith('/api/')) return { success: false, error: 'Недопустимый запрос' };
    try {
      const response = await fetch('https://hapi.hentaicdn.org' + path, { headers: { 'Site-Id': '5' } });
      if (!response.ok) return { success: false, error: `HTTP ${response.status}` };
      return { success: true, data: (await response.json()).data };
    } catch (e) {
      return { success: false, error: e.toString() };
    }
  }
};
