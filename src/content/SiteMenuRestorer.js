// SiteMenuRestorer.js - Content script для восстановления меню сайтов LIB

(function() {
    'use strict';

    // Проверяем настройку включения
    chrome.storage.local.get(['enableSiteMenu'], function(result) {
        if (result.enableSiteMenu === false) {
            return; // Скрипт отключен
        }
        try {
            initSiteMenuRestorer();
        } catch (e) {
            console.error('[SiteMenuRestorer] Ошибка при инициализации:', e);
        }
    });

    function initSiteMenuRestorer() {
        // Кэш для SVG файлов
        const svgCache = new Map();

        // Дефолтные ссылки сайтов (глобальная переменная для доступа из всех функций)
        window.defaultSiteMenuSites = [
            { key: 'mangalib', name: 'MangaLIB', url: 'https://mangalib.me', color: '1', svgFile: 'MangaLIB.svg' },
            { key: 'hentailib', name: 'HentaiLIB', url: 'https://hentailib.me', color: '4', svgFile: 'HentaiLIB.svg' },
            { key: 'shlib', name: 'SlashLIB', url: 'https://v2.shlib.life', color: '2', svgFile: 'SlashLIB.svg' },
            { key: 'ranobelib', name: 'RanobeLIB', url: 'https://ranobelib.me', color: '3', svgFile: 'RanobeLIB.svg' },
            { key: 'animelib', name: 'AnimeLIB', url: 'https://v5.animelib.org', color: '5', svgFile: 'AnimeLIB.svg' }
        ];

        // Загружаем кастомные ссылки, порядок и отключенные сайты из storage
        chrome.storage.local.get(['customSiteLinks', 'siteMenuOrder', 'disabledSites', 'siteMirrors'], function(result) {
            const customLinks = result.customSiteLinks || {};
            const siteMenuOrder = result.siteMenuOrder || [];
            const disabledSites = result.disabledSites || {};

            // Функция нормализации URL (только если уже валиден или простой домен)
            function normalizeUrl(url) {
                if (!url) return '';
                url = url.trim();
                if (!url) return '';
                // Если уже есть протокол, оставляем как есть
                if (url.startsWith('http://') || url.startsWith('https://')) {
                    return url;
                }
                // Иначе добавляем https://
                return 'https://' + url;
            }

            // Функция валидации URL (строгая проверка)
            function isValidUrl(url) {
                try {
                    const parsed = new URL(url);
                    // Проверяем что протокол http или https
                    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                        return false;
                    }
                    // Проверяем что есть hostname с точкой (минимум example.com)
                    if (!parsed.hostname || !parsed.hostname.includes('.')) {
                        return false;
                    }
                    return true;
                } catch (e) {
                    return false;
                }
            }

            let sites = window.defaultSiteMenuSites.map(site => {
                let customUrl = null;
                if (site.name === 'MangaLIB' && customLinks.mangalib) {
                    customUrl = customLinks.mangalib;
                }
                if (site.name === 'HentaiLIB' && customLinks.hentailib) {
                    customUrl = customLinks.hentailib;
                }
                if (site.name === 'SlashLIB' && customLinks.shlib) {
                    customUrl = customLinks.shlib;
                }
                if (site.name === 'RanobeLIB' && customLinks.ranobelib) {
                    customUrl = customLinks.ranobelib;
                }
                if (site.name === 'AnimeLIB' && customLinks.animelib) {
                    customUrl = customLinks.animelib;
                }

                // Сначала проверяем исходный URL
                if (customUrl && isValidUrl(customUrl)) {
                    return { ...site, url: customUrl };
                }

                // Если исходный невалиден, пробуем нормализовать (только если нет протокола)
                if (customUrl && !customUrl.startsWith('http://') && !customUrl.startsWith('https://')) {
                    const normalized = normalizeUrl(customUrl);
                    if (isValidUrl(normalized)) {
                        return { ...site, url: normalized };
                    }
                }

                // Если всё невалидно, используем дефолтный
                return site;
            });

            // Основной домен у пользователя не отвечает: ссылка по умолчанию ведёт на рабочее зеркало (своя ссылка пользователя остаётся)
            const siteMirrors = result.siteMirrors || {};
            sites = sites.map((site, index) => {
                const isDefault = site.url.replace(/\/+$/, '') === window.defaultSiteMenuSites[index].url;
                return isDefault && siteMirrors[site.key] ? { ...site, url: siteMirrors[site.key] } : site;
            });

            // Переупорядочиваем sites по сохраненному порядку
            if (siteMenuOrder.length > 0) {
                const siteIdMap = {
                    'site-mangalib': 'MangaLIB',
                    'site-hentailib': 'HentaiLIB',
                    'site-shlib': 'SlashLIB',
                    'site-ranobelib': 'RanobeLIB',
                    'site-animelib': 'AnimeLIB'
                };

                const orderedSites = [];
                siteMenuOrder.forEach(siteId => {
                    const siteName = siteIdMap[siteId];
                    if (siteName) {
                        const site = sites.find(s => s.name === siteName);
                        if (site) {
                            orderedSites.push(site);
                        }
                    }
                });

                // Добавляем сайты которых нет в сохраненном порядке
                sites.forEach(site => {
                    if (!orderedSites.find(s => s.name === site.name)) {
                        orderedSites.push(site);
                    }
                });

                sites = orderedSites;
            }

            // Фильтруем отключенные сайты
            const siteNameToKey = {
                'MangaLIB': 'mangalib',
                'HentaiLIB': 'hentailib',
                'SlashLIB': 'shlib',
                'RanobeLIB': 'ranobelib',
                'AnimeLIB': 'animelib'
            };

            sites = sites.filter(site => {
                const key = siteNameToKey[site.name];
                return !disabledSites[key];
            });

            window.siteMenuSites = sites;

            // После загрузки sites, запускаем остальные функции
            restoreSiteMenu();
        });

        // Определить текущий сайт (по hostname)
        function getCurrentSite() {
            const hostname = window.location.hostname;
            if (hostname.includes('mangalib.me') || hostname.includes('mangalib.org')) return 'mangalib';
            if (hostname.includes('hentailib.me') || hostname.includes('hentailib.org')) return 'hentailib';
            if (hostname.includes('ranobelib.me') || hostname.includes('novelslib.me')) return 'ranobelib';
            if (hostname.includes('animelib.org') || hostname.includes('anilib.me')) return 'animelib';
            if (hostname.includes('shlib.life')) return 'slashlib';
            return 'ranobelib';
        }

        // Определить семейство сайта по URL (используется для кастомных ссылок)
        function getSiteFamily(url) {
            if (url.includes('mangalib.me') || url.includes('mangalib.org')) return 'mangalib';
            if (url.includes('hentailib.me') || url.includes('hentailib.org')) return 'hentailib';
            if (url.includes('ranobelib.me') || url.includes('novelslib.me')) return 'ranobelib';
            if (url.includes('animelib.org') || url.includes('anilib.me')) return 'animelib';
            if (url.includes('shlib.life')) return 'slashlib';
            return null;
        }

        // Динамически определить CSS классы из существующих элементов конкретного меню
        function detectSiteClasses(menuList) {
            const classes = {
                menuItem: null,
                menuItemMobile: null,
                logo: null,
                corner: null,
                words: null
            };

            // Ищем существующие элементы меню в этом конкретном menuList
            const menuItems = menuList.querySelectorAll('.menu-item');

            if (menuItems.length === 0) {
                return null;
            }

            const firstItem = menuItems[0];
            
            // Извлекаем классы menu-item (исключаем базовый класс 'menu-item')
            const itemClasses = firstItem.classList;
            const classArray = Array.from(itemClasses);
            
            // Первый нестандартный класс - основной класс меню
            for (const cls of classArray) {
                if (cls !== 'menu-item' && !cls.startsWith('is-') && !cls.startsWith('text-')) {
                    if (!classes.menuItem) {
                        classes.menuItem = cls;
                    } else if (!classes.menuItemMobile) {
                        // Второй нестандартный класс - мобильный класс
                        classes.menuItemMobile = cls;
                    }
                }
            }

            // Извлекаем классы logo
            const logoDiv = firstItem.querySelector('.site-logo');
            if (logoDiv) {
                const logoClasses = logoDiv.classList;
                logoClasses.forEach(cls => {
                    if (cls !== 'site-logo') {
                        classes.logo = cls;
                    }
                });

                // Извлекаем классы corner и words из SVG
                const cornerPath = logoDiv.querySelector('.site-logo__corner');
                const wordsPath = logoDiv.querySelector('.site-logo__words');
                
                if (cornerPath) {
                    cornerPath.classList.forEach(cls => {
                        if (cls !== 'site-logo__corner') {
                            classes.corner = cls;
                        }
                    });
                }
                
                if (wordsPath) {
                    wordsPath.classList.forEach(cls => {
                        if (cls !== 'site-logo__words') {
                            classes.words = cls;
                        }
                    });
                }
            }

            // Проверяем, удалось ли определить все необходимые классы
            if (!classes.menuItem || !classes.logo || !classes.corner || !classes.words) {
                return null;
            }

            return classes;
        }

        // Загрузить SVG файл и заменить классы на динамически определенные классы с кэшированием
        async function loadSvgFile(svgFile, detectedClasses) {
            const cacheKey = `${svgFile}_${JSON.stringify(detectedClasses)}`;
            
            // Проверяем кэш
            if (svgCache.has(cacheKey)) {
                return svgCache.get(cacheKey);
            }
            
            try {
                const svgUrl = chrome.runtime.getURL(`assets/svg/${svgFile}`);
                const response = await fetch(svgUrl);
                if (!response.ok) {
                    console.error(`Ошибка загрузки SVG ${svgFile}:`, response.statusText);
                    return null;
                }
                let svgContent = await response.text();
                
                // Заменяем классы на динамически определенные классы
                svgContent = svgContent.replace(/class="[^"]*site-logo__corner[^"]*"/g, 
                    `class="${detectedClasses.corner} site-logo__corner"`);
                svgContent = svgContent.replace(/class="[^"]*site-logo__words[^"]*"/g, 
                    `class="${detectedClasses.words} site-logo__words"`);
                
                // Сохраняем в кэш
                svgCache.set(cacheKey, svgContent);
                
                return svgContent;
            } catch (error) {
                console.error(`Ошибка загрузки SVG ${svgFile}:`, error);
                return null;
            }
        }

        // Создать HTML для пункта меню
        async function createMenuItem(site, detectedClasses, isMobile) {
            const a = document.createElement('a');
            let menuItemClass = `menu-item ${detectedClasses.menuItem}`;
            if (isMobile && detectedClasses.menuItemMobile) {
                menuItemClass += ` ${detectedClasses.menuItemMobile}`;
            }
            a.className = menuItemClass;
            a.href = site.url;
            
            const logoDiv = document.createElement('div');
            logoDiv.className = `${detectedClasses.logo} site-logo`;
            logoDiv.setAttribute('data-site-color', site.color);
            
            const svgContent = await loadSvgFile(site.svgFile, detectedClasses);
            if (svgContent) {
                logoDiv.innerHTML = svgContent;
            } else {
                logoDiv.textContent = site.name.charAt(0);
            }
            
            const textDiv = document.createElement('div');
            textDiv.className = 'menu-item__text';
            textDiv.textContent = ' ' + site.name;
            
            a.appendChild(logoDiv);
            a.appendChild(textDiv);
            
            return a;
        }

        // Флаг для предотвращения множественных вызовов
        let isRestoring = false;

        // Восстановить меню сайтов
        async function restoreSiteMenu() {
            const sites = window.siteMenuSites || window.defaultSiteMenuSites;
            if (isRestoring) return;
            
            isRestoring = true;
            
            // Ищем меню с правильной структурой
            // 1. Tippy dropdown: .tippy-box > .tippy-content > .dropdown-menu > .menu > .menu-list
            const tippyDropdownMenus = document.querySelectorAll('.tippy-box > .tippy-content > .dropdown-menu > .menu > .menu-list');
            // 2. Popup menus: .popup__content > .menu > .menu-list
            const popupMenus = document.querySelectorAll('.popup__content > .menu > .menu-list');
            // 3. Collapse menus: .collapse > .collapse__content > .menu > .menu-list
            const collapseMenus = document.querySelectorAll('.collapse > .collapse__content > .menu > .menu-list');
            // 4. Mobile menus: .menu > .menu-list
            const mobileMenus = document.querySelectorAll('.menu > .menu-list');
            
            const allMenus = [...tippyDropdownMenus, ...popupMenus, ...collapseMenus, ...mobileMenus];
            
            if (allMenus.length === 0) {
                isRestoring = false;
                setTimeout(restoreSiteMenu, 100);
                return;
            }

            for (const menuList of allMenus) {
                const existingItems = menuList.querySelectorAll('.menu-item');

                // Проверяем, содержит ли меню пункты с сайтами LIB
                const hasSiteItems = Array.from(existingItems).some(item => {
                    const href = item.getAttribute('href');
                    return href && sites.some(site => href.includes(site.url));
                });

                // Проверяем, похоже ли меню на LIB-меню (по содержимому ссылок)
                const looksLikeLibMenu = Array.from(existingItems).some(item => {
                    const href = item.getAttribute('href');
                    return href && (href.includes('mangalib') || href.includes('hentailib') || 
                                  href.includes('shlib') || href.includes('ranobelib') || 
                                  href.includes('animelib') || href.includes('anilib'));
                });

                // Если меню не похоже на LIB-меню и не пустое, пропускаем его
                if (!looksLikeLibMenu && existingItems.length > 0) {
                    continue;
                }
                
                // Динамически определяем CSS классы для этого конкретного меню
                const detectedClasses = detectSiteClasses(menuList);
                
                // Если не удалось определить классы для этого меню - пропускаем
                if (!detectedClasses) {
                    continue;
                }
                
                const existingItemsMap = new Map();
                
                // Определяем мобильный режим по наличию мобильного класса у существующих элементов
                let isMobile = false;
                if (existingItems.length > 0 && detectedClasses.menuItemMobile) {
                    isMobile = existingItems[0].classList.contains(detectedClasses.menuItemMobile);
                }
                
                // Сохраняем существующие элементы в Map по URL
                existingItems.forEach(item => {
                    const href = item.getAttribute('href');
                    if (href) {
                        existingItemsMap.set(href, item);
                    }
                });

                // Очищаем меню
                menuList.innerHTML = '';

                // Добавляем все сайты в правильном порядке
                for (const site of sites) {
                    // Исключаем текущий сайт (учитываем поддомены и кастомные ссылки)
                    const siteHostname = new URL(site.url).hostname;
                    const currentHostname = window.location.hostname;
                    const currentSiteFamily = getCurrentSite();
                    const siteFamily = getSiteFamily(site.url);

                    // Если кастомная ссылка совпадает с текущим хостом - исключаем
                    if (siteHostname === currentHostname) continue;

                    // Если кастомная ссылка принадлежит тому же семейству что текущий сайт - исключаем
                    if (siteFamily && siteFamily === currentSiteFamily) continue;

                    // Для animelib.org и anilib.me исключаем все поддомены
                    if (siteHostname === 'animelib.org' && (currentHostname.includes('animelib.org') || currentHostname.includes('anilib.me'))) continue;
                    // Для mangalib.me и mangalib.org исключаем все домены
                    if (siteHostname === 'mangalib.me' && (currentHostname.includes('mangalib.me') || currentHostname.includes('mangalib.org'))) continue;
                    // Для ranobelib.me и novelslib.me исключаем все домены (novelslib.me - зеркало ranobelib.me)
                    if (siteHostname === 'ranobelib.me' && (currentHostname.includes('ranobelib.me') || currentHostname.includes('novelslib.me'))) continue;
                    // Для hentailib.me и hentailib.org исключаем все домены
                    if (siteHostname === 'hentailib.me' && (currentHostname.includes('hentailib.me') || currentHostname.includes('hentailib.org'))) continue;
                    // Для shlib.life исключаем все поддомены
                    if (siteHostname === 'v2.shlib.life' && currentHostname.includes('shlib.life')) continue;

                    let menuItem;
                    if (existingItemsMap.has(site.url)) {
                        // Используем существующий элемент
                        menuItem = existingItemsMap.get(site.url);
                    } else {
                        // Создаем новый элемент
                        menuItem = await createMenuItem(site, detectedClasses, isMobile);
                    }

                    menuList.appendChild(menuItem);
                }
            }

            isRestoring = false;
        }

        // Запускаем когда DOM готов
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', restoreSiteMenu);
        } else {
            restoreSiteMenu();
        }

        // Обработчик изменения размера окна
        let resizeTimeout;
        window.addEventListener('resize', function() {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(restoreSiteMenu, 300);
        });

        // Debouncing для MutationObserver
        let mutationTimeout;
        const observer = new MutationObserver(function(mutations) {
            let needsUpdate = false;
            
            mutations.forEach(function(mutation) {
                if (mutation.addedNodes.length > 0) {
                    mutation.addedNodes.forEach(function(node) {
                        if (node.nodeType === 1) {
                            if (node.classList && node.classList.contains('menu-list')) {
                                needsUpdate = true;
                            }
                            if (node.querySelector && node.querySelector('.menu-list')) {
                                needsUpdate = true;
                            }
                        }
                    });
                }
            });
            
            if (needsUpdate) {
                clearTimeout(mutationTimeout);
                mutationTimeout = setTimeout(restoreSiteMenu, 50);
            }
        });

        // Ограничиваем наблюдение только контейнерами меню
        const menuContainers = document.querySelectorAll('.tippy-box, .popup__content, .collapse');
        if (menuContainers.length > 0) {
            menuContainers.forEach(container => {
                observer.observe(container, {
                    childList: true,
                    subtree: true
                });
            });
        } else {
            // Fallback - наблюдаем за body если контейнеры не найдены
            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        }
    }

})();
