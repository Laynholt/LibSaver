class EpubFormatter extends BaseFormatter {
  constructor(options) {
    super(options);
    this.zip = new JSZip();
    this.picaInstance = pica({ features: ['js'] });
  }

  getExtension() {
    return 'epub';
  }

  getMimeType() {
    return 'application/epub+zip';
  }

  async format(chapters, metadata) {
    const filteredChapters = this.filterChapters(chapters);

    // Базовая валидация входных данных
    if (!filteredChapters || filteredChapters.length === 0) {
      throw new Error('Нет глав для генерации EPUB');
    }

    if (!metadata || !metadata.titleRu) {
      console.warn('Предупреждение: отсутствует название произведения в метаданных');
    }

    // Для обнаружения глав старого формата (только ранобэ)
    const addLog = this.options.addLog || (() => {});
    const siteType = this.options.siteType || 'ranobe';
    this.isRanobe = siteType === 'ranobe' || siteType === 'ranobelib';
    
    this.zip.file("mimetype", "application/epub+zip");
    const metainf = this.zip.folder("META-INF");
    metainf.file("container.xml", `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

    const oebps = this.zip.folder("OEBPS");
    const imagesFolder = oebps.folder("images");
    const chapterFiles = [];
    
    this.addStyles(oebps);
    const coversStats = await this.processCovers(imagesFolder, oebps);
    this.addInfoPage(oebps, metadata);
    
    const imagesStats = await this.processChapters(filteredChapters, chapterFiles, imagesFolder, oebps);

    // Добавляем страницу оглавления если включено в настройках
    const disableToc = this.options.disableToc || false;
    if (!disableToc) {
      this.addTocPage(oebps, chapterFiles);
    }

    this.generateNcx(oebps, chapterFiles, metadata);
    this.generateOpf(oebps, chapterFiles, metadata, !disableToc);

    // Выводим предупреждение о главах старого формата (только для ранобэ)
    if (this.isRanobe && window.getStatisticsValue) {
      const oldFormatChaptersList = window.getStatisticsValue('oldFormatChaptersList') || [];
      if (oldFormatChaptersList.length > 0) {
        addLog('ОБНАРУЖЕНЫ ГЛАВЫ СТАРОГО ФОРМАТА:', false, '#d86201');
        oldFormatChaptersList.forEach(title => {
          addLog(title, false, '#d86201');
        });
      }
    }

    // Обновляем статистику
    if (window.setTotalChapters) {
      window.setTotalChapters(filteredChapters.length);
    }
    if (window.setTotalCovers && coversStats) {
      window.setTotalCovers(coversStats.downloaded);
    }
    if (window.setTotalImages && imagesStats) {
      window.setTotalImages(imagesStats.downloaded);
    }

    // Валидация структуры EPUB перед генерацией
    this.validateEpubStructure();

    const content = await this.generateZip(this.zip);
    const fileName = this.generateFileName(metadata) + '.epub';

    return { blob: content, filename: fileName };
  }


  addStyles(oebps) {
    oebps.file("styles.css", `
        body { font-family: serif; padding: 1em; line-height: 1.5; }
        h1 { text-align: center; margin-bottom: 0.5em; font-size: 1.3em; text-wrap: balance; }
        h2 { text-align: center; margin-bottom: 0.4em; font-size: 1.2em; text-wrap: balance; }
        h3 { text-align: center; margin-bottom: 0.3em; font-size: 1.1em; text-wrap: balance; }
        p { text-indent: 1.5em; margin: 0.5em 0; text-align: justify; }
        img { max-width: 100%; height: auto; display: block; margin: 1em auto; }
        .image-caption { text-align: center; font-style: italic; margin: 0.5em 0; text-indent: 0; }
        hr { margin: 2em 0; border: none; border-top: 1px solid #ccc; }
        .italic { font-style: italic; }
        .bold { font-weight: bold; }
        .underline { text-decoration: underline; }
        .strike { text-decoration: line-through; }
        .toc { list-style: none; padding-left: 0; }
        .toc .toc-item { margin: 0.3em 0; }
        .toc a { text-decoration: underline; color: blue; }

        /* Стили для манги */
        .manga-chapter { text-align: center; }
        .manga-page { max-width: 100%; height: auto; display: block; margin: 0 auto; }
    `);
  }

  async processCovers(imagesFolder, oebps) {
    const metadata = this.options.metadata || {};
    const coverQuality = this.options.coverQuality || 'ORIGINAL';

    if (coverQuality === 'NONE') {
      return 0;
    }

    const allCovers = this.options.allCovers ? this.options.allCovers : [metadata.cover || this.options.originalCover || ''];

    let coversDownloaded = 0;
    let coversFailed = 0;

    for (let i = 0; i < allCovers.length; i++) {
      const coverItem = allCovers[i];
      if (!coverItem) continue;

      // Если это объект с dataUrl (локальный файл), используем dataUrl
      const coverUrl = typeof coverItem === 'object' && coverItem.dataUrl
        ? coverItem.dataUrl
        : coverItem;

      const actualUrl = this.extractCoverUrl(coverUrl);
      
      if (!actualUrl) {
        if (this.options.addLog) {
          this.options.addLog(`Пропуск обложки ${i + 1}: неверный формат URL`);
          coversFailed++;
        }
        continue;
      }

      try {
        const coverBlob = await this.downloadCoverWithFallback(actualUrl, coverQuality);

        if (coverBlob) {
          const imageFormat = this.options.imageFormat || 'original';
          const coverExtension = this.getImageExtension(coverBlob, imageFormat, coverUrl);
          const coverFileName = allCovers.length > 1 ? `cover-${i + 1}${coverExtension}` : `cover${coverExtension}`;
          imagesFolder.file(coverFileName, coverBlob);

          const coverTitle = allCovers.length > 1 ? `Обложка ${i + 1}` : 'Обложка';
          let coverHtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
    <title>${coverTitle}</title>
    <style type="text/css">
        body { margin: 0; padding: 0; text-align: center; background-color: #000; }
        img { max-width: 100%; height: auto; max-height: 100%; }
    </style>
</head>
<body>
    <img src="images/${coverFileName}" alt="${coverTitle}" />
</body>
</html>`;
          const coverHtmlFileName = allCovers.length > 1 ? `cover-${i + 1}.xhtml` : 'cover.xhtml';
          oebps.file(coverHtmlFileName, coverHtml);

          coversDownloaded++;
          if (window.incrementTotalCovers) {
            window.incrementTotalCovers();
          }
        }
      } catch (e) {
        console.error(`Ошибка загрузки обложки ${i + 1}:`, e);
        coversFailed++;
        if (this.options.addLog) {
          this.options.addLog(`Ошибка загрузки обложки ${i + 1}: ${e.message}`, true);
        }
        if (this.options.incrementErrorCount) {
          this.options.incrementErrorCount();
        }
      }
    }
    
    return { downloaded: coversDownloaded, failed: coversFailed, total: allCovers.length };
  }

  addTocPage(oebps, chapterFiles) {
    if (!chapterFiles || chapterFiles.length === 0) {
      return;
    }

    let tocItems = '';
    tocItems += chapterFiles.map(ch => `<div class="toc-item"><a href="${this.escapeXml(ch.file)}">${this.escapeXml(ch.title)}</a></div>`).join('\n        ');

    const tocHtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
    <title>Оглавление</title>
    <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
    <h1>Оглавление</h1>
    <div class="toc">
        ${tocItems}
    </div>
</body>
</html>`;
    oebps.file("toc.xhtml", tocHtml);
  }

  addInfoPage(oebps, metadata) {
    const hasMetadata = (metadata.titleRu || metadata.titleEn || metadata.titleOriginal || metadata.titleAlt ||
                       metadata.author || metadata.artist || metadata.year || metadata.country ||
                       metadata.publisher || metadata.description || metadata.status ||
                       metadata.ageRestriction || metadata.genres || metadata.tags);

    if (!hasMetadata) {
      return;
    }

    // Дефолтные названия полей
    const defaultFieldLabels = {
      'title-ru': 'Название (RU)',
      'title-en': 'Название (EN)',
      'title-original': 'Название (SRC)',
      'title-alt': 'Название (ALT)',
      'author': 'Автор',
      'artist': 'Художник',
      'year': 'Год',
      'status': 'Статус',
      'country': 'Страна',
      'release-format': 'Формат',
      'publisher': 'Издатель',
      'age-restriction': 'Возрастное ограничение',
      'genres': 'Жанры',
      'tags': 'Метки',
      'description': 'Описание'
    };

    // Переименованные названия полей из options
    const fieldLabels = this.options.fieldLabels || {};

    const fieldMapping = {
      'title-ru': { label: fieldLabels['title-ru'] || defaultFieldLabels['title-ru'], value: metadata.titleRu },
      'title-en': { label: fieldLabels['title-en'] || defaultFieldLabels['title-en'], value: metadata.titleEn },
      'title-original': { label: fieldLabels['title-original'] || defaultFieldLabels['title-original'], value: metadata.titleOriginal },
      'title-alt': { label: fieldLabels['title-alt'] || defaultFieldLabels['title-alt'], value: metadata.titleAlt, format: v => v.replace(/\n/g, ', ') },
      'author': { label: fieldLabels['author'] || defaultFieldLabels['author'], value: metadata.author },
      'artist': { label: fieldLabels['artist'] || defaultFieldLabels['artist'], value: metadata.artist },
      'year': { label: fieldLabels['year'] || defaultFieldLabels['year'], value: metadata.year },
      'status': { label: fieldLabels['status'] || defaultFieldLabels['status'], value: metadata.status },
      'country': { label: fieldLabels['country'] || defaultFieldLabels['country'], value: metadata.country },
      'release-format': { label: fieldLabels['release-format'] || defaultFieldLabels['release-format'], value: metadata.releaseFormat },
      'publisher': { label: fieldLabels['publisher'] || defaultFieldLabels['publisher'], value: metadata.publisher },
      'age-restriction': { label: fieldLabels['age-restriction'] || defaultFieldLabels['age-restriction'], value: metadata.ageRestriction },
      'genres': { label: fieldLabels['genres'] || defaultFieldLabels['genres'], value: metadata.genres },
      'tags': { label: fieldLabels['tags'] || defaultFieldLabels['tags'], value: metadata.tags },
      'description': { label: fieldLabels['description'] || defaultFieldLabels['description'], value: metadata.description, format: v => v.replace(/\n/g, '<br/>') }
    };

    const fieldOrder = this.options.metadataFieldOrder || Object.keys(fieldMapping);
    
    const infoRows = fieldOrder
      .map(fieldId => fieldMapping[fieldId])
      .filter(field => field && field.value)
      .map(field => {
          const value = this.escapeXml(field.value);
          const formattedValue = field.format ? field.format(value) : value;
          return `<div class="info-row"><span class="info-label"><strong>${this.escapeXml(field.label)}:</strong> </span><span class="info-value">${formattedValue}</span></div>`;
      })
      .join('');

    const infoHtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
    <title>Информация о произведении</title>
    <link rel="stylesheet" type="text/css" href="styles.css"/>
    <style>
        .info-table { margin: 2em auto; max-width: 600px; }
        .info-row { display: flex; margin-bottom: 0.5em; }
        .info-label { min-width: 150px; }
        .info-value { flex: 1; margin-left: 5px; }
        .description { margin-top: 2em; padding: 1em; }
    </style>
</head>
<body>
    <h1>Информация о произведении</h1>
    <div class="info-table">
        ${infoRows}
    </div>
</body>
</html>`;
    oebps.file("info.xhtml", infoHtml);
  }

  async processChapters(chapters, chapterFiles, imagesFolder, oebps) {
    // Определяем тип контента (манга или ранобэ)
    const siteType = this.options.siteType || 'ranobe';
    const isManga = siteType === 'manga' || siteType === 'hentai' || siteType === 'shlib';

    if (isManga) {
      return await this.processMangaChapters(chapters, chapterFiles, imagesFolder, oebps);
    }

    // Обработка ранобэ (текст)
    let totalImagesDownloaded = 0;
    let totalImagesFailed = 0;
    let globalImageCounter = 1; // Глобальный счетчик для нумерации картинок

    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      let chapterImagesDownloaded = 0;
      let chapterImagesFailed = 0;

      // Случайная пауза между главами (централизованная логика)
      if (typeof window.maybeAddRandomPause === 'function') {
        await window.maybeAddRandomPause(i, this.options.addLog);
      }
      
      // Используем переданную функцию addLog если она есть
      if (this.options.addLog) {
        this.options.addLog(`[${i + 1}/${chapters.length}] ЗАГРУЗКА: ${ch.displayTitle}...`);
      }
      
      let chapterContent, attachments;
      let shouldRetry = false;

      // Цикл для повторных попыток
      do {
        shouldRetry = false;
        try {
          const result = await this.fetchChapterData(ch);
          chapterContent = result.chapterContent;
          attachments = result.attachments;
        } catch (error) {
          // При ошибке загрузки главы - ставим на паузу и ждём решения пользователя
          if (this.options.addLog) {
            this.options.addLog(`Ошибка загрузки главы: ${error.message}`, true);
          }

          // Сохраняем информацию об ошибке для retry/skip
          if (this.options.onChapterError) {
            const errorResult = await this.options.onChapterError(ch, error, i);
            if (errorResult && errorResult.shouldRetry) {
              this.options.addLog(`Повторная попытка загрузки главы...`);
              shouldRetry = true;
              continue;
            } else {
              // Если пользователь выбрал skip - продолжаем к следующей главе
              break;
            }
          } else {
            // Если нет обработчика ошибок - выбрасываем исключение как раньше
            throw error;
          }
        }
      } while (shouldRetry);

      // Если после retry всё равно не удалось загрузить - пропускаем главу
      if (!chapterContent) {
        continue;
      }

      // Проверяем на старый формат (только для ранобэ)
      if (this.isRanobe && typeof chapterContent === 'string') {
        if (this.options.addOldFormatChapter) {
          this.options.addOldFormatChapter(ch.displayTitle);
        }
      }

      const attachmentMap = this.buildAttachmentMap(attachments);
      
      let mangaId = this.extractMangaId(attachments);
      
      const htmlContent = await this.convertJsonToHtml(chapterContent, imagesFolder, {
        mangaId: mangaId,
        chapterId: ch.id || '',
        attachmentMap: attachmentMap,
        attachments: attachments,
        imageFormat: this.options.imageFormat,
        onImageDownloaded: () => {
          chapterImagesDownloaded++;
          totalImagesDownloaded++;
          if (window.incrementTotalImages) {
            window.incrementTotalImages();
          }
        },
        onImageFailed: () => { chapterImagesFailed++; totalImagesFailed++; },
        getNextImageNumber: () => {
          const num = globalImageCounter++;
          return String(num).padStart(4, '0');
        }
      });
      
      const fileName = `chapter_${i + 1}.xhtml`;
      const noHeaders = this.options.settings?.tocFormat === 'no_headers';
      const fullHtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
    <title>${this.escapeXml(ch.displayTitle)}</title>
    <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
    ${noHeaders ? '' : `<h1>${this.escapeXml(ch.displayTitle)}</h1>`}
    ${htmlContent}
</body>
</html>`;
      oebps.file(fileName, fullHtml);
      chapterFiles.push({ title: ch.displayTitle, file: fileName });

      // Используем переданную функцию updateProgress если она есть
      if (this.options.updateProgress) {
        this.options.updateProgress(i + 1, chapters.length);
      }
      
      // Используем переданную функцию updateChapterIndex если она есть
      if (this.options.updateChapterIndex) {
        this.options.updateChapterIndex(i + 1);
      }

      // Инкрементируем счётчик глав для статистики
      if (window.incrementTotalChapters) {
        window.incrementTotalChapters();
      }

      // Используем переданную функцию recordChapterTime если она есть
      if (this.options.recordChapterTime) {
        this.options.recordChapterTime();
      }

      // Используем переданную функцию addFileSize если она есть
      if (this.options.addFileSize) {
        this.options.addFileSize(fullHtml.length);
      }
    }
    
    return { downloaded: totalImagesDownloaded, failed: totalImagesFailed };
  }

  async processMangaChapters(chapters, chapterFiles, imagesFolder, oebps) {
    const addLog = this.options.addLog || (() => {});
    const imageQuality = this.options.quality || 'ORIGINAL';
    const imageServer = this.options.imageServer || 'normal';
    const tabId = this.options.tabId;
    const slug = this.options.slug;
    const chapterBranchOverrides = this.options.chapterBranchOverrides || {};
    const translatorPriority = this.options.translatorPriority || [];

    // Если выбрано "Без картинок", пропускаем мангу
    if (imageQuality === 'NONE') {
      return { downloaded: 0, failed: 0 };
    }

    let totalImagesDownloaded = 0;
    let totalImagesFailed = 0;
    let globalImageCounter = 1;

    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      let chapterImagesDownloaded = 0;
      let chapterImagesFailed = 0;

      // Случайная пауза между главами
      if (typeof window.maybeAddRandomPause === 'function') {
        await window.maybeAddRandomPause(i, addLog);
      }

      addLog(`[${i + 1}/${chapters.length}] ЗАГРУЗКА: ${ch.displayTitle}...`);

      // Определяем branch_id для текущей главы
      let branchId = null;
      let selectedTranslatorName = 'Неизвестный';

      // Функция для получения имени переводчика из chapter.branches по branch_id
      const getTranslatorNameFromBranches = (targetBranchId) => {
        if (!ch.branches || !Array.isArray(ch.branches)) {
          return 'Неизвестный';
        }
        const normalizedTargetId = targetBranchId === null ? 'null' : String(targetBranchId);
        const branch = ch.branches.find(b => {
          const branchBranchId = b.branch_id === null ? 'null' : String(b.branch_id);
          return branchBranchId === normalizedTargetId;
        });
        if (branch && branch.teams && branch.teams.length > 0) {
          return branch.teams[0].name || 'Неизвестный';
        }
        return 'Неизвестный';
      };

      if (chapterBranchOverrides[ch.id]) {
        const translatorKey = chapterBranchOverrides[ch.id];
        branchId = translatorKey.split('_')[0];
        selectedTranslatorName = getTranslatorNameFromBranches(branchId);
      } else if (translatorPriority.length > 0 && ch.branches && Array.isArray(ch.branches)) {
        for (const translatorKey of translatorPriority) {
          const priorityBranchId = translatorKey.split('_')[0];
          const hasBranch = ch.branches.some(branch => {
            const branchBranchId = branch.branch_id === null ? 'null' : String(branch.branch_id);
            return branchBranchId === priorityBranchId;
          });
          if (hasBranch) {
            branchId = priorityBranchId;
            selectedTranslatorName = getTranslatorNameFromBranches(branchId);
            break;
          }
        }
      } else if (ch.branches && ch.branches.length > 0) {
        branchId = ch.branches[0].branch_id;
        selectedTranslatorName = getTranslatorNameFromBranches(branchId);
      }

      // Определяем правильный chapter_id для выбранного branch_id
      let chapterId = ch.id;
      if (branchId && ch.branches && Array.isArray(ch.branches)) {
        const branchChapter = ch.branches.find(b => String(b.branch_id) === String(branchId));
        if (branchChapter) {
          chapterId = branchChapter.id;
        }
      }

      // Загружаем страницы главы
      let pagesResult;
      let shouldRetry = false;

      do {
        shouldRetry = false;
        try {
          pagesResult = await this.loadMangaChapterPages(tabId, chapterId, ch.volume, ch.number, slug, imageServer, branchId, selectedTranslatorName);

          // Логируем переводчик если включен debugMode
          if (pagesResult.success && pagesResult.translatorInfo && this.options.debug && this.options.onTranslatorSelected) {
            const tempChapter = { volume: ch.volume, number: ch.number };
            this.options.onTranslatorSelected(
              tempChapter,
              selectedTranslatorName,
              branchId,
              pagesResult.translatorInfo.downloadedTranslatorName,
              pagesResult.translatorInfo.downloadedBranchId
            );
          }
        } catch (error) {
          addLog(`Ошибка загрузки страниц: ${error.message}`, true);

          if (this.options.onChapterError) {
            const errorResult = await this.options.onChapterError(ch, error, i);
            if (errorResult && errorResult.shouldRetry) {
              addLog(`Повторная попытка загрузки главы...`);
              shouldRetry = true;
              continue;
            } else {
              break;
            }
          } else {
            break;
          }
        }
      } while (shouldRetry);

      if (!pagesResult || !pagesResult.success) {
        addLog(`Пропуск главы: ${pagesResult?.error || 'Unknown error'}`, true);
        continue;
      }

      // Создаем HTML страницу с картинками
      let chapterHtml = '';
      let pageIndex = 0;
      while (pageIndex < pagesResult.pages.length) {
        const page = pagesResult.pages[pageIndex];
        try {
          const imgNum = String(globalImageCounter++).padStart(4, '0');
          const imageResult = await this.downloadAndResizeImage(page.url, imageQuality, this.options.imageFormat, 'картинка');
          if (imageResult && imageResult.blob) {
            const imageBlob = imageResult.blob;
            const imageFormat = this.options.imageFormat || 'original';
            const imgExtension = this.getImageExtension(imageBlob, imageFormat, page.url);
            const imgFileName = `page_${imgNum}${imgExtension}`;
            imagesFolder.file(imgFileName, imageBlob);
            chapterHtml += `<img src="images/${imgFileName}" class="manga-page" alt="Страница ${imgNum}" />\n`;
            chapterImagesDownloaded++;
            totalImagesDownloaded++;

            if (this.options.addFileSize) {
              this.options.addFileSize(imageBlob.size);
            }

            // Пауза между картинками
            if (typeof window.maybeAddImagePause === 'function') {
              await window.maybeAddImagePause(addLog);
            }
            pageIndex++; // Переходим к следующей картинке
          } else {
            chapterImagesFailed++;
            totalImagesFailed++;
            // Для манги останавливаем главу при ошибке картинки
            if (this.options.onImageError) {
              const errorResult = await this.options.onImageError(ch, new Error('Не удалось загрузить изображение'), i, page.url);
              if (errorResult && errorResult.shouldRetry) {
                addLog(`Повторная попытка загрузки изображения...`);
                // Не увеличиваем pageIndex - повторяем ту же картинку
                continue;
              } else {
                addLog(`Изображение пропущено пользователем`);
                if (this.options.incrementSkippedImagesCount) {
                  this.options.incrementSkippedImagesCount();
                }
                pageIndex++; // Переходим к следующей картинке
                continue;
              }
            } else {
              break;
            }
          }
        } catch (error) {
          addLog(`    Ошибка загрузки изображения: ${error.message}`, true);
          chapterImagesFailed++;
          totalImagesFailed++;
          // Для манги останавливаем главу при ошибке картинки
          if (this.options.onImageError) {
            const errorResult = await this.options.onImageError(ch, error, i, page.url);
            if (errorResult && errorResult.shouldRetry) {
              addLog(`Повторная попытка загрузки изображения...`);
              // Не увеличиваем pageIndex - повторяем ту же картинку
              continue;
            } else {
              addLog(`Изображение пропущено пользователем`);
              if (this.options.incrementSkippedImagesCount) {
                this.options.incrementSkippedImagesCount();
              }
              pageIndex++; // Переходим к следующей картинке
              continue;
            }
          } else {
            break;
          }
        }
      }

      // Создаем файл главы
      const fileName = `chapter_${i + 1}.xhtml`;
      const noHeaders = this.options.settings?.tocFormat === 'no_headers';
      const fullHtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
    <title>${this.escapeXml(ch.displayTitle)}</title>
    <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
    ${noHeaders ? '' : `<h1>${this.escapeXml(ch.displayTitle)}</h1>`}
    <div class="manga-chapter">
${chapterHtml}
    </div>
</body>
</html>`;
      oebps.file(fileName, fullHtml);
      chapterFiles.push({ title: ch.displayTitle, file: fileName });

      // Обновляем прогресс
      if (this.options.updateProgress) {
        this.options.updateProgress(i + 1, chapters.length);
      }

      if (this.options.updateChapterIndex) {
        this.options.updateChapterIndex(i + 1);
      }

      // Инкрементируем счётчик глав для статистики
      if (window.incrementTotalChapters) {
        window.incrementTotalChapters();
      }

      if (this.options.recordChapterTime) {
        this.options.recordChapterTime();
      }

    }

    return { downloaded: totalImagesDownloaded, failed: totalImagesFailed };
  }

  async convertJsonToHtml(node, imagesFolder, context = {}) {
    if (!node) return "";

    const imageQuality = this.options.quality || 'ORIGINAL';
    const disableImages = imageQuality === 'NONE';
    const onImageDownloaded = context.onImageDownloaded || (() => {});
    const onImageFailed = context.onImageFailed || (() => {});
    const imageFormat = context.imageFormat || this.options.imageFormat || 'original';

    if (typeof node === 'string') {
      // Если есть attachments, встраиваем их в HTML перед парсингом
      if (context.attachments && Array.isArray(context.attachments) && context.attachments.length > 0) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = node;

        // Находим все элементы и вставляем картинки из attachments в правильные места
        const existingImages = tempDiv.querySelectorAll('img');
        if (existingImages.length === 0 && context.attachments.length > 0) {
          // Если в HTML нет картинок, добавляем все attachments в конец
          for (const attachment of context.attachments) {
            const imgUrl = attachment.url;
            if (imgUrl) {
              const img = document.createElement('img');
              img.src = imgUrl;
              img.alt = attachment.name || 'Иллюстрация';
              tempDiv.appendChild(img);
            }
          }
        } else {
          // Если есть img теги, заменяем пустые src на реальные URL из attachments
          let attachmentIndex = 0;
          for (const img of existingImages) {
            const src = img.getAttribute('src');
            if (!src || src === '' || src.startsWith('data:image')) {
              if (attachmentIndex < context.attachments.length) {
                const attachment = context.attachments[attachmentIndex];
                img.src = attachment.url;
                img.alt = attachment.name || 'Иллюстрация';
                attachmentIndex++;
              }
            }
          }
        }

        node = tempDiv.innerHTML;
      }

      const parser = new DOMParser();
      const doc = parser.parseFromString(`<div>${node}</div>`, 'text/html');
      this.sanitizeChapterDom(doc.body);
      if (disableImages) {
        this.replaceImagesWithPlaceholders(doc, true);
        return this.serializeXhtml(doc.body);
      }

      const images = doc.querySelectorAll('img');
      for (const img of images) {
        const src = img.getAttribute('src');
        if (src) {
          try {
            const getNextImageNumber = context.getNextImageNumber || (() => `img_${Math.random().toString(36).substr(2, 9)}`);
            const imageResult = await this.downloadAndResizeImage(src, this.options.quality, imageFormat, 'картинка');
            const blob = imageResult?.blob;
            if (!blob) throw new Error('пустой ответ сервера картинок');
            if (imagesFolder) {
              const imageFormat = this.options.imageFormat || 'original';
              const imgExtension = this.getImageExtension(blob, imageFormat, src);
              const imgId = `${getNextImageNumber()}${imgExtension}`;
              imagesFolder.file(imgId, blob);
              img.setAttribute('src', `images/${imgId}`);
            } else {
              const reader = new FileReader();
              const base64 = await new Promise(r => {
                reader.onloadend = () => r(reader.result);
                reader.readAsDataURL(blob);
              });
              img.setAttribute('src', base64);
            }
            onImageDownloaded();
          } catch (e) {
            if (this.options.addLog) {
              this.options.addLog(`Error loading image ${src}: ${e.message}`, true);
            }
            if (this.options.incrementErrorCount) {
              this.options.incrementErrorCount();
            }
            onImageFailed();
            img.outerHTML = '<span class="image-placeholder">[Не удалось загрузить картинку]</span>';
          }
        }
      }
      return this.serializeXhtml(doc.body);
    }

    if (Array.isArray(node)) {
      let html = "";
      for (const item of node) html += await this.convertJsonToHtml(item, imagesFolder, context);
      return html;
    }

    if (node.type === 'doc') return await this.convertJsonToHtml(node.content, imagesFolder, context);
    
    if (node.type === 'heading') {
      const level = node.attrs?.level || 1;
      const align = node.attrs?.textAlign || '';
      const alignStyle = align ? ` style="text-align: ${align}"` : '';
      const content = await this.convertJsonToHtml(node.content, imagesFolder, context) || '';
      return `<h${level}${alignStyle}>${content}</h${level}>`;
    }
    
    if (node.type === 'paragraph') {
      const align = node.attrs?.textAlign || '';
      const alignStyle = align ? ` style="text-align: ${align}"` : '';
      const content = await this.convertJsonToHtml(node.content, imagesFolder, context) || '&#160;';
      return `<p${alignStyle}>${content}</p>`;
    }
    
    if (node.type === 'horizontalRule') return '<hr/>';
    
    if (node.type === 'hardBreak') return '<br/>';
    
    if (node.type === 'text') {
      let text = this.escapeXml(node.text);
      if (node.marks) {
        node.marks.forEach(mark => {
          if (mark.type === 'italic') text = `<em>${text}</em>`;
          else if (mark.type === 'bold') text = `<strong>${text}</strong>`;
          else if (mark.type === 'underline') text = `<u>${text}</u>`;
          else if (mark.type === 'strike') text = `<s>${text}</s>`;
        });
      }
      return text;
    }

    if (node.type === 'image') {
      const caption = node.attrs?.description || '';
      const captionHtml = caption ? `<p class="image-caption">${this.escapeXml(caption)}</p>` : '';

      if (this.options.quality === 'NONE') {
        return `${captionHtml}<span class="image-placeholder">[Картинка пропущена]</span>`;
      }

      const imagesData = node.attrs?.images;
      const captionEscaped = this.escapeXml(caption);

      // Проверяем, есть ли массив изображений (группа картинок)
      if (Array.isArray(imagesData) && imagesData.length > 0) {
        const attachmentMap = context.attachmentMap || {};
        const mangaId = context.mangaId || this.options.mangaId || '';
        const chapterId = context.chapterId || this.options.chapterId || '';
        
        let imagesHtml = '';
        
        for (const img of imagesData) {
          const imgUrl = img?.image || img?.src || img?.url;
          
          if (!imgUrl) {
            if (this.options.debug && this.options.addLog) {
              this.options.addLog(`Пропуск картинки без URL в группе`);
            }
            continue;
          }
          
          // Если это UUID (без расширения), используем URL из attachmentMap
          if (!imgUrl.startsWith('http') && !imgUrl.startsWith('/') && !imgUrl.includes('.')) {
            const attachmentInfo = attachmentMap[imgUrl];
            if (attachmentInfo && attachmentInfo.url) {
              const fullUrl = attachmentInfo.url;
              const imageFormat = this.options.imageFormat || 'original';

              try {
                const imageResult = await this.downloadAndResizeImage(fullUrl, this.options.quality, imageFormat, 'картинка');
                const getNextImageNumber = context.getNextImageNumber || (() => `img_${Math.random().toString(36).substr(2, 9)}`);
                const blob = imageResult.blob;
                const imgExtension = this.getImageExtension(blob, imageFormat, fullUrl);
                const imgId = `${getNextImageNumber()}${imgExtension}`;
                if (imagesFolder) {
                  imagesFolder.file(imgId, blob);
                  imagesHtml += `<img src="images/${imgId}" alt="${captionEscaped || 'Иллюстрация'}" />`;
                } else {
                  const reader = new FileReader();
                  const base64 = await new Promise(r => {
                    reader.onloadend = () => r(reader.result);
                    reader.readAsDataURL(blob);
                  });
                  imagesHtml += `<img src="${base64}" alt="${captionEscaped || 'Иллюстрация'}" />`;
                }
                onImageDownloaded();
              } catch (e) {
                if (this.options.addLog) {
                  this.options.addLog(`Error loading UUID image ${fullUrl}: ${e.message}`, true);
                }
                if (this.options.incrementErrorCount) {
                  this.options.incrementErrorCount();
                }
                onImageFailed();
                imagesHtml += '<span class="image-placeholder">[Не удалось загрузить картинку]</span>';
              }
            } else {
              if (this.options.addLog) {
                this.options.addLog(`URL не найден в attachmentMap для UUID: ${imgUrl}`, true);
              }
              imagesHtml += '<span class="image-placeholder">[Не удалось загрузить картинку]</span>';
            }
          } else {
            // Обычный URL
            try {
              const imageResult = await this.downloadAndResizeImage(imgUrl, this.options.quality, imageFormat, 'картинка');
              const getNextImageNumber = context.getNextImageNumber || (() => `img_${Math.random().toString(36).substr(2, 9)}`);
              const imageFormat = this.options.imageFormat || 'original';
              const blob = imageResult.blob;
              const imgExtension = this.getImageExtension(blob, imageFormat, imgUrl);
              const imgId = `${getNextImageNumber()}${imgExtension}`;
              if (imagesFolder) {
                imagesFolder.file(imgId, blob);
                imagesHtml += `<img src="images/${imgId}" alt="${this.escapeXml(caption || 'Иллюстрация')}" />`;
              } else {
                const reader = new FileReader();
                const base64 = await new Promise(r => {
                  reader.onloadend = () => r(reader.result);
                  reader.readAsDataURL(blob);
                });
                imagesHtml += `<img src="${base64}" alt="${this.escapeXml(caption || 'Иллюстрация')}" />`;
              }
              onImageDownloaded();
            } catch (e) {
              if (this.options.addLog) {
                this.options.addLog(`Error loading image ${imgUrl}: ${e.message}`, true);
              }
              if (this.options.incrementErrorCount) {
                this.options.incrementErrorCount();
              }
              onImageFailed();
              imagesHtml += '<span class="image-placeholder">[Не удалось загрузить картинку]</span>';
            }
          }
        }
        
        // Оборачиваем все картинки в div с подписью
        const captionHtml = caption ? `<p class="image-caption">${this.escapeXml(caption)}</p>` : '';
        return `<div class="image-group">${captionHtml}${imagesHtml}</div>`;
      }
      
      // Обычная логика для одиночных картинок (обратная совместимость)
      const imgData = node.attrs?.images?.[0] || node.attrs;
      let imgUrl = imgData?.src || imgData?.url || imgData?.image;
      
      if (imgUrl && !imgUrl.startsWith('http') && !imgUrl.startsWith('/') && !imgUrl.includes('.')) {
        const attachmentMap = context.attachmentMap || {};
        const attachmentInfo = attachmentMap[imgUrl];
        
        if (attachmentInfo && attachmentInfo.url) {
          const fullUrl = attachmentInfo.url;
          const imageFormat = this.options.imageFormat || 'original';

          try {
            const imageResult = await this.downloadAndResizeImage(fullUrl, this.options.quality, imageFormat, 'картинка');
            const blob = imageResult.blob;
            const getNextImageNumber = context.getNextImageNumber || (() => `img_${Math.random().toString(36).substr(2, 9)}`);
            const imgExtension = this.getImageExtension(blob, imageFormat, fullUrl);
            const imgId = `${getNextImageNumber()}${imgExtension}`;
            if (imagesFolder) {
              imagesFolder.file(imgId, blob);
              const captionHtml = caption ? `<p class="image-caption">${this.escapeXml(caption)}</p>` : '';
              onImageDownloaded();
              return `${captionHtml}<img src="images/${imgId}" alt="${this.escapeXml(caption || 'Иллюстрация')}" />`;
            } else {
              const reader = new FileReader();
              const base64 = await new Promise(r => {
                reader.onloadend = () => r(reader.result);
                reader.readAsDataURL(blob);
              });
              const captionHtml = caption ? `<p class="image-caption">${this.escapeXml(caption)}</p>` : '';
              onImageDownloaded();
              return `${captionHtml}<img src="${base64}" alt="${this.escapeXml(caption || 'Иллюстрация')}" />`;
            }
          } catch (e) {
            if (this.options.addLog) {
              this.options.addLog(`Error loading UUID image ${fullUrl}: ${e.message}`, true);
            }
            if (this.options.incrementErrorCount) {
              this.options.incrementErrorCount();
            }
            onImageFailed();
            return '<span class="image-placeholder">[Не удалось загрузить картинку]</span>';
          }
        } else {
          if (this.options.addLog) {
            this.options.addLog(`URL не найден в attachmentMap для UUID: ${imgUrl}`, true);
          }
          return '<span class="image-placeholder">[Не удалось загрузить картинку]</span>';
        }
      }
      
      if (imgUrl) {
        const getNextImageNumber = context.getNextImageNumber || (() => `img_${Math.random().toString(36).substr(2, 9)}`);
        try {
          const imageResult = await this.downloadAndResizeImage(imgUrl, this.options.quality, imageFormat, 'картинка');
          const blob = imageResult.blob;
          if (imagesFolder) {
            const imageFormat = this.options.imageFormat || 'original';
            const imgExtension = this.getImageExtension(blob, imageFormat, imgUrl);
            const imgId = `${getNextImageNumber()}${imgExtension}`;
            imagesFolder.file(imgId, blob);
            const captionHtml = caption ? `<p class="image-caption">${this.escapeXml(caption)}</p>` : '';
            onImageDownloaded();
            return `${captionHtml}<img src="images/${imgId}" alt="${this.escapeXml(caption || 'Иллюстрация')}" />`;
          } else {
            const reader = new FileReader();
            const base64 = await new Promise(r => {
              reader.onloadend = () => r(reader.result);
              reader.readAsDataURL(blob);
            });
            const captionHtml = caption ? `<p class="image-caption">${this.escapeXml(caption)}</p>` : '';
            onImageDownloaded();
            return `${captionHtml}<img src="${base64}" alt="${this.escapeXml(caption || 'Иллюстрация')}" />`;
          }
        } catch (e) {
          if (this.options.addLog) {
            this.options.addLog(`Error loading image ${imgUrl}: ${e.message}`, true);
          }
          if (this.options.incrementErrorCount) {
            this.options.incrementErrorCount();
          }
          if (this.options.incrementSkippedImagesCount) {
            this.options.incrementSkippedImagesCount();
          }
          onImageFailed();
          return '<span class="image-placeholder">[Не удалось загрузить картинку]</span>';
        }
      } else {
        if (this.options.addLog) {
          this.options.addLog(`Картинка без URL. node.attrs: ${JSON.stringify(node.attrs)}`, true);
        }
        return '<span class="image-placeholder">[Не удалось загрузить картинку]</span>';
      }
    }
    if (node.content) return await this.convertJsonToHtml(node.content, imagesFolder);
    return "";
  }

  generateOpf(oebps, chapterFiles, metadata, createTocPage = true) {
    const originalMetadata = this.options.originalMetadata || {};
    const titleRu = metadata.titleRu || originalMetadata.titleRu || originalMetadata.titleEn || originalMetadata.titleOriginal || 'Без названия';
    const author = metadata.author || '';
    const artist = metadata.artist || '';
    const publisher = metadata.publisher || '';
    const year = metadata.year || '';
    const country = metadata.country || '';
    const status = metadata.status || '';
    const ageRestriction = metadata.ageRestriction || '';
    const genres = metadata.genres || '';
    const tags = metadata.tags || '';
    
    const disableToc = this.options.disableToc || false;
    
    const manifest = chapterFiles.map((ch, i) => `<item id="ch${i+1}" href="${this.escapeXml(ch.file)}" media-type="application/xhtml+xml"/>`).join('\n    ');
    const spine = chapterFiles.map((ch, i) => `<itemref idref="ch${i+1}"/>`).join('\n    ');
    
    const images = Object.keys(this.zip.files).filter(path => path.startsWith('OEBPS/images/') && !path.endsWith('/'));
    const primaryCover = images.find(path => path.split('/').pop().startsWith('cover'));
    const imageItems = images.map(path => {
      const name = path.split('/').pop();
      const id = path === primaryCover ? 'cover-image' : 'img_' + name.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9]/g, '_');
      const ext = name.split('.').pop().toLowerCase();
      const mimeTypeMap = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'webp': 'image/webp',
        'gif': 'image/gif',
        'avif': 'image/avif',
        'bmp': 'image/bmp',
        'svg': 'image/svg+xml',
        'tiff': 'image/tiff',
        'tif': 'image/tiff',
        'heic': 'image/heic',
        'heif': 'image/heif'
      };
      const mimeType = mimeTypeMap[ext] || 'image/jpeg';
      const coverProps = path === primaryCover ? ' properties="cover-image"' : '';
      return `<item id="${id}" href="images/${name}" media-type="${mimeType}"${coverProps}/>`;
    }).join('\n    ');

    // Добавляем обложки в manifest
    let manifestItems = '';
    if (this.zip.files['OEBPS/cover.xhtml']) {
      manifestItems += '    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>\n';
    }
    
    // Добавляем все остальные обложки если их несколько
    const coverHtmlFiles = Object.keys(this.zip.files).filter(path => path.startsWith('OEBPS/cover-') && path.endsWith('.xhtml')).sort((a, b) => {
      const matchA = a.match(/cover-(\d+)\.xhtml/);
      const matchB = b.match(/cover-(\d+)\.xhtml/);
      const numA = matchA ? parseInt(matchA[1]) : 0;
      const numB = matchB ? parseInt(matchB[1]) : 0;
      return numA - numB;
    });
    
    coverHtmlFiles.forEach(path => {
      const match = path.match(/cover-(\d+)\.xhtml/);
      if (match) {
        const num = parseInt(match[1]);
        manifestItems += `    <item id="cover-${num}" href="cover-${num}.xhtml" media-type="application/xhtml+xml"/>\n`;
      }
    });
    
    if (this.zip.files['OEBPS/info.xhtml']) {
      manifestItems += '    <item id="info" href="info.xhtml" media-type="application/xhtml+xml"/>\n';
    }
    
    if (createTocPage && this.zip.files['OEBPS/toc.xhtml']) {
      manifestItems += '    <item id="toc" href="toc.xhtml" media-type="application/xhtml+xml"/>\n';
    }
    
    const opfContent = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${this.escapeXml(titleRu)}</dc:title>
    ${metadata.titleEn ? `<dc:title id="title-en">${this.escapeXml(metadata.titleEn)}</dc:title>` : ''}
    ${metadata.titleOriginal ? `<dc:title id="title-original">${this.escapeXml(metadata.titleOriginal)}</dc:title>` : ''}
    ${author ? `<dc:creator>${this.escapeXml(author)}</dc:creator>` : ''}
    ${artist ? `<dc:contributor>${this.escapeXml(artist)}</dc:contributor>` : ''}
    ${publisher ? `<dc:publisher>${this.escapeXml(publisher)}</dc:publisher>` : ''}
    <dc:language>ru</dc:language>
    ${year ? `<dc:date>${this.escapeXml(year)}</dc:date>` : ''}
    ${country ? `<dc:subject>${this.escapeXml(country)}</dc:subject>` : ''}
    ${status ? `<meta property="calibre:series">${this.escapeXml(status)}</meta>` : ''}
    ${ageRestriction ? `<meta property="calibre:rating">${this.escapeXml(ageRestriction)}</meta>` : ''}
    ${genres ? `<dc:subject>${this.escapeXml(genres)}</dc:subject>` : ''}
    ${tags ? `<dc:subject>${this.escapeXml(tags)}</dc:subject>` : ''}
    <dc:identifier id="bookid">urn:uuid:${crypto.randomUUID()}</dc:identifier>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.[0-9]{3}Z/, 'Z')}</meta>
    ${this.zip.files['OEBPS/cover.xhtml'] || Object.keys(this.zip.files).some(path => path.startsWith('OEBPS/images/cover')) ? '<meta name="cover" content="cover-image"/>\n    <meta property="cover-image" content="cover-image"/>' : ''}
  </metadata>
  <manifest>
    ${!disableToc ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n' : ''}
${manifestItems}
    ${!disableToc ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n' : ''}
    <item id="style" href="styles.css" media-type="text/css"/>
    ${imageItems}
    ${manifest}
  </manifest>
  <spine ${!disableToc ? 'toc="ncx"' : ''}>
    ${this.zip.files['OEBPS/cover.xhtml'] ? '<itemref idref="cover"/>' : ''}
    ${Object.keys(this.zip.files).filter(path => path.startsWith('OEBPS/cover-') && path.endsWith('.xhtml')).sort((a, b) => {
        const matchA = a.match(/cover-(\d+)\.xhtml/);
        const matchB = b.match(/cover-(\d+)\.xhtml/);
        const numA = matchA ? parseInt(matchA[1]) : 0;
        const numB = matchB ? parseInt(matchB[1]) : 0;
        return numA - numB;
    }).map(path => {
        const match = path.match(/cover-(\d+)\.xhtml/);
        if (match) {
          const num = parseInt(match[1]);
          return `<itemref idref="cover-${num}"/>`;
        }
        return '';
    }).join('\n    ')}
    ${this.zip.files['OEBPS/info.xhtml'] ? '<itemref idref="info"/>' : ''}
    ${createTocPage && this.zip.files['OEBPS/toc.xhtml'] ? '<itemref idref="toc"/>\n' : ''}
    ${spine}
  </spine>
  <guide>
    ${(() => {
      const coverImage = Object.keys(this.zip.files).find(path => path.startsWith('OEBPS/images/cover'));
      return coverImage ? `<reference href="${coverImage.replace('OEBPS/', '')}" type="cover" title="cover"/>` : '';
    })()}
  </guide>
</package>`;
    
    oebps.file("content.opf", opfContent);
    
    // Создаем nav.xhtml для EPUB 3 только если оглавление не отключено
    if (!disableToc) {
      let navItems = '';
      if (this.zip.files['OEBPS/info.xhtml']) {
        navItems += '<li><a href="info.xhtml">Информация о произведении</a></li>\n        ';
      }
      navItems += chapterFiles.map(ch => `<li><a href="${this.escapeXml(ch.file)}">${this.escapeXml(ch.title)}</a></li>`).join('\n        ');
      const navHtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Оглавление</title>
</head>
<body>
    <nav epub:type="toc" id="toc">
        <ol>
            ${navItems}
        </ol>
    </nav>
</body>
</html>`;
      oebps.file("nav.xhtml", navHtml);
    }
  }

  generateNcx(oebps, chapterFiles, metadata) {
    const disableToc = this.options.disableToc || false;
    
    if (disableToc) {
      return;
    }

    const originalMetadata = this.options.originalMetadata || {};
    const titleRu = metadata.titleRu || originalMetadata.titleRu || originalMetadata.titleEn || originalMetadata.titleOriginal || 'Без названия';


    let navPoints = '';
    let playOrder = 1;
    
    if (this.zip.files['OEBPS/info.xhtml']) {
      navPoints += `
      <navPoint id="nav-info" playOrder="${playOrder++}">
        <navLabel><text>Информация о произведении</text></navLabel>
        <content src="info.xhtml"/>
      </navPoint>`;
    }
    
    navPoints += chapterFiles.map((ch, i) => `
      <navPoint id="nav${playOrder++}" playOrder="${playOrder - 1}">
        <navLabel><text>${this.escapeXml(ch.title)}</text></navLabel>
        <content src="${this.escapeXml(ch.file)}"/>
      </navPoint>`).join('');
    
    const ncxContent = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.idpf.org/2007/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${crypto.randomUUID()}"/>
    <meta name="dtb:depth" content="1"/>
  </head>
  <docTitle><text>${this.escapeXml(titleRu)}</text></docTitle>
  <navMap>
    ${navPoints}
  </navMap>
</ncx>`;
    
    oebps.file("toc.ncx", ncxContent);

  }

  validateEpubStructure() {
    const requiredFiles = [
      'mimetype',
      'META-INF/container.xml',
      'OEBPS/content.opf',
      'OEBPS/styles.css'
    ];

    for (const file of requiredFiles) {
      if (!this.zip.files[file]) {
        throw new Error(`Отсутствует обязательный файл EPUB: ${file}`);
      }
    }

    // Проверяем наличие хотя бы одной главы
    const chapterFiles = Object.keys(this.zip.files).filter(path => 
      path.startsWith('OEBPS/chapter_') && path.endsWith('.xhtml')
    );

    if (chapterFiles.length === 0) {
      throw new Error('EPUB не содержит ни одной главы');
    }
  }
}
