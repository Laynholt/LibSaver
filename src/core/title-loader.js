// title-loader.js - загрузка данных тайтла (главы, метаданные, обложки) и их кэш в хранилище, без popup и DOM.
// Нужен popup, кнопкам на сайте и панели на странице. Зависит от title-store.js, page-call.js, api.js, header.js, chapter-range.js.

const TITLE_CACHE_MAX_AGE = 10 * 60 * 1000; // 10 минут

function loadError(code) {
  return Object.assign(new Error(code), { code });
}

// Тип контента, который редакторы читают из storage.siteType
function siteTypeOf(siteKey) {
  if (siteKey === 'mangalib' || siteKey === 'hentailib' || siteKey === 'shlib') return 'manga';
  if (siteKey === 'animelib') return 'anime';
  return 'ranobe';
}

// Очистка старых titleData (старше 7 дней)
async function cleanupOldTitles() {
  try {
    const settings = await chrome.storage.local.get(['cleanupOldTitles']);
    if (settings.cleanupOldTitles === false) {
      return;
    }

    const all = await chrome.storage.local.get(null);
    const titleKeys = Object.keys(all).filter(k => k.startsWith('titleData:'));

    if (titleKeys.length === 0) return;

    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    let modified = false;
    const toDelete = [];

    for (const key of titleKeys) {
      const data = all[key];
      if (data && data.cacheTimestamp && data.cacheTimestamp < sevenDaysAgo) {
        const slug = key.split(':')[1];
        toDelete.push(key, `originalTitleData:${slug}`);
        modified = true;
      }
    }

    if (modified && toDelete.length > 0) {
      await chrome.storage.local.remove(toDelete);
    }
  } catch (error) {
    console.error('[title-loader.js] Ошибка при очистке старых тайтлов:', error);
  }
}

// Текущим становится новый тайтл; данные прежнего удаляются (как в RanobeDL), если это не отключено.
// getTitleStore отдаёт только один тайтл, поэтому ключи прежнего удаляем явно.
// Тайтл, тронутый меньше часа назад (cacheTimestamp обновляют загрузка и редакторы), остаётся: его может править окно в другой вкладке
async function switchCurrentTitle(newSlug) {
  const { currentSlug: oldSlug } = await chrome.storage.local.get(['currentSlug']);

  if (oldSlug && oldSlug !== newSlug) {
    const oldKey = titleStoreKey('titleData', oldSlug);
    const { cleanupOnTitleChange, [oldKey]: oldTitle } = await chrome.storage.local.get(['cleanupOnTitleChange', oldKey]);
    const recent = Date.now() - (oldTitle?.cacheTimestamp || 0) < 60 * 60 * 1000;
    if (cleanupOnTitleChange !== false && !recent) {
      await chrome.storage.local.remove(TITLE_STORE_KINDS.map(kind => titleStoreKey(kind, oldSlug)));
    }
  }

  await chrome.storage.local.set({ currentSlug: newSlug });
}

// Обработка сырых данных из API. savedChapters - ранее сохранённые главы тайтла: из них берутся правки displayTitle
function processChapters(chaptersList, format, savedChapters) {
  const chapters = [];

  if (!chaptersList || !Array.isArray(chaptersList)) {
    console.error('Некорректный список глав:', chaptersList);
    return chapters;
  }

  chaptersList.forEach(item => {
    // Нормализуем branches: если это объект, конвертируем в массив
    let branches = item.branches;
    if (branches && !Array.isArray(branches)) {
      branches = Object.values(branches);
    }

    const vol = item.volume || '1';
    const num = item.number || '1';
    const name = item.name || '';

    // Берем первую доступную ветку или команду
    let teamName = 'Основной перевод';
    let branchId = null;

    if (branches && branches.length > 0) {
      const firstBranch = branches[0];
      branchId = firstBranch.branch_id !== null ? String(firstBranch.branch_id) : null;

      teamName = getTranslatorName(firstBranch);
    } else if (item.team?.name) {
      teamName = item.team.name;
    }

    chapters.push({
      id: item.id,
      volume: vol,
      number: num,
      name: name,
      branchId: branchId,
      branchTeamName: teamName,
      branches: branches, // Сохраняем нормализованные branches
      displayTitle: formatChapterTitle(vol, num, name, format.tocFormat, format.customTocFormat, format.hideChapterName, format.hideVolumeNumber)
    });
  });

  // Сортировка глав по возрастанию
  chapters.sort((a, b) => {
    const vA = parseFloat(a.volume) || 0;
    const vB = parseFloat(b.volume) || 0;
    if (vA !== vB) return vA - vB;
    const nA = parseFloat(a.number) || 0;
    const nB = parseFloat(b.number) || 0;
    return nA - nB;
  });

  // Восстанавливаем сохраненные displayTitle из titleData
  if (savedChapters) {
    const savedMap = new Map(savedChapters.map(ch => [`${ch.id}_${ch.branchId || 'null'}`, ch]));

    chapters.forEach(ch => {
      const saved = savedMap.get(`${ch.id}_${ch.branchId || 'null'}`);
      if (saved && saved.displayTitle) {
        ch.displayTitle = saved.displayTitle;
      }
    });
  }

  return chapters;
}

