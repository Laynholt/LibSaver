// pdf-lib и fontkit весят ~1,3 МБ, поэтому подключаем их только при сборке PDF, а не при каждом открытии окна
function loadPdfLibs() {
  loadPdfLibs.promise ??= Promise.all(['../libs/pdf-lib.min.js', '../libs/fontkit.umd.min.js'].map(src => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Не удалось загрузить ${src}`));
    document.head.appendChild(script);
  })));
  return loadPdfLibs.promise;
}

// Глифов корейского, китайского и японского в шрифтах из assets/fonts нет: такие символы берутся из первого запасного, где они есть
const PDF_FALLBACK_FONTS = ['assets/fonts/NanumGothic-Regular.ttf', 'assets/fonts/DroidSansFallbackFull.ttf']; // корейский; китайский и японский

class PdfFormatter extends BaseFormatter {
  constructor(options) {
    super(options);
  }

  getExtension() {
    return 'pdf';
  }

  getMimeType() {
    return 'application/pdf';
  }

  // pdf-lib встраивает только PNG и JPEG. Тип - по первым байтам (подпись сервера бывает неверной);
  // WebP/AVIF/GIF и файл, который pdf-lib не принял, перекодируются через canvas в формат из настроек PDF
  async embedImage(pdfDoc, blob) {
    const type = await sniffImageType(blob);
    if (type === 'image/png' || type === 'image/jpeg') {
      const bytes = await blob.arrayBuffer();
      try {
        return type === 'image/png' ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
      } catch (error) { /* перекодируем ниже */ }
    }
    const toJpeg = this.options.pdfImageFormat === 'original-jpeg';
    const bitmap = await createImageBitmap(blob).catch(error => { throw new Error(`Не удалось декодировать изображение: ${error.message}`); });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    const converted = await new Promise(resolve => canvas.toBlob(resolve, toJpeg ? 'image/jpeg' : 'image/png', toJpeg ? (this.options.pdfJpegQuality || 1.0) : undefined));
    const bytes = await converted.arrayBuffer();
    return toJpeg ? pdfDoc.embedJpg(bytes) : pdfDoc.embedPng(bytes);
  }

  async format(chapters, metadata) {
    await loadPdfLibs();
    const { PDFDocument, rgb } = PDFLib;
    const addLog = this.options.addLog || (() => {});

    // Для обнаружения глав старого формата (только ранобэ)
    const siteType = this.options.siteType || 'ranobe';
    this.isRanobe = siteType === 'ranobe' || siteType === 'ranobelib';

    // Создаём PDF документ
    const pdfDoc = await PDFDocument.create();
    this.fallbackFonts = PDF_FALLBACK_FONTS.map(path => ({ path })); // + bytes и chars после чтения, font - после встраивания; chars: null - не загрузился
    this.fontChars = new Map();

    // Регистрируем fontkit для поддержки кастомных шрифтов
    if (typeof fontkit !== 'undefined') {
      pdfDoc.registerFontkit(fontkit);
    } else {
      addLog('ВНИМАНИЕ: Fontkit не найден. Русский текст не будет поддерживаться.', true);
    }

    // Получаем настройки шрифта из settings
    const settings = this.options.settings || {};
    const fontSize = settings.pdfFontSize !== undefined ? settings.pdfFontSize : 12;
    const pageMargin = 50;
    const pageSize = settings.pdfPageSize || 'A5';
    const lineSpacing = settings.pdfLineSpacing !== undefined ? settings.pdfLineSpacing : 2;
    const paragraphSpacing = settings.pdfParagraphSpacing !== undefined ? settings.pdfParagraphSpacing : 1;

    // Определяем размер страницы
    const pageSizes = {
      'A6': { width: 298, height: 420 },
      'A5': { width: 420, height: 595 },
      'A4': { width: 595, height: 842 },
      'Letter': { width: 612, height: 792 },
      'B5': { width: 499, height: 709 },
      'B4': { width: 709, height: 1001 }
    };
    const pageWidth = pageSizes[pageSize].width;
    const pageHeight = pageSizes[pageSize].height;

    // Поля для текстовых страниц (динамические в зависимости от размера шрифта)
    const textMargin = fontSize >= 16 ? 60 : 40;

    // Embed шрифт с поддержкой UTF-8
    let font, boldFont, italicFont, boldItalicFont;
    try {
      const fontName = this.options.settings?.pdfFont || 'dejavu-sans';
      const fontPaths = {
        'dejavu-sans': {
          regular: 'assets/fonts/DejaVuSans.ttf',
          bold: 'assets/fonts/DejaVuSans-Bold.ttf',
          italic: 'assets/fonts/DejaVuSans-Oblique.ttf',
          bolditalic: 'assets/fonts/DejaVuSans-BoldOblique.ttf'
        },
        'inter': {
          regular: 'assets/fonts/Inter-Regular.ttf',
          bold: 'assets/fonts/Inter-Bold.ttf',
          italic: 'assets/fonts/Inter-Italic.ttf',
          bolditalic: 'assets/fonts/Inter-BoldItalic.ttf'
        },
        'merriweather': {
          regular: 'assets/fonts/Merriweather-Regular.ttf',
          bold: 'assets/fonts/Merriweather-Bold.ttf',
          italic: 'assets/fonts/Merriweather-Italic.ttf',
          bolditalic: 'assets/fonts/Merriweather-BoldItalic.ttf'
        },
        'montserrat': {
          regular: 'assets/fonts/Montserrat-Regular.ttf',
          bold: 'assets/fonts/Montserrat-Bold.ttf',
          italic: 'assets/fonts/Montserrat-Italic.ttf',
          bolditalic: 'assets/fonts/Montserrat-BoldItalic.ttf'
        },
        'open-sans': {
          regular: 'assets/fonts/OpenSans-Regular.ttf',
          bold: 'assets/fonts/OpenSans-Bold.ttf',
          italic: 'assets/fonts/OpenSans-Italic.ttf',
          bolditalic: 'assets/fonts/OpenSans-BoldItalic.ttf'
        },
        'roboto': {
          regular: 'assets/fonts/Roboto-Regular.ttf',
          bold: 'assets/fonts/Roboto-Bold.ttf',
          italic: 'assets/fonts/Roboto-Italic.ttf',
          bolditalic: 'assets/fonts/Roboto-BoldItalic.ttf'
        },
        'playfair-display': {
          regular: 'assets/fonts/PlayfairDisplay-Regular.ttf',
          bold: 'assets/fonts/PlayfairDisplay-Bold.ttf',
          italic: 'assets/fonts/PlayfairDisplay-Italic.ttf',
          bolditalic: 'assets/fonts/PlayfairDisplay-BoldItalic.ttf'
        },
        'noto-serif': {
          regular: 'assets/fonts/NotoSerif-Regular.ttf',
          bold: 'assets/fonts/NotoSerif-Bold.ttf',
          italic: 'assets/fonts/NotoSerif-Italic.ttf',
          bolditalic: 'assets/fonts/NotoSerif-BoldItalic.ttf'
        },
        'lora': {
          regular: 'assets/fonts/Lora-Regular.ttf',
          bold: 'assets/fonts/Lora-Bold.ttf',
          italic: 'assets/fonts/Lora-Italic.ttf',
          bolditalic: 'assets/fonts/Lora-BoldItalic.ttf'
        },
        'crimson-text': {
          regular: 'assets/fonts/CrimsonText-Regular.ttf',
          bold: 'assets/fonts/CrimsonText-Bold.ttf',
          italic: 'assets/fonts/CrimsonText-Italic.ttf',
          bolditalic: 'assets/fonts/CrimsonText-BoldItalic.ttf'
        }
      };

      const fontPath = fontPaths[fontName];
      if (!fontPath) {
        throw new Error(`Неизвестный шрифт: ${fontName}`);
      }

      // Шрифт встраивается целиком: subset в pdf-lib/fontkit теряет глифы у Merriweather, Inter и Crimson Text
      const fontUrl = chrome.runtime.getURL(fontPath.regular);
      const fontResponse = await fetch(fontUrl);
      const fontBytes = await fontResponse.arrayBuffer();
      font = await pdfDoc.embedFont(fontBytes);

      // Embed bold шрифт
      const boldFontUrl = chrome.runtime.getURL(fontPath.bold);
      const boldFontResponse = await fetch(boldFontUrl);
      const boldFontBytes = await boldFontResponse.arrayBuffer();
      boldFont = await pdfDoc.embedFont(boldFontBytes);

      // Embed italic шрифт (если есть)
      if (fontPath.italic) {
        const italicFontUrl = chrome.runtime.getURL(fontPath.italic);
        const italicFontResponse = await fetch(italicFontUrl);
        const italicFontBytes = await italicFontResponse.arrayBuffer();
        italicFont = await pdfDoc.embedFont(italicFontBytes);
      }

      // Embed bolditalic шрифт (если есть)
      if (fontPath.bolditalic) {
        const boldItalicFontUrl = chrome.runtime.getURL(fontPath.bolditalic);
        const boldItalicFontResponse = await fetch(boldItalicFontUrl);
        const boldItalicFontBytes = await boldItalicFontResponse.arrayBuffer();
        boldItalicFont = await pdfDoc.embedFont(boldItalicFontBytes);
      }
    } catch (error) {
      addLog(`Ошибка загрузки шрифта: ${error.message}`, true);
      throw error;
    }

    // Определяем тип контента
    const isManga = this.options.siteType === 'manga';

    // 1. Добавляем обложки
    const coversStats = await this.addCoversToPdf(pdfDoc, metadata, addLog);

    // Сохраняем статистику обложек для summary
    this.coversStats = coversStats;

    // 2. Добавляем содержимое
    if (isManga) {
      await this.addMangaContent(pdfDoc, chapters, addLog);
    } else {
      await this.addRanobeContent(pdfDoc, chapters, addLog, fontSize, pageMargin, font, boldFont, pageWidth, pageHeight, textMargin, lineSpacing, paragraphSpacing);
    }

    // Сохраняем PDF
    const pdfBytes = await pdfDoc.save();
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const filename = this.generateFileName(metadata) + '.pdf';

    // Обновляем статистику
    if (window.setTotalChapters) {
      window.setTotalChapters(chapters.length);
    }
    if (window.setTotalCovers && coversStats) {
      window.setTotalCovers(coversStats.downloaded);
    }
    if (window.setTotalImages) {
      window.setTotalImages(this.imagesDownloaded || 0);
    }

    return { blob, filename };
  }

  async addCoversToPdf(pdfDoc, metadata, addLog) {
    const coverQuality = this.options.coverQuality || 'ORIGINAL';

    if (coverQuality === 'NONE') {
      return { downloaded: 0, failed: 0, total: 0 };
    }

    const allCovers = this.options.allCovers ? this.options.allCovers : [metadata.cover || this.options.originalCover || ''];
    const stats = { downloaded: 0, failed: 0, total: allCovers.length };

    if (allCovers.length === 0 || (allCovers.length === 1 && !allCovers[0])) {
      return stats;
    }

    for (let i = 0; i < allCovers.length; i++) {
      const coverItem = allCovers[i];
      if (!coverItem) {
        continue;
      }

      // Если это объект с dataUrl (локальный файл), используем dataUrl
      const coverUrl = typeof coverItem === 'object' && coverItem.dataUrl
        ? coverItem.dataUrl
        : coverItem;

      // Извлекаем URL из обложки (может быть объект или строка)
      const actualUrl = this.extractCoverUrl(coverUrl);
      if (!actualUrl) {
        stats.failed++;
        continue;
      }

      try {
        const imageResult = await this.downloadAndResizeImage(actualUrl, coverQuality, this.options.pdfImageFormat, 'обложка');
        const imageBlob = imageResult.blob;
        const pdfImage = await this.embedImage(pdfDoc, imageBlob);

        // Создаём страницу с размером обложки
        const page = pdfDoc.addPage([pdfImage.width, pdfImage.height]);
        page.drawImage(pdfImage, {
          x: 0,
          y: 0,
          width: pdfImage.width,
          height: pdfImage.height,
        });

        stats.downloaded++;
        if (window.incrementTotalCovers) {
          window.incrementTotalCovers();
        }

        // Обновляем статистику размера файла
        if (this.options.addFileSize) {
          this.options.addFileSize(imageBlob.size);
        }
      } catch (error) {
        stats.failed++;
        addLog(`Ошибка загрузки обложки ${i + 1}: ${error.message}`, true);
      }
    }

    return stats;
  }

  async addMangaContent(pdfDoc, chapters, addLog) {
    const tabId = this.options.tabId;
    const slug = this.options.slug;
    const imageServer = this.options.imageServer || 'normal';
    const chapterBranchOverrides = this.options.chapterBranchOverrides || {};
    const translatorPriority = this.options.translatorPriority || [];
    const imageQuality = this.options.quality || 'ORIGINAL';

    // Если выбрано "Без картинок", пропускаем мангу
    if (imageQuality === 'NONE') {
      return;
    }

    // Счётчик картинок для манги
    this.imagesDownloaded = 0;

    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];

      // Случайная пауза между главами
      if (typeof window.maybeAddRandomPause === 'function') {
        await window.maybeAddRandomPause(i, addLog);
      }

      addLog(`[${i + 1}/${chapters.length}] ЗАГРУЗКА: ${ch.displayTitle}...`);

      // Определяем branch_id
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

      // Определяем правильный chapter_id
      let chapterId = ch.id;
      if (branchId && ch.branches && Array.isArray(ch.branches)) {
        const branchChapter = ch.branches.find(b => String(b.branch_id) === String(branchId));
        if (branchChapter) {
          chapterId = branchChapter.id;
        }
      }

      // Загружаем страницы
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
        addLog(`Не удалось загрузить страницы для главы ${ch.displayTitle}: ${pagesResult?.error || 'Unknown error'}`, true);
        continue;
      }

      const pages = pagesResult.pages;

      // Добавляем каждую картинку как отдельную страницу
      let pageIndex = 0;
      const takePage = this.pageLoader(pages.map(page => page.url || page), url => this.downloadAndResizeImage(url, this.options.quality || 'ORIGINAL', this.options.pdfImageFormat, 'картинка'));
      while (pageIndex < pages.length) {
        this.options.updateImageProgress?.(pageIndex, pages.length);
        const pageUrl = pages[pageIndex].url || pages[pageIndex];

        try {
          const imageResult = await takePage(pageIndex);
          if (!imageResult || !imageResult.blob) {
            throw new Error('Не удалось скачать изображение');
          }
          const imageBlob = imageResult.blob;

          const pdfImage = await this.embedImage(pdfDoc, imageBlob);
          this.imagesDownloaded++;
          if (window.incrementTotalImages) {
            window.incrementTotalImages();
          }

          // Создаём страницу с размером картинки
          const page = pdfDoc.addPage([pdfImage.width, pdfImage.height]);
          page.drawImage(pdfImage, {
            x: 0,
            y: 0,
            width: pdfImage.width,
            height: pdfImage.height,
          });

          // Обновляем статистику
          if (this.options.addFileSize) {
            this.options.addFileSize(imageBlob.size);
          }
          pageIndex++; // Переходим к следующей картинке
        } catch (error) {
          addLog(`Ошибка загрузки изображения ${pageIndex + 1}: ${error.message}`, true);
          // Для манги останавливаем главу при ошибке картинки
          if (this.options.onImageError) {
            const errorResult = await this.options.onImageError(ch, error, i, pageUrl);
            if (errorResult && errorResult.shouldRetry) {
              // Не увеличиваем pageIndex - повторяем ту же картинку
              continue;
            } else {
              pageIndex++; // Переходим к следующей картинке
              continue;
            }
          } else {
            break;
          }
        }
      }

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
  }

  async addRanobeContent(pdfDoc, chapters, addLog, fontSize, margin, font, boldFont, pageWidth, pageHeight, textMargin, lineSpacing, paragraphSpacing) {
    const { PDFDocument, rgb } = PDFLib;

    // Сбор глав старого формата для предупреждения
    const oldFormatChapters = [];

    // Счётчик картинок
    this.imagesDownloaded = 0;

    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];

      // Случайная пауза между главами
      if (typeof window.maybeAddRandomPause === 'function') {
        await window.maybeAddRandomPause(i, addLog);
      }

      addLog(`[${i + 1}/${chapters.length}] ЗАГРУЗКА: ${ch.displayTitle}...`);

      let chapterContent, attachments;
      let shouldRetry = false;

      do {
        shouldRetry = false;
        try {
          const result = await this.fetchChapterData(ch);
          chapterContent = result.chapterContent;
          attachments = result.attachments;
        } catch (error) {
          addLog(`Ошибка загрузки главы: ${error.message}`, true);

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

      if (!chapterContent) {
        addLog(`Не удалось загрузить главу ${ch.displayTitle}`, true);
        continue;
      }

      // Проверяем на старый формат (HTML string)
      if (this.isRanobe && typeof chapterContent === 'string') {
        oldFormatChapters.push(ch.displayTitle);
        if (this.options.addOldFormatChapter) {
          this.options.addOldFormatChapter(ch.displayTitle);
        }
      }

      // Строим карту attachments для UUID картинок (как в epub.js)
      const attachmentMap = this.buildAttachmentMap(attachments);

      // Извлекаем mangaId из attachments (как в epub.js)
      let mangaId = this.extractMangaId(attachments);

      // Конвертируем JSON в HTML (как в epub.js)
      const htmlContent = await this.convertJsonToHtml(chapterContent, null, {
        mangaId: mangaId,
        chapterId: ch.id || '',
        attachmentMap: attachmentMap,
        attachments: attachments,
        imageFormat: this.options.pdfImageFormat,
        onImageDownloaded: () => {},
        onImageFailed: () => {}
      });

      // Если htmlContent пустой - пропускаем главу
      if (!htmlContent || htmlContent.trim().length === 0) {
        continue;
      }

      // Парсим HTML и извлекаем текст и картинки
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlContent, 'text/html');
      await this.loadFallbackFontsFor(pdfDoc, `${ch.displayTitle || ''}${doc.body.textContent}`, [font, boldFont], addLog);

      // Сохраняем индекс страницы начала главы
      const startPageIndex = pdfDoc.getPageCount();

      // Создаём страницу для текста
      let page = pdfDoc.addPage([pageWidth, pageHeight]);
      let y = pageHeight - textMargin;
      const maxLineWidth = pageWidth - textMargin * 2;

      // Заголовок главы с переносом (если не отключен)
      const noHeaders = this.options.settings?.tocFormat === 'no_headers';
      if (!noHeaders) {
        const chapterTitle = ch.displayTitle || `Глава ${i + 1}`;
        const titleLines = this.wrapText(chapterTitle, maxLineWidth, fontSize + 2, boldFont);
        for (const line of titleLines) {
          this.drawTextRuns(page, line, {
            x: textMargin,
            y: y,
            size: fontSize + 2,
            font: boldFont,
            color: rgb(0, 0, 0),
          });
          y -= fontSize + 2;
        }
        y -= fontSize;
      }

      // Обрабатываем контент (исключаем img - они уже в base64 из convertJsonToHtml)
      const paragraphs = doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, div');

      let lastWasImage = false;
      let createdBlankPageAfterImage = false;

      for (const elem of paragraphs) {
        if (elem.tagName === 'DIV') {
          // Div может содержать картинки в base64 (уже обработанные convertJsonToHtml)
          const images = elem.querySelectorAll('img');
          if (images.length > 0) {
            // Обрабатываем DIV с картинками
            for (const img of images) {
              const imgSrc = img.src || img.getAttribute('src');
              if (imgSrc && imgSrc.startsWith('data:')) {
                try {
                  const pdfImage = await this.embedImage(pdfDoc, await (await fetch(imgSrc)).blob());

                  // Проверяем, помещается ли картинка на текущей странице
                  const imageHeight = pdfImage.height;
                  const availableHeight = y - margin;

                  if (imageHeight > availableHeight || availableHeight < pageHeight * 0.3) {
                    // Не помещается или мало места - создаём отдельную страницу для картинки
                    page = pdfDoc.addPage([pdfImage.width, pdfImage.height]);
                    page.drawImage(pdfImage, {
                      x: 0,
                      y: 0,
                      width: pdfImage.width,
                      height: pdfImage.height,
                    });
                    // После картинки на отдельной странице НЕ создаём новую страницу для текста сразу
                    // Создадим её только когда нужен текст
                    lastWasImage = true;
                    createdBlankPageAfterImage = false;
                  } else {
                    // Помещается - добавляем на текущую страницу и продолжаем
                    page.drawImage(pdfImage, {
                      x: (pageWidth - pdfImage.width) / 2,
                      y: y - imageHeight,
                      width: pdfImage.width,
                      height: pdfImage.height,
                    });
                    y -= imageHeight + fontSize;
                    lastWasImage = true;
                    createdBlankPageAfterImage = false;
                  }
                } catch (error) {
                  addLog(`Ошибка загрузки base64 изображения: ${error?.message || error}`, true);
                  addLog(`imgSrc: ${imgSrc.substring(0, 100)}...`, true);
                  // Для ранобэ картинки не критичны, но считаем пропущенные
                  if (this.options.incrementSkippedImagesCount) {
                    this.options.incrementSkippedImagesCount();
                  }
                }
              }
            }
          }
          // Если в DIV нет картинок, пропускаем его (он дублирует текст из P элементов)
          continue;
        } else {
          // Текст
          const text = elem.textContent.trim();
          if (text) {
            // Если предыдущий элемент был картинка на отдельной странице, а теперь идёт текст - создаём новую страницу
            if (lastWasImage) {
              page = pdfDoc.addPage([pageWidth, pageHeight]);
              y = pageHeight - margin;
              lastWasImage = false;
              createdBlankPageAfterImage = true;
            }

            const lines = this.wrapText(text, maxLineWidth, fontSize, font);
            for (const line of lines) {
              if (y < margin) {
                page = pdfDoc.addPage([pageWidth, pageHeight]);
                y = pageHeight - margin;
              }
              this.drawTextRuns(page, line, {
                x: textMargin,
                y: y,
                size: fontSize,
                font: font,
                color: rgb(0, 0, 0),
              });
              y -= fontSize + lineSpacing;
            }
            y -= fontSize * paragraphSpacing;
            createdBlankPageAfterImage = false;
          }
        }
      }

      // Удаляем последнюю пустую страницу если она была создана после последней картинки
      const pageCount = pdfDoc.getPageCount();
      if (pageCount > startPageIndex + 1 && lastWasImage && createdBlankPageAfterImage) {
        pdfDoc.removePage(pageCount - 1);
      }

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
    
    // Выводим предупреждение о главах старого формата (только для ранобэ)
    if (oldFormatChapters.length > 0 && this.isRanobe) {
      addLog('ОБНАРУЖЕНЫ ГЛАВЫ СТАРОГО ФОРМАТА:', true, '#c62828');
      oldFormatChapters.forEach(title => {
        addLog(title, true, '#c62828');
      });
      addLog('Перечисленные выше главы могут некорректно отображаться в PDF формате!', true, '#c62828');
    }
  }

  async convertJsonToHtml(node, imagesFolder, context = {}) {
    if (!node) return "";

    const imageQuality = this.options.quality || 'ORIGINAL';
    const disableImages = imageQuality === 'NONE';
    const onImageDownloaded = context.onImageDownloaded || (() => {});
    const onImageFailed = context.onImageFailed || (() => {});
    const imageFormat = context.imageFormat || this.options.pdfImageFormat || 'original-png';

    if (typeof node === 'string') {
      // Заменяем переносы строк внутри параграфов на пробелы для корректного рендеринга в PDF
      node = node.replace(/\n/g, ' ');

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

      if (disableImages) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(`<div>${node}</div>`, 'text/html');
        const images = doc.querySelectorAll('img');
        for (const img of images) {
          const alt = img.alt || '';
          const placeholder = alt ? `<span class="image-placeholder">[Изображение пропущено: ${alt}]</span>` : '<span class="image-placeholder">[Изображение пропущено]</span>';
          img.outerHTML = placeholder;
        }
        return doc.body.innerHTML;
      }

      const parser = new DOMParser();
      const doc = parser.parseFromString(`<div>${node}</div>`, 'text/html');

      const images = doc.querySelectorAll('img');
      for (const img of images) {
        const src = img.getAttribute('src');
        if (src) {
          try {
            const imageResult = await this.downloadAndResizeImage(src, this.options.quality, imageFormat, 'картинка');
            const blob = imageResult.blob;
            const reader = new FileReader();
            const base64 = await new Promise(r => {
              reader.onloadend = () => r(reader.result);
              reader.readAsDataURL(blob);
            });
            img.setAttribute('src', base64);
            onImageDownloaded();
            this.imagesDownloaded++;
          if (window.incrementTotalImages) {
            window.incrementTotalImages();
          }
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
      return doc.body.innerHTML;
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
      let text = node.text || "";
      text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
      const captionHtml = caption ? `<p class="image-caption">${caption}</p>` : '';

      if (this.options.quality === 'NONE') {
        return `${captionHtml}<span class="image-placeholder">[Картинка пропущена]</span>`;
      }

      const imagesData = node.attrs?.images;
      let captionEscaped = caption.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

      // Проверяем, есть ли массив изображений (группа картинок)
      if (Array.isArray(imagesData) && imagesData.length > 0) {
        const attachmentMap = context.attachmentMap || {};
        const mangaId = context.mangaId || this.options.mangaId || '';
        const chapterId = context.chapterId || this.options.chapterId || '';

        let imagesHtml = '';

        for (const img of imagesData) {
          const imgUrl = img?.image || img?.src || img?.url;

          if (!imgUrl) {
            continue;
          }

          // Если это UUID (без расширения), используем URL из attachmentMap
          if (!imgUrl.startsWith('http') && !imgUrl.startsWith('/') && !imgUrl.includes('.')) {
            const attachmentInfo = attachmentMap[imgUrl];
            if (attachmentInfo && attachmentInfo.url) {
              const fullUrl = attachmentInfo.url;

              try {
                const imageResult = await this.downloadAndResizeImage(fullUrl, this.options.quality, imageFormat, 'картинка');
                const blob = imageResult.blob;
                const reader = new FileReader();
                const base64 = await new Promise(r => {
                  reader.onloadend = () => r(reader.result);
                  reader.readAsDataURL(blob);
                });
                imagesHtml += `<img src="${base64}" alt="${caption || 'Иллюстрация'}" />`;
                onImageDownloaded();
                this.imagesDownloaded++;
          if (window.incrementTotalImages) {
            window.incrementTotalImages();
          }
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
              imagesHtml += '<span class="image-placeholder">[Не удалось загрузить картинку]</span>';
            }
          } else {
            // Обычный URL
            try {
              const imageResult = await this.downloadAndResizeImage(imgUrl, this.options.quality, imageFormat, 'картинка');
              const blob = imageResult.blob;
              const reader = new FileReader();
              const base64 = await new Promise(r => {
                reader.onloadend = () => r(reader.result);
                reader.readAsDataURL(blob);
              });
              imagesHtml += `<img src="${base64}" alt="${caption || 'Иллюстрация'}" />`;
              onImageDownloaded();
              this.imagesDownloaded++;
          if (window.incrementTotalImages) {
            window.incrementTotalImages();
          }
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
        const captionHtml = caption ? `<p class="image-caption">${caption}</p>` : '';
        return `<div class="image-group">${imagesHtml}${captionHtml}</div>`;
      }

      // Обычная логика для одиночных картинок
      const imgData = node.attrs?.images?.[0] || node.attrs;
      let imgUrl = imgData?.src || imgData?.url || imgData?.image;

      if (imgUrl && !imgUrl.startsWith('http') && !imgUrl.startsWith('/') && !imgUrl.includes('.')) {
        const attachmentMap = context.attachmentMap || {};
        const attachmentInfo = attachmentMap[imgUrl];

        if (attachmentInfo && attachmentInfo.url) {
          const fullUrl = attachmentInfo.url;

          try {
            const imageResult = await this.downloadAndResizeImage(fullUrl, this.options.quality, imageFormat, 'картинка');
            const blob = imageResult.blob;
            const reader = new FileReader();
            const base64 = await new Promise(r => {
              reader.onloadend = () => r(reader.result);
              reader.readAsDataURL(blob);
            });
            onImageDownloaded();
            this.imagesDownloaded++;
          if (window.incrementTotalImages) {
            window.incrementTotalImages();
          }
            const captionHtml = caption ? `<p class="image-caption">${caption}</p>` : '';
            return `<img src="${base64}" alt="${caption || 'Иллюстрация'}" />${captionHtml}`;
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
          return '<span class="image-placeholder">[Не удалось загрузить картинку]</span>';
        }
      }

      if (imgUrl) {
        try {
          const imageResult = await this.downloadAndResizeImage(imgUrl, this.options.quality, imageFormat, 'картинка');
          const blob = imageResult.blob;
          const reader = new FileReader();
          const base64 = await new Promise(r => {
            reader.onloadend = () => r(reader.result);
            reader.readAsDataURL(blob);
          });
          onImageDownloaded();
          this.imagesDownloaded++;
          if (window.incrementTotalImages) {
            window.incrementTotalImages();
          }
          const captionHtml = caption ? `<p class="image-caption">${caption}</p>` : '';
          return `<img src="${base64}" alt="${caption || 'Иллюстрация'}" />${captionHtml}`;
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
        return '<span class="image-placeholder">[Не удалось загрузить картинку]</span>';
      }
    }
    if (node.content) return await this.convertJsonToHtml(node.content, imagesFolder);
    return "";
  }

  wrapText(text, maxWidth, fontSize, font) {
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const width = this.textWidth(testLine, fontSize, font);

      if (width < maxWidth) {
        currentLine = testLine;
      } else {
        if (currentLine) {
          lines.push(currentLine);
        }
        currentLine = word;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    return lines;
  }

  charsOf(font) {
    if (!this.fontChars.has(font)) this.fontChars.set(font, new Set(font.getCharacterSet()));
    return this.fontChars.get(font);
  }

  // Запасной шрифт (~2 МБ в PDF) встраивается, только если в тексте есть его символы, которых нет в выбранном шрифте.
  // Целиком: subset теряет у Droid Sans Fallback японские глифы
  async loadFallbackFontsFor(pdfDoc, text, fonts, addLog) {
    const missing = new Set();
    for (const char of text) {
      const code = char.codePointAt(0);
      if (fonts.some(font => !this.charsOf(font).has(code))) missing.add(code);
    }
    for (const entry of this.fallbackFonts) {
      if (!missing.size) return;
      if (entry.chars === null) continue;
      try {
        if (!entry.chars) {
          const response = await fetch(chrome.runtime.getURL(entry.path));
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          entry.bytes = new Uint8Array(await response.arrayBuffer());
          entry.chars = new Set(fontkit.create(entry.bytes).characterSet);
        }
        if (!entry.font && [...missing].some(code => entry.chars.has(code))) entry.font = await pdfDoc.embedFont(entry.bytes);
      } catch (error) {
        entry.chars = null;
        addLog(`Не загрузился шрифт ${entry.path}, часть иероглифов может не отобразиться: ${error.message}`, true);
        continue;
      }
      for (const code of missing) if (entry.chars.has(code)) missing.delete(code);
    }
  }

  // Строка -> куски одного шрифта: символ без глифа в основном шрифте берётся из первого запасного, где он есть
  textRuns(text, font) {
    const extras = this.fallbackFonts.filter(entry => entry.font).map(entry => entry.font);
    if (!extras.length) return [{ text, font }];
    const own = this.charsOf(font);
    const runs = [];
    for (const char of text) {
      const code = char.codePointAt(0);
      const runFont = own.has(code) ? font : extras.find(extra => this.charsOf(extra).has(code)) || font;
      const last = runs[runs.length - 1];
      if (last?.font === runFont) last.text += char;
      else runs.push({ text: char, font: runFont });
    }
    return runs;
  }

  textWidth(text, size, font) {
    return this.textRuns(text, font).reduce((width, run) => width + run.font.widthOfTextAtSize(run.text, size), 0);
  }

  drawTextRuns(page, text, options) {
    let x = options.x;
    for (const run of this.textRuns(text, options.font)) {
      page.drawText(run.text, { ...options, x, font: run.font });
      x += run.font.widthOfTextAtSize(run.text, options.size);
    }
  }
}
