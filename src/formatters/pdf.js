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

// Глифов корейского, китайского и японского в шрифтах из assets/fonts нет: такие символы рисуются этим шрифтом
const PDF_FALLBACK_FONT = 'assets/fonts/DroidSansFallbackFull.ttf';

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

  async format(chapters, metadata) {
    await loadPdfLibs();
    const { PDFDocument, rgb } = PDFLib;
    const addLog = this.options.addLog || (() => {});

    // Для обнаружения глав старого формата (только ранобэ)
    const siteType = this.options.siteType || 'ranobe';
    this.isRanobe = siteType === 'ranobe' || siteType === 'ranobelib';

    // Создаём PDF документ
    const pdfDoc = await PDFDocument.create();
    this.fallbackFont = undefined; // undefined - ещё не нужен, null - не загрузился
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
    const isManga = (this.options.siteType || 'ranobe') === 'manga' || (this.options.siteType || 'ranobe') === 'hentai' || (this.options.siteType || 'ranobe') === 'shlib';

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
        const imageBytes = await imageBlob.arrayBuffer();

        // Определяем формат для PDF по настройкам
        const pdfImageFormat = this.options.pdfImageFormat || 'original-png';
        const pdfJpegQuality = this.options.pdfJpegQuality || 1.0;

        // Конвертируем в выбранный формат и применяем качество
        let finalImageBytes = imageBytes;
        const needsConversion = pdfImageFormat === 'original-jpeg' || pdfImageFormat === 'original-png';
        const targetFormat = pdfImageFormat === 'original-jpeg' ? 'jpeg' : 'png';

        // Конвертируем только если формат не PNG/JPEG или нужно изменить формат
        if (needsConversion && (imageBlob.type !== 'image/png' && imageBlob.type !== 'image/jpeg')) {
          // WebP/AVIF/GIF → конвертируем в выбранный формат
          const img = new Image();
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = URL.createObjectURL(imageBlob);
          });

          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);

          const outputFormat = targetFormat === 'jpeg' ? 'image/jpeg' : 'image/png';
          const outputQuality = targetFormat === 'jpeg' ? pdfJpegQuality : undefined;
          const convertedBlob = await new Promise(resolve => canvas.toBlob(resolve, outputFormat, outputQuality));
          finalImageBytes = await convertedBlob.arrayBuffer();
          URL.revokeObjectURL(img.src);
        }

        // Определяем тип изображения по фактическому типу blob
        const actualType = needsConversion && (imageBlob.type !== 'image/png' && imageBlob.type !== 'image/jpeg')
          ? (targetFormat === 'jpeg' ? 'image/jpeg' : 'image/png')
          : imageBlob.type;

        let pdfImage;
        try {
          if (actualType === 'image/png') {
            pdfImage = await pdfDoc.embedPng(finalImageBytes);
          } else {
            pdfImage = await pdfDoc.embedJpg(finalImageBytes);
          }
        } catch (error) {
          // Fallback: если JPEG не сработал, попробуем PNG
          if (actualType !== 'image/png') {
            try {
              pdfImage = await pdfDoc.embedPng(finalImageBytes);
            } catch (fallbackError) {
              throw new Error(`Не удалось декодировать изображение (ни как JPEG, ни как PNG): ${error.message}`);
            }
          } else {
            throw error;
          }
        }

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
      while (pageIndex < pages.length) {
        this.options.updateImageProgress?.(pageIndex, pages.length);
        const pageUrl = pages[pageIndex].url || pages[pageIndex];

        try {
          // Случайная пауза между картинками
          if (typeof window.maybeAddImagePause === 'function') {
            await window.maybeAddImagePause(addLog);
          }

          const imageResult = await this.downloadAndResizeImage(pageUrl, this.options.quality || 'ORIGINAL', this.options.pdfImageFormat, 'картинка');
          if (!imageResult || !imageResult.blob) {
            throw new Error('Не удалось скачать изображение');
          }
          const imageBlob = imageResult.blob;

          // Декодируем через canvas для надёжности (особенно для img2.imglib.info)
          const img = new Image();
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = () => reject(new Error('Не удалось загрузить изображение в canvas'));
            img.src = URL.createObjectURL(imageBlob);
          });

          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);

          // Используем настройки формата и качества для PDF
          const pdfImageFormat = this.options.pdfImageFormat || 'original-png';
          const pdfJpegQuality = this.options.pdfJpegQuality || 1.0;

          const needsConversion = pdfImageFormat === 'original-jpeg' || pdfImageFormat === 'original-png';
          const targetFormat = pdfImageFormat === 'original-jpeg' ? 'jpeg' : 'png';

          let canvasBlob;
          let imageBytes;
          if (needsConversion && (imageBlob.type !== 'image/png' && imageBlob.type !== 'image/jpeg')) {
            // WebP/AVIF/GIF → конвертируем в выбранный формат
            const outputFormat = targetFormat === 'jpeg' ? 'image/jpeg' : 'image/png';
            const outputQuality = targetFormat === 'jpeg' ? pdfJpegQuality : undefined;
            canvasBlob = await new Promise(resolve => canvas.toBlob(resolve, outputFormat, outputQuality));
            imageBytes = await canvasBlob.arrayBuffer();
          } else {
            // PNG/JPEG → оставляем как есть, но через canvas для consistency
            canvasBlob = await new Promise(resolve => canvas.toBlob(resolve, imageBlob.type));
            imageBytes = await canvasBlob.arrayBuffer();
          }

          URL.revokeObjectURL(img.src);

          this.imagesDownloaded++;
          if (window.incrementTotalImages) {
            window.incrementTotalImages();
          }

          // Встраиваем в PDF уже конвертированные байты
          let pdfImage;
          try {
            // Определяем тип для встраивания
            const actualType = needsConversion && (imageBlob.type !== 'image/png' && imageBlob.type !== 'image/jpeg')
              ? (targetFormat === 'jpeg' ? 'image/jpeg' : 'image/png')
              : imageBlob.type;

            if (actualType === 'image/png') {
              pdfImage = await pdfDoc.embedPng(imageBytes);
            } else {
              pdfImage = await pdfDoc.embedJpg(imageBytes);
            }
          } catch (error) {
            // Fallback: если JPEG не сработал, попробуем PNG
            try {
              pdfImage = await pdfDoc.embedPng(imageBytes);
            } catch (fallbackError) {
              throw new Error(`Не удалось декодировать изображение (ни как JPEG, ни как PNG): ${error.message}`);
            }
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
      await this.loadFallbackFontFor(pdfDoc, `${ch.displayTitle || ''}${doc.body.textContent}`, [font, boldFont], addLog);

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
                  // Пропускаем префикс data:image/...;base64,
                  const parts = imgSrc.split(',');
                  if (parts.length < 2) {
                    addLog(`Некорректный base64 формат: ${imgSrc.substring(0, 50)}...`, true);
                    continue;
                  }
                  const base64Data = parts[1];

                  // Декодируем base64
                  let decodedString;
                  try {
                    decodedString = atob(base64Data);
                  } catch (e) {
                    addLog(`Ошибка atob: ${e.message}`, true);
                    continue;
                  }

                  const imageBytes = Uint8Array.from(decodedString, c => c.charCodeAt(0));

                  // Определяем тип изображения по data URI или расширению
                  const isPng = imgSrc.includes('image/png') ||
                               imgSrc.toLowerCase().includes('.png');

                  let pdfImage;
                  try {
                    if (isPng) {
                      pdfImage = await pdfDoc.embedPng(imageBytes);
                    } else {
                      pdfImage = await pdfDoc.embedJpg(imageBytes);
                    }
                  } catch (error) {
                    // Fallback: если JPEG не сработал, попробуем PNG
                    if (!isPng) {
                      try {
                        pdfImage = await pdfDoc.embedPng(imageBytes);
                      } catch (fallbackError) {
                        throw new Error(`Не удалось декодировать изображение (ни как JPEG, ни как PNG): ${error.message}`);
                      }
                    } else {
                      throw error;
                    }
                  }

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

  // Запасной шрифт встраивается подмножеством и только в PDF, где есть символы без глифа в выбранном шрифте
  async loadFallbackFontFor(pdfDoc, text, fonts, addLog) {
    if (this.fallbackFont !== undefined) return;
    const missing = [...text].some(char => fonts.some(font => !this.charsOf(font).has(char.codePointAt(0))));
    if (!missing) return;
    this.fallbackFont = null;
    try {
      const response = await fetch(chrome.runtime.getURL(PDF_FALLBACK_FONT));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.fallbackFont = await pdfDoc.embedFont(await response.arrayBuffer(), { subset: true });
    } catch (error) {
      addLog(`Не загрузился шрифт для иероглифов, они могут не отобразиться: ${error.message}`, true);
    }
  }

  // Строка -> куски одного шрифта: символ без глифа в основном шрифте берётся из запасного, если там он есть
  textRuns(text, font) {
    const fallback = this.fallbackFont;
    if (!fallback) return [{ text, font }];
    const own = this.charsOf(font);
    const extra = this.charsOf(fallback);
    const runs = [];
    for (const char of text) {
      const code = char.codePointAt(0);
      const runFont = own.has(code) || !extra.has(code) ? font : fallback;
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
