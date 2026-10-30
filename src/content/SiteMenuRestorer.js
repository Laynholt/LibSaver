// SiteMenuRestorer.js - Content script для восстановления меню сайтов LIB

(function() {
    'use strict';

    // Встроенные SVG иконки сайтов LIB для мгновенного синхронного рендеринга без зависаний
    const SITE_SVGS = {
        mangalib: '<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 0 512 512"><path class="site-logo__corner" d="M220 78v30c0 4.42-3.58 8-8 8h-86c-5.52 0-10 4.48-10 10v86c0 4.42-3.58 8-8 8H78c-4.42 0-8-3.58-8-8V82c0-6.63 5.37-12 12-12h130c4.42 0 8 3.58 8 8zM292 434v-30c0-4.42 3.58-8 8-8h86c5.52 0 10-4.48 10-10v-86c0-4.42 3.58-8 8-8h30c4.42 0 8 3.58 8 8v130c0 6.63-5.37 12-12 12H300c-4.42 0-8-3.58-8-8z"></path><path class="site-logo__words" d="M166.68 354c-1.87 0-3.5-.7-4.9-2.1-1.4-1.4-2.1-3.03-2.1-4.9V165c0-2.05.7-3.73 2.1-5.04 1.4-1.3 3.03-1.96 4.9-1.96h30.24c3.17 0 5.5.8 7 2.38 1.49 1.59 2.42 2.85 2.8 3.78l49.28 88.2 49.28-88.2c.56-.93 1.54-2.19 2.94-3.78 1.4-1.58 3.68-2.38 6.86-2.38h29.96c2.05 0 3.78.66 5.18 1.96 1.4 1.31 2.1 2.99 2.1 5.04v182c0 1.87-.7 3.5-2.1 4.9-1.4 1.4-3.13 2.1-5.18 2.1h-33.32c-2.06 0-3.78-.7-5.18-2.1-1.4-1.4-2.1-3.03-2.1-4.9V242l-31.36 58.52c-.94 1.68-2.15 3.18-3.64 4.48-1.5 1.31-3.55 1.96-6.16 1.96h-14.56c-2.62 0-4.67-.65-6.16-1.96-1.5-1.3-2.71-2.8-3.64-4.48L207.28 242v105c0 1.87-.66 3.5-1.96 4.9-1.31 1.4-2.99 2.1-5.04 2.1h-33.6z"></path></svg>',
        hentailib: '<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 0 512 512"><path class="site-logo__corner" d="M220 78v30c0 4.42-3.58 8-8 8h-86c-5.52 0-10 4.48-10 10v86c0 4.42-3.58 8-8 8H78c-4.42 0-8-3.58-8-8V82c0-6.63 5.37-12 12-12h130c4.42 0 8 3.58 8 8zM292 434v-30c0-4.42 3.58-8 8-8h86c5.52 0 10-4.48 10-10v-86c0-4.42 3.58-8 8-8h30c4.42 0 8 3.58 8 8v130c0 6.63-5.37 12-12 12H300c-4.42 0-8-3.58-8-8z"></path><path class="site-logo__words" d="M178.3 354c-2.06 0-3.74-.65-5.04-1.96-1.31-1.3-1.96-2.98-1.96-5.04V165c0-2.05.65-3.73 1.96-5.04 1.3-1.3 2.98-1.96 5.04-1.96h36.12c2.05 0 3.78.66 5.18 1.96 1.4 1.31 2.1 2.99 2.1 5.04v67.48h68.88V165c0-2.05.65-3.73 1.96-5.04 1.3-1.3 2.98-1.96 5.04-1.96h36.12c2.05 0 3.73.66 5.04 1.96 1.3 1.31 1.96 2.99 1.96 5.04v182c0 1.87-.66 3.5-1.96 4.9-1.31 1.4-2.99 2.1-5.04 2.1h-36.12c-2.05 0-3.74-.7-5.04-2.1-1.31-1.4-1.96-3.03-1.96-4.9v-69.72H221.7V347c0 1.87-.7 3.5-2.1 4.9-1.4 1.4-3.13 2.1-5.18 2.1H178.3z"></path></svg>',
        shlib: '<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 0 512 512"><path class="site-logo__corner" d="M220 78v30c0 4.42-3.58 8-8 8h-86c-5.52 0-10 4.48-10 10v86c0 4.42-3.58 8-8 8H78c-4.42 0-8-3.58-8-8V82c0-6.63 5.37-12 12-12h130c4.42 0 8 3.58 8 8zM292 434v-30c0-4.42 3.58-8 8-8h86c5.52 0 10-4.48 10-10v-86c0-4.42 3.58-8 8-8h30c4.42 0 8 3.58 8 8v130c0 6.63-5.37 12-12 12H300c-4.42 0-8-3.58-8-8z"></path><path class="site-logo__words" d="M256 356.8c-18.7 0-34.2-2.7-46.5-8-12.3-5.3-21.7-12.3-28-20.9-6.3-8.6-9.7-17.7-10.1-27.4 0-1.5.6-2.8 1.8-4.1 1.2-1.2 2.7-1.8 4.3-1.8h35.3c2.6 0 4.6.5 6 1.4 1.4.9 2.7 2.1 3.8 3.6 1.5 2.8 3.6 5.5 6.3 8.1 2.7 2.6 6.3 4.7 10.8 6.3 4.5 1.6 9.9 2.4 16.2 2.4 10.8 0 19-1.7 24.5-5 5.5-3.4 8.3-7.9 8.3-13.7 0-4.3-1.5-7.7-4.5-10.4-3-2.6-7.8-5-14.4-7.1-6.6-2.1-15.4-4.3-26.5-6.6-14.2-3-26.3-6.9-36.3-11.6-10-4.8-17.6-11-22.8-18.8-5.2-7.7-7.8-17.4-7.8-29 0-11.4 3.2-21.6 9.7-30.5 6.4-9 15.4-16 27-21s25.3-7.6 41.2-7.6c12.9 0 24.2 1.7 34 5 9.8 3.4 18.1 7.8 24.8 13.4 6.7 5.6 11.8 11.5 15.3 17.8 3.5 6.3 5.3 12.4 5.5 18.3 0 1.5-.5 2.8-1.5 4.1-1 1.2-2.5 1.8-4.3 1.8h-37c-2.1 0-3.8-.4-5.3-1.1-1.5-.7-2.8-2-3.9-3.6-1.1-4.1-4.1-7.7-8.8-10.8s-11-4.6-18.6-4.6c-8.2 0-14.6 1.4-19.2 4.3s-6.9 7.3-6.9 13.3c0 3.7 1.3 7 3.8 9.8s6.7 5.2 12.6 7.3c5.9 2.1 14 4.2 24.2 6.4 17 3.2 30.7 7.1 41.2 11.9 10.5 4.8 18.2 10.9 23.1 18.5 4.9 7.6 7.4 17 7.4 28.4 0 12.7-3.6 23.6-10.9 32.8-7.3 9.1-17.2 16.2-29.8 21.1-12.8 5.1-27.4 7.6-44 7.6z"></path></svg>',
        ranobelib: '<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 0 512 512"><path class="site-logo__corner" d="M220 78v30c0 4.42-3.58 8-8 8h-86c-5.52 0-10 4.48-10 10v86c0 4.42-3.58 8-8 8H78c-4.42 0-8-3.58-8-8V82c0-6.63 5.37-12 12-12h130c4.42 0 8 3.58 8 8zM292 434v-30c0-4.42 3.58-8 8-8h86c5.52 0 10-4.48 10-10v-86c0-4.42 3.58-8 8-8h30c4.42 0 8 3.58 8 8v130c0 6.63-5.37 12-12 12H300c-4.42 0-8-3.58-8-8z"></path><path class="site-logo__words" d="M180.26 354c-2.05 0-3.74-.7-5.04-2.1-1.31-1.4-1.96-3.03-1.96-4.9V165c0-2.05.65-3.73 1.96-5.04 1.3-1.3 2.98-1.96 5.04-1.96h76.16c24.26 0 43.3 5.56 57.12 16.66 13.81 11.11 20.72 26.84 20.72 47.18 0 13.26-3.18 24.46-9.52 33.6-6.35 9.15-14.75 16.06-25.2 20.72l38.36 68.88c.56 1.12.84 2.15.84 3.08 0 1.5-.61 2.85-1.82 4.06-1.21 1.22-2.57 1.82-4.06 1.82h-37.24c-3.55 0-6.16-.88-7.84-2.66-1.68-1.77-2.9-3.4-3.64-4.9l-31.92-61.6h-28.56V347c0 1.87-.7 3.5-2.1 4.9-1.4 1.4-3.13 2.1-5.18 2.1h-36.12zm43.4-108.92h32.2c8.77 0 15.35-2.14 19.74-6.44 4.38-4.29 6.58-10.08 6.58-17.36 0-7.28-2.1-13.16-6.3-17.64-4.2-4.48-10.88-6.72-20.02-6.72h-32.2v48.16z"></path></svg>',
        animelib: '<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 0 512 512"><path class="site-logo__corner" d="M220 78v30c0 4.42-3.58 8-8 8h-86c-5.52 0-10 4.48-10 10v86c0 4.42-3.58 8-8 8H78c-4.42 0-8-3.58-8-8V82c0-6.63 5.37-12 12-12h130c4.42 0 8 3.58 8 8zM292 434v-30c0-4.42 3.58-8 8-8h86c5.52 0 10-4.48 10-10v-86c0-4.42 3.58-8 8-8h30c4.42 0 8 3.58 8 8v130c0 6.63-5.37 12-12 12H300c-4.42 0-8-3.58-8-8z"></path><path class="site-logo__words" d="M164.16 354c-1.5 0-2.85-.6-4.06-1.82-1.22-1.21-1.82-2.56-1.82-4.06 0-.93.09-1.77.28-2.52l65.8-179.76c.56-2.05 1.72-3.87 3.5-5.46 1.77-1.58 4.24-2.38 7.42-2.38h41.44c3.17 0 5.64.8 7.42 2.38 1.77 1.59 2.94 3.41 3.5 5.46l65.52 179.76c.37.75.56 1.59.56 2.52 0 1.5-.61 2.85-1.82 4.06-1.21 1.22-2.66 1.82-4.34 1.82h-34.44c-2.8 0-4.9-.7-6.3-2.1-1.4-1.4-2.29-2.66-2.66-3.78l-10.92-28.56h-74.76l-10.64 28.56c-.38 1.12-1.22 2.38-2.52 3.78-1.31 1.4-3.55 2.1-6.72 2.1h-34.44zm65.8-74.76h52.08L256 205.32l-26.04 73.92z"></path></svg>'
    };

    // Дефолтные ссылки сайтов (глобальная переменная для доступа из всех функций)
    window.defaultSiteMenuSites = [
        { key: 'mangalib', name: 'MangaLIB', url: 'https://mangalib.me', color: '1' },
        { key: 'hentailib', name: 'HentaiLIB', url: 'https://hentailib.me', color: '4' },
        { key: 'shlib', name: 'SlashLIB', url: 'https://v2.shlib.life', color: '2' },
        { key: 'ranobelib', name: 'RanobeLIB', url: 'https://ranobelib.me', color: '3' },
        { key: 'animelib', name: 'AnimeLIB', url: 'https://v5.animelib.org', color: '5' }
    ];

    let siteMenuEnabled = true;
    let isRestoring = false; // Мьютекс для защиты от повторного входа и бесконечных циклов
    let observerDebounce = null; // Дебаунс для MutationObserver

    // Функция нормализации URL (только если уже валиден или простой домен)
    function normalizeUrl(url) {
        if (!url) return '';
        url = url.trim();
        if (!url) return '';
        if (url.startsWith('http://') || url.startsWith('https://')) {
            return url;
        }
        return 'https://' + url;
    }

    // Функция валидации URL (строгая проверка)
    function isValidUrl(url) {
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return false;
            }
            if (!parsed.hostname || !parsed.hostname.includes('.')) {
                return false;
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    // Определение ключа сайта для существующего элемента меню
    function detectItemSiteKey(item) {
        const href = (item.getAttribute('href') || '').toLowerCase();
        if (href.includes('mangalib')) return 'mangalib';
        if (href.includes('hentailib')) return 'hentailib';
        if (href.includes('shlib')) return 'shlib';
        if (href.includes('ranobelib') || href.includes('novelslib')) return 'ranobelib';
        if (href.includes('animelib') || href.includes('anilib')) return 'animelib';

        const text = (item.textContent || '').trim().toLowerCase();
        if (text.includes('mangalib')) return 'mangalib';
        if (text.includes('hentailib')) return 'hentailib';
        if (text.includes('slashlib') || text.includes('shlib')) return 'shlib';
        if (text.includes('ranobelib')) return 'ranobelib';
        if (text.includes('animelib')) return 'animelib';

        return null;
    }

    // Определение текущего сайта (по hostname)
    function getCurrentSiteKey() {
        const hostname = window.location.hostname.toLowerCase();
        if (hostname.includes('mangalib')) return 'mangalib';
        if (hostname.includes('hentailib')) return 'hentailib';
        if (hostname.includes('shlib')) return 'shlib';
        if (hostname.includes('ranobelib') || hostname.includes('novelslib')) return 'ranobelib';
        if (hostname.includes('animelib') || hostname.includes('anilib')) return 'animelib';
        return null;
    }

    // Синхронное получение SVG с динамическими классами
    function getSvgContent(siteKey, detectedClasses) {
        let svg = SITE_SVGS[siteKey] || '';
        if (!svg) return '';
        if (detectedClasses?.corner) {
            svg = svg.replace('site-logo__corner', `${detectedClasses.corner} site-logo__corner`);
        }
        if (detectedClasses?.words) {
            svg = svg.replace('site-logo__words', `${detectedClasses.words} site-logo__words`);
        }
        return svg;
    }

    // Динамически определить CSS классы из существующих элементов конкретного меню
    function detectSiteClasses(menuList) {
        const classes = {
            menuItem: '',
            menuItemMobile: '',
            logo: '',
            corner: '',
            words: ''
        };

        const menuItems = menuList.querySelectorAll('.menu-item');
        if (menuItems.length === 0) {
            return classes;
        }

        const firstItem = menuItems[0];
        const classArray = Array.from(firstItem.classList || []);
        
        for (const cls of classArray) {
            if (cls !== 'menu-item' && !cls.startsWith('is-') && !cls.startsWith('text-')) {
                if (!classes.menuItem) {
                    classes.menuItem = cls;
                } else if (!classes.menuItemMobile) {
                    classes.menuItemMobile = cls;
                }
            }
        }

        const logoDiv = firstItem.querySelector('.site-logo') || firstItem.querySelector('div') || firstItem.querySelector('svg');
        if (logoDiv) {
            logoDiv.classList?.forEach(cls => {
                if (cls !== 'site-logo') {
                    classes.logo = cls;
                }
            });

            const cornerPath = logoDiv.querySelector('.site-logo__corner') || logoDiv.querySelector('path');
            const wordsPath = logoDiv.querySelector('.site-logo__words') || logoDiv.querySelectorAll('path')[1];
            
            if (cornerPath) {
                cornerPath.classList?.forEach(cls => {
                    if (cls !== 'site-logo__corner') {
                        classes.corner = cls;
                    }
                });
            }
            
            if (wordsPath) {
                wordsPath.classList?.forEach(cls => {
                    if (cls !== 'site-logo__words') {
                        classes.words = cls;
                    }
                });
            }
        }

        return classes;
    }

    // Создать HTML для пункта меню (100% синхронно)
    function createMenuItem(site, detectedClasses, isMobile) {
        const a = document.createElement('a');
        let menuItemClass = 'menu-item';
        if (detectedClasses?.menuItem) menuItemClass += ` ${detectedClasses.menuItem}`;
        if (isMobile && detectedClasses?.menuItemMobile) {
            menuItemClass += ` ${detectedClasses.menuItemMobile}`;
        }
        a.className = menuItemClass;
        a.href = site.url;
        
        const logoDiv = document.createElement('div');
        logoDiv.className = `${detectedClasses?.logo || ''} site-logo`.trim();
        logoDiv.setAttribute('data-site-color', site.color);
        
        const svgContent = getSvgContent(site.key, detectedClasses);
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

    // Поиск ровно 3 целевых меню сайта (ПК шапка, мобильный попап, боковое меню)
    function findTargetLibMenus() {
        const candidates = Array.from(document.querySelectorAll('.menu-list'));
        return candidates.filter(menuList => {
            // Если уже помечено нами
            if (menuList.dataset.libsaverState !== undefined) return true;

            // Проверяем, находится ли в одном из целевых контейнеров
            const inContainer = !menuList.closest || !!menuList.closest('.tippy-box, [data-tippy-root], .popup, .popup__content, .collapse, .modal, [data-header], .header, .drawer, .sidebar, .header-bottom');
            if (!inContainer) return false;

            // Проверяем, содержит ли элементы LIB сайтов
            const items = Array.from(menuList.querySelectorAll('.menu-item'));
            if (items.length === 0) return false;

            return items.some(item => !!detectItemSiteKey(item) || !!item.querySelector?.('.site-logo') || item.hasAttribute?.('data-site-color'));
        });
    }

    // Восстановление одного конкретного меню (100% синхронно и атомарно)
    function processMenu(menuList) {
        if (!siteMenuEnabled || !window.siteMenuSites) return;

        const sites = window.siteMenuSites || window.defaultSiteMenuSites;
        const currentSiteKey = getCurrentSiteKey();
        const currentHostname = window.location.hostname.toLowerCase();

        // Целевые сайты для отображения (без текущего сайта)
        const targetSites = sites.filter(site => {
            if (currentSiteKey && site.key === currentSiteKey) return false;
            try {
                const siteHost = new URL(site.url).hostname.toLowerCase();
                if (siteHost === currentHostname) return false;
            } catch (e) {}
            return true;
        });

        // Формируем сигнатуру текущего состояния меню
        const signature = targetSites.map(s => s.key + ':' + s.url).join('|');

        // Проверяем, не восстановлено ли уже меню в текущем точном виде
        if (menuList.dataset.libsaverState === signature) {
            const currentItemEls = Array.from(menuList.querySelectorAll('.menu-item'));
            const isEveryItemOurs = currentItemEls.length === targetSites.length &&
                (targetSites.length === 0 || currentItemEls.every(el => el.dataset.libsaverItem));
            if (isEveryItemOurs) return; // Меню уже в актуальном состоянии
        }

        const existingItems = Array.from(menuList.querySelectorAll('.menu-item'));
        if (existingItems.length === 0 && targetSites.length > 0) return; // Ждем рендера Vue

        // Проверяем, что это меню переключения сайтов LIB
        const isLibMenu = menuList.dataset.libsaverState !== undefined ||
            existingItems.some(item => !!detectItemSiteKey(item) || !!item.querySelector?.('.site-logo') || item.hasAttribute?.('data-site-color'));
        if (!isLibMenu) return; // Чужие меню не трогаем!

        // Устанавливаем подпись состояния
        menuList.dataset.libsaverState = signature;

        // Сохраняем существующие элементы по ключу сайта (из исходного меню)
        const existingMap = new Map();
        existingItems.forEach(item => {
            const key = item.dataset.libsaverItem || detectItemSiteKey(item);
            if (key && !existingMap.has(key)) {
                existingMap.set(key, item);
            }
        });

        const detectedClasses = detectSiteClasses(menuList);
        let isMobile = false;
        if (existingItems.length > 0 && detectedClasses?.menuItemMobile) {
            isMobile = existingItems[0].classList.contains(detectedClasses.menuItemMobile);
        }

        // Собираем все элементы во DocumentFragment для атомарной вставки без мерцания
        const fragment = document.createDocumentFragment ? document.createDocumentFragment() : document.createElement('div');

        for (const site of targetSites) {
            let item = existingMap.get(site.key);
            let targetEl;
            if (item) {
                // Клонируем родной элемент (чтобы избавиться от перехватчика Vue @click.stop.prevent)
                targetEl = item.cloneNode(true);
                targetEl.setAttribute('href', site.url);
                targetEl.href = site.url;
            } else {
                // Если сайта не было в исходном меню — создаём синхронно
                targetEl = createMenuItem(site, detectedClasses, isMobile);
            }

            if (targetEl) {
                targetEl.dataset.libsaverItem = site.key;
                // Гарантируем переход по клику на кастомную ссылку
                targetEl.addEventListener?.('click', function(e) {
                    if (e.button === 0 && !e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey) {
                        e.stopPropagation();
                        window.location.href = site.url;
                    }
                });
                fragment.appendChild(targetEl);
            }
        }

        // Атомарная замена содержимого меню
        menuList.innerHTML = '';
        if (fragment.nodeType === 11) {
            menuList.appendChild(fragment);
        } else {
            while (fragment.firstChild) {
                menuList.appendChild(fragment.firstChild);
            }
        }
    }

    // Восстановить все доступные целевые меню с защитой от повторного входа
    function restoreAllMenus() {
        if (!siteMenuEnabled || isRestoring || !window.siteMenuSites) return;
        isRestoring = true;
        try {
            const menus = findTargetLibMenus();
            for (const menuList of menus) {
                processMenu(menuList);
            }
        } finally {
            isRestoring = false;
        }
    }

    // Загрузка настроек и применение к sites
    function loadSettingsAndApply() {
        chrome.storage.local.get([
            'enableSiteMenu',
            'useCustomSiteLinks',
            'customSiteLinks',
            'siteMenuOrder',
            'disabledSites',
            'siteMirrors',
            'enableMirrorSearch'
        ], function(result) {
            if (result.enableSiteMenu === false) {
                siteMenuEnabled = false;
                return;
            }
            siteMenuEnabled = true;

            const customLinks = result.customSiteLinks || {};
            const siteMenuOrder = result.siteMenuOrder || [];
            const disabledSites = result.disabledSites || {};
            const siteMirrors = result.enableMirrorSearch !== false ? (result.siteMirrors || {}) : {};

            let sites = window.defaultSiteMenuSites.map(site => {
                const custom = customLinks[site.key];
                const customUrl = custom && [custom, normalizeUrl(custom)].find(isValidUrl);
                // Настройки сохраняют и стандартную ссылку: она не своя и не должна перебивать рабочее зеркало
                if (customUrl && customUrl.replace(/\/+$/, '') !== site.url) return { ...site, url: customUrl };
                return { ...site, url: siteMirrors[site.key] || site.url };
            });

            // Переупорядочиваем sites по сохраненному порядку
            if (siteMenuOrder.length > 0) {
                const siteIdToKey = {
                    'site-mangalib': 'mangalib',
                    'site-hentailib': 'hentailib',
                    'site-shlib': 'shlib',
                    'site-ranobelib': 'ranobelib',
                    'site-animelib': 'animelib'
                };

                const orderedSites = [];
                siteMenuOrder.forEach(siteId => {
                    const key = siteIdToKey[siteId];
                    const site = sites.find(s => s.key === key);
                    if (site) {
                        orderedSites.push(site);
                    }
                });

                sites.forEach(site => {
                    if (!orderedSites.find(s => s.key === site.key)) {
                        orderedSites.push(site);
                    }
                });

                sites = orderedSites;
            }

            // Фильтруем отключенные сайты
            sites = sites.filter(site => !disabledSites[site.key]);

            window.siteMenuSites = sites;

            // Сбрасываем сохраненную подпись у всех меню, чтобы немедленно применить новые настройки
            document.querySelectorAll('[data-libsaver-state]').forEach(el => {
                delete el.dataset.libsaverState;
            });

            restoreAllMenus();
        });
    }

    // Слушатель изменения настроек в storage
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.enableSiteMenu || changes.useCustomSiteLinks || changes.customSiteLinks ||
            changes.siteMenuOrder || changes.disabledSites || changes.siteMirrors || changes.enableMirrorSearch) {
            loadSettingsAndApply();
        }
    });

    // Наблюдатель за появлением целевых контейнеров меню (с защитой от циклов и дебаунсом)
    const observer = new MutationObserver(function(mutations) {
        if (!siteMenuEnabled || isRestoring) return;
        let shouldCheck = false;
        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1) {
                        // Игнорируем узлы, которые вставил сам LibSaver
                        if (node.dataset?.libsaverItem) continue;
                        if (
                            node.matches?.('.menu-list, .menu-item, .tippy-box, [data-tippy-root], .popup, .collapse, .modal, .site-logo') ||
                            node.querySelector?.('.menu-list, .menu-item, .site-logo')
                        ) {
                            shouldCheck = true;
                            break;
                        }
                    }
                }
            }
            if (shouldCheck) break;
        }
        if (shouldCheck) {
            if (observerDebounce) clearTimeout(observerDebounce);
            observerDebounce = setTimeout(restoreAllMenus, 16);
        }
    });

    function startObserving() {
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
            restoreAllMenus();
        } else {
            document.addEventListener('DOMContentLoaded', () => {
                observer.observe(document.body, { childList: true, subtree: true });
                restoreAllMenus();
            });
        }
    }

    startObserving();

    // Запускаем загрузку настроек
    loadSettingsAndApply();

})();
