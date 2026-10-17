// api.js - Модуль для работы с API ranobelib.me, mangalib.me, hentailib.me, shlib.life, animelib.org

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
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: async () => {
        const url = window.location.href;

        // Определяем конфигурацию сайта
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
              apiDomain: 'https://api.cdnlibs.org',
              slugPattern: /\/ru\/book\/([^-]+)(--[^?]+)?/,
              siteId: '3',
              serviceName: 'ranobelib',
              referer: `https://${hostname}/`
            };
          } else if (url.includes('mangalib.me') || url.includes('mangalib.org')) {
            return {
              apiDomain: 'https://api.cdnlibs.org',
              slugPattern: /\/ru\/manga\/([^-]+)(--[^?]+)?/,
              siteId: '1',
              serviceName: 'mangalib',
              referer: `https://${hostname}/`
            };
          } else if (url.includes('hentailib.me') || url.includes('hentailib.org')) {
            return {
              apiDomain: 'https://hapi.hentaicdn.org',
              slugPattern: /\/ru\/manga\/([^-]+)(--[^?]+)?/,
              siteId: '4',
              serviceName: 'hentailib',
              referer: `https://${hostname}/`
            };
          } else if (url.includes('v2.shlib.life') || url.includes('shlib.life')) {
            return {
              apiDomain: 'https://hapi.hentaicdn.org',
              slugPattern: /\/ru\/manga\/([^-]+)(--[^?]+)?/,
              siteId: '2',
              serviceName: 'shlib',
              referer: `https://${hostname}/`
            };
          } else if (url.includes('animelib.org') || url.includes('anilib.me')) {
            return {
              apiDomain: 'https://hapi.hentaicdn.org',
              slugPattern: /\/ru\/anime\/([^-]+)(--[^?]+)?/,
              siteId: '5',
              serviceName: 'animelib',
              referer: `https://${hostname}/`
            };
          }
          return null;
        }
        
        const config = getSiteConfig(url);
        if (!config) {
          return { success: false, error: 'Неподдерживаемый сайт' };
        }
        
        const slugMatch = url.match(config.slugPattern);
        const slug = slugMatch ? slugMatch[1] + (slugMatch[2] || '') : '';
        
        // Извлекаем JWT токен из localStorage/sessionStorage
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
        
        if (authToken) {
          headers['Authorization'] = `Bearer ${authToken}`;
        }
        
        let title = 'Тайтл';
        const h1 = document.querySelector('h1');
        if (h1) title = h1.innerText.trim();

        try {
          async function fetchWithRetry(url, options = {}, maxRetries = 3, initialDelay = 2000) {
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
          
          const chaptersUrl = `${config.apiDomain}/api/manga/${slug}/chapters`;
          
          // Для SlashLIB chapters используем siteId: 4 и x-dl-service: shlib
          if (url.includes('shlib.life')) {
            headers['Site-Id'] = '4';
            headers['X-DL-Service'] = 'shlib';
          }
          
          const response = await fetchWithRetry(chaptersUrl, { headers });
          
          if (!response.ok) {
            throw new Error('API unavailable for this title');
          }
          
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
      }
    });

    const result = results[0]?.result;
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
    const result = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        const url = window.location.href;

        // Определяем конфигурацию сайта
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
              apiDomain: 'https://api.cdnlibs.org',
              slugPattern: /\/ru\/book\/([^-]+)(--[^?]+)?/,
              siteId: '3',
              serviceName: 'ranobelib',
              referer: `https://${hostname}/`
            };
          } else if (url.includes('mangalib.me') || url.includes('mangalib.org')) {
            return {
              apiDomain: 'https://api.cdnlibs.org',
              slugPattern: /\/ru\/manga\/([^-]+)(--[^?]+)?/,
              siteId: '1',
              serviceName: 'mangalib',
              referer: `https://${hostname}/`
            };
          } else if (url.includes('hentailib.me') || url.includes('hentailib.org')) {
            return {
              apiDomain: 'https://hapi.hentaicdn.org',
              slugPattern: /\/ru\/manga\/([^-]+)(--[^?]+)?/,
              siteId: '4',
              serviceName: 'hentailib',
              referer: `https://${hostname}/`
            };
          } else if (url.includes('v2.shlib.life') || url.includes('shlib.life')) {
            return {
              apiDomain: 'https://hapi.hentaicdn.org',
              slugPattern: /\/ru\/manga\/([^-]+)(--[^?]+)?/,
              siteId: '2',
              serviceName: 'shlib',
              referer: `https://${hostname}/`
            };
          } else if (url.includes('animelib.org') || url.includes('anilib.me')) {
            return {
              apiDomain: 'https://hapi.hentaicdn.org',
              slugPattern: /\/ru\/anime\/([^-]+)(--[^?]+)?/,
              siteId: '5',
              serviceName: 'animelib',
              referer: `https://${hostname}/`
            };
          }
          return null;
        }
        
        const config = getSiteConfig(url);
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
      }
    });
      
    if (result && result[0] && result[0].result) {
      const domData = result[0].result;
      if (!domData || !domData.slug || !domData.config) {
        throw new Error('Invalid DOM data structure');
      }
      
      const apiResult = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: async (slug, config) => {
          try {
            // Извлекаем JWT токен из localStorage/sessionStorage
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
            
            if (authToken) {
              headers['Authorization'] = `Bearer ${authToken}`;
            }
            
            async function fetchWithRetry(url, options = {}, maxRetries = 3, initialDelay = 2000) {
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
            
            const url = `${config.apiDomain}/api/manga/${slug}?fields[]=background&fields[]=eng_name&fields[]=otherNames&fields[]=summary&fields[]=releaseDate&fields[]=type_id&fields[]=caution&fields[]=views&fields[]=close_view&fields[]=rate_avg&fields[]=rate&fields[]=genres&fields[]=tags&fields[]=teams&fields[]=user&fields[]=franchise&fields[]=authors&fields[]=publisher&fields[]=userRating&fields[]=moderated&fields[]=metadata&fields[]=metadata.count&fields[]=metadata.close_comments&fields[]=translation_quality_rating&fields[]=manga_status_id&fields[]=chap_count&fields[]=status_id&fields[]=artists&fields[]=format`;
            
            const response = await fetchWithRetry(url, { headers });
            
            if (!response.ok) {
              throw new Error('API request failed');
            }
            
            const data = await response.json();
            return data;
          } catch (e) {
            return null;
          }
        },
        args: [domData.slug, domData.config]
      });
      
      if (apiResult && apiResult[0] && apiResult[0].result) {
        const infoData = apiResult[0].result;
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
    const coversResult = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: async (slug) => {
        const url = window.location.href;

        // Определяем конфигурацию сайта
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
              apiDomain: 'https://api.cdnlibs.org',
              slugPattern: /\/ru\/book\/([^-]+)(--[^?]+)?/,
              siteId: '3',
              serviceName: 'ranobelib',
              referer: `https://${hostname}/`
            };
          } else if (url.includes('mangalib.me') || url.includes('mangalib.org')) {
            return {
              apiDomain: 'https://api.cdnlibs.org',
              slugPattern: /\/ru\/manga\/([^-]+)(--[^?]+)?/,
              siteId: '1',
              serviceName: 'mangalib',
              referer: `https://${hostname}/`
            };
          } else if (url.includes('hentailib.me') || url.includes('hentailib.org')) {
            return {
              apiDomain: 'https://hapi.hentaicdn.org',
              slugPattern: /\/ru\/manga\/([^-]+)(--[^?]+)?/,
              siteId: '4',
              serviceName: 'hentailib',
              referer: `https://${hostname}/`
            };
          } else if (url.includes('v2.shlib.life') || url.includes('shlib.life')) {
            return {
              apiDomain: 'https://hapi.hentaicdn.org',
              slugPattern: /\/ru\/manga\/([^-]+)(--[^?]+)?/,
              siteId: '2',
              serviceName: 'shlib',
              referer: `https://${hostname}/`
            };
          } else if (url.includes('animelib.org') || url.includes('anilib.me')) {
            return {
              apiDomain: 'https://hapi.hentaicdn.org',
              slugPattern: /\/ru\/anime\/([^-]+)(--[^?]+)?/,
              siteId: '5',
              serviceName: 'animelib',
              referer: `https://${hostname}/`
            };
          }
          return null;
        }
        
        const config = getSiteConfig(url);
        if (!config) {
          return null;
        }
        
        try {
          // Извлекаем JWT токен из localStorage/sessionStorage
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
          
          if (authToken) {
            headers['Authorization'] = `Bearer ${authToken}`;
          }
          
          async function fetchWithRetry(url, options = {}, maxRetries = 3, initialDelay = 2000) {
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
          
          const apiUrl = `${config.apiDomain}/api/manga/${slug}/covers`;
          
          // Для SlashLIB covers используем siteId: 4 и x-dl-service: shlib
          if (url.includes('shlib.life')) {
            headers['Site-Id'] = '4';
            headers['X-DL-Service'] = 'shlib';
          }
          
          const response = await fetchWithRetry(apiUrl, { headers });
          
          if (!response.ok) {
            throw new Error('API request failed');
          }
          
          const data = await response.json();
          return data;
        } catch (e) {
          return null;
        }
      },
      args: [slug]
    });
    
    if (coversResult && coversResult[0] && coversResult[0].result) {
      const coversData = coversResult[0].result;
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
    const result = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: async (chapterId, slug, imageServer) => {
        const url = window.location.href;

        // Определяем конфигурацию сайта
        function getSiteConfig(url) {
          let hostname;
          try {
            hostname = new URL(url).hostname;
          } catch (e) {
            console.error('Invalid URL:', url, e);
            return null;
          }
          if (url.includes('mangalib.me') || url.includes('mangalib.org')) {
            return {
              apiDomain: 'https://api.cdnlibs.org',
              siteId: '1',
              serviceName: 'mangalib',
              referer: `https://${hostname}/`,
              imageServerNormal: 'https://img2.imglib.info',
              imageServerCompressed: 'https://img3.cdnlibs.org'
            };
          } else if (url.includes('hentailib.me') || url.includes('hentailib.org')) {
            return {
              apiDomain: 'https://hapi.hentaicdn.org',
              siteId: '4',
              serviceName: 'hentailib',
              referer: `https://${hostname}/`,
              imageServerNormal: 'https://img2h.hentaicdn.org',
              imageServerCompressed: 'https://img3h.hentaicdn.org'
            };
          } else if (url.includes('v2.shlib.life') || url.includes('shlib.life')) {
            return {
              apiDomain: 'https://hapi.hentaicdn.org',
              siteId: '4',
              serviceName: 'shlib',
              referer: `https://${hostname}/`,
              imageServerNormal: 'https://img2h.hentaicdn.org',
              imageServerCompressed: 'https://img3h.hentaicdn.org'
            };
          }
          return null;
        }
        
        const config = getSiteConfig(url);
        if (!config) {
          return null;
        }
        
        // Выбираем сервер изображений
        const imageBaseUrl = imageServer === 'compressed' ? config.imageServerCompressed : config.imageServerNormal;
        
        try {
          // Извлекаем JWT токен из localStorage/sessionStorage
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
          
          if (authToken) {
            headers['Authorization'] = `Bearer ${authToken}`;
          }
          
          async function fetchWithRetry(url, options = {}, maxRetries = 3, initialDelay = 2000) {
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
          
          const chapterUrl = `${config.apiDomain}/api/manga/${slug}/chapter?volume=${chapterId.split('-')[0] || 1}&number=${chapterId.split('-')[1] || 0}`;
          
          const response = await fetchWithRetry(chapterUrl, { headers });
          
          if (!response.ok) {
            throw new Error('API request failed');
          }
          
          const data = await response.json();
          
          if (data && data.data && data.data.pages) {
            // Формируем полные URL для изображений
            const pages = data.data.pages.map(page => {
              const relativeUrl = page.url;
              // Заменяем // на https:// и добавляем базовый URL сервера
              const fullUrl = relativeUrl.startsWith('//') 
                ? imageBaseUrl + relativeUrl.substring(1)
                : relativeUrl.startsWith('http')
                ? relativeUrl
                : imageBaseUrl + '/' + relativeUrl;
              
              return {
                id: page.id,
                slug: page.slug,
                image: page.image,
                url: fullUrl,
                height: page.height,
                width: page.width,
                ratio: page.ratio
              };
            });
            
            return { success: true, pages, chapterId };
          }
          
          return null;
        } catch (e) {
          return null;
        }
      },
      args: [chapterId, slug, imageServer]
    });
    
    if (result && result[0] && result[0].result) {
      return result[0].result;
    }
    
    return { success: false, error: 'Не удалось загрузить страницы главы' };
  } catch (e) {
    console.error('Ошибка при загрузке страниц главы:', e);
    return { success: false, error: e.message };
  }
}

// Экспортируем функцию в window для использования в других модулях
window.loadChapterPages = loadChapterPages;
