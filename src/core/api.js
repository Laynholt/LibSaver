// api.js - Модуль для работы с API ranobelib.me, mangalib.me, hentailib.me, shlib.life, animelib.org

// Функция для извлечения текста из сложной структуры summary
function extractDescriptionText(summary) {
  if (!summary || !summary.content || !Array.isArray(summary.content)) {
    return '';
  }

  const paragraphs = [];
  
  summary.content.forEach(paragraph => {
    if (paragraph.type === 'paragraph' && paragraph.content && Array.isArray(paragraph.content)) {
      const paragraphText = extractTextFromNodes(paragraph.content);
      if (paragraphText) {
        paragraphs.push(paragraphText);
      }
    }
  });

  return paragraphs.join('\n\n');
}

// Рекурсивная функция для извлечения текста из content nodes
function extractTextFromNodes(nodes) {
  if (!nodes || !Array.isArray(nodes)) {
    return '';
  }

  let result = '';
  
  nodes.forEach(node => {
    if (node.type === 'text' && node.text) {
      result += node.text;
    }
  });

  return result;
}

// Загрузка глав
async function loadChapters(tabId) {
  try {
    const result = await pageCall(await siteKeyOfTab(tabId), 'chapters', [], tabId);
    if (!result || !result.success) {
      return { success: false, error: result?.error || 'Не удалось загрузить главы' };
    }

    return result;

  } catch (err) {
    return { success: false, error: 'Ошибка выполнения скрипта: ' + err.message };
  }
}

// Загрузка метаданных
async function loadMetadata(tabId) {
  try {
    const siteKey = await siteKeyOfTab(tabId);
    const domData = await pageCall(siteKey, 'metadata', [], tabId);

    if (domData) {
      if (!domData || !domData.slug || !domData.config) {
        throw new Error('Invalid DOM data structure');
      }
      
      const infoData = await pageCall(siteKey, 'metadataExtra', [domData.slug, domData.config], tabId);

      if (infoData) {
        if (infoData && infoData.data) {
          const metadata = {
            titleRu: infoData.data.rus_name || '',
            titleEn: infoData.data.eng_name || '',
            titleOriginal: infoData.data.name || '',
            titleAlt: Array.isArray(infoData.data.otherNames) 
              ? infoData.data.otherNames.join('\n') 
              : '',
            author: Array.isArray(infoData.data.authors) 
              ? infoData.data.authors.map(a => a?.name || '').filter(Boolean).join(', ') 
              : '',
            artist: Array.isArray(infoData.data.artists)
              ? infoData.data.artists.map(a => a?.name || '').filter(Boolean).join(', ')
              : '',
            year: infoData.data.releaseDate || '',
            status: `${infoData.data.status?.label || ''} / ${infoData.data.scanlateStatus?.label || ''}`,
            country: infoData.data.type?.label || '',
            releaseFormat: Array.isArray(infoData.data.format)
              ? infoData.data.format.map(f => f?.name || '').filter(Boolean).join(', ')
              : '',
            publisher: Array.isArray(infoData.data.publisher)
              ? infoData.data.publisher.map(p => p?.name || '').filter(Boolean).join(', ')
              : '',
            ageRestriction: infoData.data.ageRestriction?.label || '',
            description: extractDescriptionText(infoData.data.summary) || '',
            genres: Array.isArray(infoData.data.genres) 
              ? infoData.data.genres.map(g => g?.name || '').filter(Boolean).join(', ') 
              : '',
            tags: Array.isArray(infoData.data.tags)
              ? infoData.data.tags.map(t => t?.name ? `#${t.name.replace(/\s+/g, '')}` : '').filter(Boolean).join(' ')
              : '',
            cover: infoData.data.cover?.default || infoData.data.cover?.md || '',
            allCovers: [],
            totalChapters: infoData.data.items_count?.uploaded || 0
          };
          
          return { success: true, metadata, slug: domData.slug };
        }
      }
    }
    return { success: false, error: 'Не удалось загрузить метаданные' };
  } catch (e) {
    console.error('Ошибка при загрузке метаданных:', e);
    return { success: false, error: e.message };
  }
}

// Загрузка обложек
async function loadCovers(tabId, slug) {
  try {
    const coversData = await pageCall(await siteKeyOfTab(tabId), 'covers', [slug], tabId);

    if (coversData) {
      if (coversData && Array.isArray(coversData.data)) {
        const sortedCovers = coversData.data.sort((a, b) => a.order - b.order);
        const allCovers = sortedCovers.map(cover => {
          let url;
          if (typeof cover.cover === 'string') {
            url = cover.cover;
          } else if (typeof cover.cover === 'object' && cover.cover !== null) {
            url = cover.cover?.orig || cover.cover?.default;
          } else {
            url = null;
          }
          return url;
        }).filter(url => url !== null);
        
        return { success: true, covers: allCovers };
      }
    }
    return { success: false, error: 'Не удалось загрузить обложки' };
  } catch (e) {
    console.error('Ошибка при загрузке обложек:', e);
    return { success: false, error: e.message };
  }
}

// Загрузка страниц главы для манги
async function loadChapterPages(tabId, chapterId, slug, imageServer = 'normal') {
  try {
    const result = await pageCall(await siteKeyOfTab(tabId), 'chapterPages', [chapterId, slug, imageServer], tabId);

    if (result) {
      return result;
    }
    
    return { success: false, error: 'Не удалось загрузить страницы главы' };
  } catch (e) {
    console.error('Ошибка при загрузке страниц главы:', e);
    return { success: false, error: e.message };
  }
}

// Экспортируем функцию в window для использования в других модулях
window.loadChapterPages = loadChapterPages;
