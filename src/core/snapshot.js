// Снимок загрузки: всё, что нужно startDownload, фиксируется в момент нажатия «Скачать».
// Движок загрузки работает без chrome.storage, поэтому настройки и данные тайтла читаются здесь один раз.
// Ключи storage, которые читает startDownload
const SNAPSHOT_STORED_KEYS = ['rateLimit', 'metadataFieldOrder', 'fieldLabels', 'debugLogging', 'disableToc', 'currentSlug', 'speedMode', 'txtImageMarker', 'pdfFont', 'pdfFontSize', 'pdfPageSize', 'pdfLineSpacing', 'pdfParagraphSpacing', 'tocFormat', 'customTocFormat', 'hideChapterName', 'hideVolumeNumber', 'generateComicInfo', 'sameWidth', 'animeQuality', 'animeSaveInfo', 'animeSaveText', 'animeSavePoster'];

async function buildDownloadSnapshot({ slug, tabId, sourceUrl, selectedChapterIds, format, imageServer, textOnly, speedMode }) {
  const settings = await chrome.storage.local.get([...SNAPSHOT_STORED_KEYS, 'imageQuality', 'coverQuality', 'resizeMethod', 'adaptiveRatio', 'jpegQuality', 'imageFormat', 'pdfImageFormat', 'pdfJpegQuality']);
  const { titleData, originalTitleData } = await getTitleStore(['titleData', 'originalTitleData'], slug);
  const title = titleData[slug] || {};
  const metadata = title.metadata || {};
  const originalMetadata = originalTitleData[slug]?.metadata || {};
  const siteKey = siteKeyOf(sourceUrl);
  const siteType = siteTypeOf(siteKey);
  const disableToc = settings.disableToc !== undefined ? settings.disableToc : false;
  // Главы диапазона берём из title.chapters: в копиях filteredChapters нет поздних правок названий из редактора глав
  const picked = title.filteredChapters && new Set(title.filteredChapters.map(chapter => chapter.id));
  const rangeChapters = picked && title.chapters ? title.chapters.filter(chapter => picked.has(chapter.id)) : title.filteredChapters || title.chapters || [];

  const stored = Object.fromEntries(SNAPSHOT_STORED_KEYS.filter(key => key in settings).map(key => [key, settings[key]]));
  if (speedMode !== undefined) stored.speedMode = speedMode;

  const downloadData = {
    slug,
    metadata,
    originalMetadata,
    originalCover: metadata.cover || '',
    // Обложки из редактора (если пользователь их менял), иначе из API
    allCovers: title.covers !== undefined ? title.covers : (metadata.covers || (metadata.cover ? [metadata.cover] : [])),
    quality: settings.imageQuality || 'ORIGINAL',
    coverQuality: settings.coverQuality || 'ORIGINAL',
    resizeMethod: settings.resizeMethod || 'MIN_SIDE',
    adaptiveRatio: settings.adaptiveRatio || 3,
    jpegQuality: settings.jpegQuality !== undefined ? settings.jpegQuality : 1.0,
    imageFormat: settings.imageFormat || 'original',
    pdfImageFormat: settings.pdfImageFormat || 'original-png',
    pdfJpegQuality: settings.pdfJpegQuality !== undefined ? settings.pdfJpegQuality : 1.0,
    mangaId: slug,
    // Диапазон, выбранный в popup; без него — все главы
    chapters: rangeChapters,
    disableToc,
    epubTocPage: !disableToc,
    tabId,
    siteType,
    siteKey,
    selectedChapterIds,
    selectedFormat: format,
    textOnly,
    imageServer
  };

  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    slug,
    siteKey,
    siteType,
    title: metadata.titleRu || originalMetadata.titleRu || originalMetadata.titleEn || 'Без названия',
    createdAt: Date.now(),
    downloadData,
    stored,
    titleExtras: {
      chapterBranchOverrides: title.chapterBranchOverrides || {},
      translatorPriority: title.translatorPriority || [],
      allChapters: title.chapters || [],
      originalMetadata,
      sourceUrl: sourceUrl || ''
    }
  };
}