// Настройки формата оглавления (по умолчанию как в popup)
async function readTocFormat() {
  const stored = await chrome.storage.local.get(['tocFormat', 'customTocFormat', 'hideChapterName', 'hideVolumeNumber']);
  return {
    tocFormat: stored.tocFormat || 'default',
    customTocFormat: stored.customTocFormat || '',
    hideChapterName: stored.hideChapterName ?? false,
    hideVolumeNumber: stored.hideVolumeNumber ?? false
  };
}

// Главы с выбранными переводами: применяет приоритет и сохраняет его вместе с главами в titleData
async function prepareChapters(slug, rawChapters, saved) {
  const chapters = processChapters(rawChapters, await readTocFormat(), saved?.chapters);
  const chapterBranchOverrides = saved?.chapterBranchOverrides || {};
  const translatorPriority = applyTranslatorPriority(chapters, saved?.translatorPriority || [], chapterBranchOverrides);

  const { titleData = {} } = await getTitleStore(['titleData'], slug);
  if (!titleData[slug]) {
    titleData[slug] = { chapters: null, metadata: {} };
  }
  titleData[slug].translatorPriority = translatorPriority;
  titleData[slug].chapterBranchOverrides = chapterBranchOverrides;
  titleData[slug].chapters = chapters;
  await setTitleStore({ titleData });

  return { chapters, translatorPriority, chapterBranchOverrides };
}

const displayTitleOf = (...sources) => sources.map(source => source?.titleRu || source?.titleEn || source?.titleOriginal).find(Boolean) || 'Без названия';

