// page-calls.js - функции, которые выполняются внутри вкладки сайта (chrome.scripting.executeScript).
// Тела самодостаточны: исполняются в странице, внешних переменных не видят.
const PAGE_CALLS = {
  chapters: async () => {
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
      },
  metadata: () => {
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
      },
  metadataExtra: async (slug, config) => {
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
  covers: async (slug) => {
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
  chapterPages: async (chapterId, slug, imageServer) => {
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
  mangaChapterPages: async (chapterId, volume, number, slug, serverSelection, branchId) => {
          const pageUrl = window.location.href;

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

          const config = getSiteConfig(pageUrl);
          if (!config) {
            return { success: false, error: 'Неизвестный сайт' };
          }

          const slugMatch = pageUrl.match(config.slugPattern);
          const currentSlug = slugMatch ? slugMatch[1] + (slugMatch[2] || '') : '';

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
              if (typeof v === 'string' && RE.test(v)) return v;
              if (typeof v === 'object') {
                const found = scanObj(v);
                if (found) return found;
              }
            }
            return null;
          }

          let jwtToken = null;
          try {
            jwtToken = findJwt(localStorage.getItem('auth_token')) ||
                       findJwt(localStorage.getItem('token')) ||
                       findJwt(sessionStorage.getItem('auth_token')) ||
                       findJwt(sessionStorage.getItem('token'));

            // Проверяем все ключи в localStorage
            if (!jwtToken) {
              for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                const val = localStorage.getItem(key);
                const found = findJwt(val);
                if (found) {
                  jwtToken = found;
                  break;
                }
              }
            }
          } catch (e) {
            // Ошибка при извлечении JWT - продолжаем без токена
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
            const headers = {
              'User-Agent': navigator.userAgent,
              'Accept': '*/*',
              'Accept-Language': 'ru,en-US;q=0.9,en;q=0.8',
              'Site-Id': config.siteId,
              'X-DL-Service': config.serviceName,
              'Referer': config.referer,
              'Origin': config.referer
            };

            if (jwtToken) {
              headers['Authorization'] = `Bearer ${jwtToken}`;
            }

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

          if (!data || !data.data) {
            return { success: false, error: 'No data in response' };
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
        }
};