// Данные тайтла со страницы вкладки: из кэша (свежий и полный, 10 минут), иначе из API с сохранением в кэш.
// onProgress(n) - сколько из трёх запросов (главы, метаданные, обложки) завершено. Ошибки - Error с code:
// 'unsupported-site' | 'not-title-page' | 'load-failed'
async function loadTitleData({ tabId, url, force = false, onProgress }) {
  // Очищаем старые titleData (старше 7 дней) для предотвращения роста storage
  await cleanupOldTitles();

  const siteKey = siteKeyOf(url);
  if (!siteKey) throw loadError('unsupported-site');
  const siteType = siteTypeOf(siteKey);

  if (!(url.includes('/book/') || url.includes('/manga/') || url.includes('/anime/'))) {
    throw loadError('not-title-page');
  }

  // Извлекаем slug из URL для кэширования (тот же паттерн, что и в API)
  const slugMatch = url.match(getSiteConfig(url).slugPattern);
  const urlSlug = slugMatch ? slugMatch[1] + (slugMatch[2] || '') : null;

  // Проверяем кэш - есть ли полные данные для этого тайтла
  if (!force && urlSlug) {
    const cachedData = await getTitleStore(['titleData', 'originalTitleData'], urlSlug);
    const cached = cachedData.titleData?.[urlSlug];
    const original = cachedData.originalTitleData?.[urlSlug];
    const hasChapters = cached && cached.chapters && cached.chapters.length > 0;
    const hasMetadata = cached && cached.metadata && Object.keys(cached.metadata).length > 0;
    const hasCovers = cached && (cached.covers || cached.metadata?.cover);
    const hasOriginalMetadata = original && original.metadata && Object.keys(original.metadata).length > 0;
    const isCacheFresh = Date.now() - (cached?.cacheTimestamp || 0) < TITLE_CACHE_MAX_AGE;

    // Используем кэш если есть полные данные, они свежие и включены originalTitleData
    if (hasChapters && hasMetadata && hasCovers && hasOriginalMetadata && isCacheFresh) {
      await chrome.storage.local.set({ currentSlug: urlSlug });

      const { chapters: allChapters, translatorPriority, chapterBranchOverrides } = await prepareChapters(urlSlug, cached.chapters, cached);
      const covers = (cached.covers || (cached.metadata.cover ? [cached.metadata.cover] : [])).map(cover => cover.url ?? cover);

      return {
        slug: urlSlug, siteKey, siteType, title: displayTitleOf(cached.metadata),
        chapters: getUniqueChapters(allChapters), allChapters, covers,
        metadata: cached.metadata, originalCover: cached.metadata.cover || '',
        translatorPriority, chapterBranchOverrides
      };
    }
  }

  // Загрузка данных через API: главы, метаданные и обложки независимы, запрашиваем их сразу
  let loadedParts = 0;
  const trackProgress = promise => promise.then(result => {
    onProgress?.(++loadedParts);
    return result;
  });
  onProgress?.(0);
  const [chaptersResult, metadataResult, coversResult] = await Promise.all([
    trackProgress(loadChapters(tabId)),
    trackProgress(loadMetadata(tabId)),
    trackProgress(loadCovers(tabId, urlSlug))
  ]);

  // Главы
  if (!chaptersResult || !chaptersResult.success || !chaptersResult.chapters) {
    console.error('Главы не получены из API:', chaptersResult);
    throw loadError('load-failed');
  }
  const slug = chaptersResult.slug;

  await switchCurrentTitle(slug);

  // Загружаем приоритет переводчиков (НЕ восстанавливаем диапазон - пользователь может свободно менять его)
  const { titleData: storedTitles } = await getTitleStore(['titleData'], slug);
  const { chapters: allChapters, translatorPriority, chapterBranchOverrides } = await prepareChapters(slug, chaptersResult.chapters, storedTitles?.[slug]);

  // Метаданные
  let metadata = storedTitles?.[slug]?.metadata || {};
  let originalCover = '';
  let title = displayTitleOf(metadata);
  if (metadataResult && metadataResult.success) {
    const apiMetadata = metadataResult.metadata;
    const metadataSlug = metadataResult.slug;
    originalCover = apiMetadata.cover || '';

    const { titleData, originalTitleData } = await getTitleStore(['titleData', 'originalTitleData'], metadataSlug);

    // Инициализируем структуру если нет
    if (!titleData[metadataSlug]) {
      titleData[metadataSlug] = { chapters: null, metadata: {} };
    }
    if (!originalTitleData[metadataSlug]) {
      originalTitleData[metadataSlug] = { chapters: null, metadata: {} };
    }

    // Заголовок: правка пользователя, затем цепочка fallback по данным API
    title = (titleData[metadataSlug].metadata.titleRu || apiMetadata.titleRu || apiMetadata.titleEn || apiMetadata.titleOriginal) || 'Без названия';
    titleData[metadataSlug].itemsCount = apiMetadata.totalChapters;

    // Сохраняем оригинальные данные из API (всегда обновляем)
    originalTitleData[metadataSlug].metadata = { ...apiMetadata };

    // Сохраняем пользовательские данные только если их нет (не перезаписываем правки)
    // Проверяем по наличию хотя бы одного ключа в metadata
    if (Object.keys(titleData[metadataSlug].metadata).length === 0) {
      titleData[metadataSlug].metadata = { ...apiMetadata };
    }
    metadata = titleData[metadataSlug].metadata;

    // Сохраняем timestamp кэша (для устаревания через 10 минут)
    titleData[metadataSlug].cacheTimestamp = Date.now();

    await setTitleStore({ titleData, originalTitleData });
  } else {
    console.error('Не удалось загрузить метаданные:', metadataResult?.error);
  }

  // Обложки
  let covers;
  if (coversResult && coversResult.success) {
    covers = coversResult.covers;

    // Если covers API вернул пустой массив, fallback на metadata.cover
    if (covers.length === 0 && originalCover) {
      covers = [originalCover];
    }

    // Обновляем данные с обложками
    const { titleData, originalTitleData } = await getTitleStore(['titleData', 'originalTitleData'], slug);

    // Инициализируем структуру если нет
    if (!titleData[slug]) {
      titleData[slug] = { chapters: null, metadata: {} };
    }
    if (!originalTitleData[slug]) {
      originalTitleData[slug] = { chapters: null, metadata: {} };
    }

    // Сохраняем оригинальные обложки (всегда обновляем)
    originalTitleData[slug].covers = covers.map(url => ({ url, type: 'url' }));

    // Сохраняем пользовательские обложки только если их нет (не перезаписываем правки)
    // Перезаписываем только если массив вообще не существует, а не если он пустой
    if (!titleData[slug].covers) {
      titleData[slug].covers = covers.map(url => ({ url, type: 'url' }));
    }

    // Обновляем timestamp кэша (чтобы устаревал через 10 минут)
    titleData[slug].cacheTimestamp = Date.now();

    await setTitleStore({ titleData, originalTitleData });
  } else {
    covers = [originalCover];
  }

  return {
    slug, siteKey, siteType, title,
    chapters: getUniqueChapters(allChapters), allChapters, covers,
    metadata, originalCover,
    translatorPriority, chapterBranchOverrides
  };
}
