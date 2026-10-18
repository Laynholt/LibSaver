// CBZ Formatter for manga
class CbzFormatter extends BaseFormatter {
  constructor(options) {
    super(options);
    this.zip = new JSZip();
  }

  async format(chapters, metadata) {
    const addLog = this.options.addLog || (() => {});
    const imageServer = this.options.imageServer || 'normal';
    const format = this.options.format || 'cbz';
    const imageQuality = this.options.quality || 'ORIGINAL';

    // Настройки перевода
    const chapterBranchOverrides = this.options.chapterBranchOverrides || {};
    const translatorPriority = this.options.translatorPriority || [];

    // Данные для ComicInfo.xml приходят в options из снимка загрузки (в движке нет хранилища)
    const originalMetadata = this.options.originalMetadata || {}; // Оригинальные метаданные с сайта
    const allChapters = this.options.allChapters || []; // Все главы с сайта для подсчёта томов
    const sourceUrl = this.options.sourceUrl || '';

    // Группируем главы по томам
    const chaptersByVolume = {};
    for (const chapter of chapters) {
      if (!chapter.selected) continue;
      const volume = chapter.volume || '1';
      if (!chaptersByVolume[volume]) {
        chaptersByVolume[volume] = [];
      }
      chaptersByVolume[volume].push(chapter);
    }

    const volumes = Object.keys(chaptersByVolume).sort((a, b) => parseInt(a) - parseInt(b));

    // Вычисляем общее количество глав для прогресс-бара
    let totalChaptersCount = 0;
    for (const volume of volumes) {
      totalChaptersCount += chaptersByVolume[volume].length;
    }
    
    // Инициализируем прогресс-бар с общим количеством глав
    if (this.options.updateProgress) {
      this.options.updateProgress(0, totalChaptersCount);
    }
    
    // Если только один том - создаем прямой архив
    if (volumes.length === 1) {
      const volume = volumes[0];
      const volumeChapters = chaptersByVolume[volume];
      let globalProcessedCount = 0;
      const selectedCount = volumeChapters.length;
      const volumeResult = await this.createVolumeArchive(volume, volumeChapters, metadata, imageServer, chapterBranchOverrides, translatorPriority, globalProcessedCount, selectedCount, true, originalMetadata, sourceUrl, allChapters);

      // Обновляем статистику (картинки без обложек)
      if (window.setTotalChapters) {
        window.setTotalChapters(totalChaptersCount);
      }
      if (window.setTotalCovers) {
        window.setTotalCovers(volumeResult.coversDownloaded);
      }
      if (window.setTotalImages) {
        window.setTotalImages(volumeResult.totalImages - volumeResult.coversDownloaded);
      }

      const filename = this.generateFileName(metadata) + this.getExtension();
      return { blob: volumeResult.blob, filename };
    }
    
    // Несколько томов - создаем главный ZIP с архивами томов
    const mainZip = new JSZip();
    let globalProcessedCount = 0;
    let totalImagesAllVolumes = 0;
    let totalCoversAllVolumes = 0;

    for (let i = 0; i < volumes.length; i++) {
      const volume = volumes[i];
      const volumeChapters = chaptersByVolume[volume];
      const isFirstVolume = (i === 0);
      const volumeResult = await this.createVolumeArchive(volume, volumeChapters, metadata, imageServer, chapterBranchOverrides, translatorPriority, globalProcessedCount, totalChaptersCount, isFirstVolume, originalMetadata, sourceUrl, allChapters);
      globalProcessedCount += volumeChapters.length;
      totalImagesAllVolumes += volumeResult.totalImages;
      totalCoversAllVolumes += volumeResult.coversDownloaded;
      const volumeFilename = this.generateVolumeFilename(metadata, volume) + this.getExtension();
      mainZip.file(volumeFilename, volumeResult.blob);
    }

    // Генерируем главный архив с store compression
    const mainBlob = await mainZip.generateAsync({
      type: 'blob',
      compression: 'STORE',
      compressionOptions: { level: 0 }
    });

    // Обновляем статистику (картинки без обложек)
    if (window.setTotalChapters) {
      window.setTotalChapters(totalChaptersCount);
    }
    if (window.setTotalCovers) {
      window.setTotalCovers(totalCoversAllVolumes);
    }
    if (window.setTotalImages) {
      window.setTotalImages(totalImagesAllVolumes - totalCoversAllVolumes);
    }

    const mainFilename = this.generateFileName(metadata) + '.zip';
    return { blob: mainBlob, filename: mainFilename };
  }
  
  async createVolumeArchive(volume, chapters, metadata, imageServer, chapterBranchOverrides, translatorPriority, globalProcessedCount = 0, totalChaptersCount = 0, isFirstVolume = false, originalMetadata = {}, sourceUrl = '', allChapters = []) {
    const addLog = this.options.addLog || (() => {});
    const volumeZip = new JSZip();
    const tabId = this.options.tabId;
    const slug = this.options.slug;

    let totalImages = 0;
    let processedChapters = 0;
    let imagesFailed = 0;
    let coversStats = { downloaded: 0, failed: 0, total: 0 };

    // Сбор переводчиков для ComicInfo.xml
    const volumeTranslators = new Set();
    
    // Скачиваем обложки только для первого тома
    let coverFiles = []; // Список имён файлов загруженных обложек для ComicInfo.xml
    if (isFirstVolume) {
      coversStats = await this.processCovers(volumeZip);
      coverFiles = coversStats.coverFiles || [];
      totalImages += coversStats.downloaded;
      imagesFailed += coversStats.failed;
    }
    
    for (const chapter of chapters) {
      // Сбрасываем статистику картинок перед каждой главой
      this.resetImageStats();

      // Случайная пауза между главами (централизованная логика)
      if (typeof window.maybeAddRandomPause === 'function') {
        await window.maybeAddRandomPause(processedChapters, addLog);
      }

      // Определяем branch_id для текущей главы
      let branchId = null;
      let selectedTranslatorName = 'Неизвестный';

      // Функция для получения имени переводчика из chapter.branches по branch_id
      const getTranslatorNameFromBranches = (targetBranchId) => {
        if (!chapter.branches || !Array.isArray(chapter.branches)) {
          return 'Неизвестный';
        }
        const normalizedTargetId = targetBranchId === null ? 'null' : String(targetBranchId);
        const branch = chapter.branches.find(b => {
          const branchBranchId = b.branch_id === null ? 'null' : String(b.branch_id);
          return branchBranchId === normalizedTargetId;
        });
        if (branch && branch.teams && branch.teams.length > 0) {
          return branch.teams[0].name || 'Неизвестный';
        }
        return 'Неизвестный';
      };

      if (chapterBranchOverrides[chapter.id]) {
        // Индивидуальный override для этой главы
        const translatorKey = chapterBranchOverrides[chapter.id];
        branchId = translatorKey.split('_')[0];
        selectedTranslatorName = getTranslatorNameFromBranches(branchId);
      } else if (translatorPriority.length > 0 && chapter.branches && Array.isArray(chapter.branches)) {
        // Используем глобальный приоритет
        for (const translatorKey of translatorPriority) {
          const priorityBranchId = translatorKey.split('_')[0];
          const hasBranch = chapter.branches.some(branch => {
            const branchBranchId = branch.branch_id === null ? 'null' : String(branch.branch_id);
            return branchBranchId === priorityBranchId;
          });
          if (hasBranch) {
            branchId = priorityBranchId;
            selectedTranslatorName = getTranslatorNameFromBranches(branchId);
            break;
          }
        }
      } else if (chapter.branches && chapter.branches.length > 0) {
        // Если нет выбора, используем первый доступный branch
        branchId = chapter.branches[0].branch_id;
        selectedTranslatorName = getTranslatorNameFromBranches(branchId);
      }

      // Определяем правильный chapter_id для выбранного branch_id
      let chapterId = chapter.id;
      if (branchId && chapter.branches && Array.isArray(chapter.branches)) {
        const branchChapter = chapter.branches.find(b => String(b.branch_id) === String(branchId));
        if (branchChapter) {
          chapterId = branchChapter.id;
        }
      }

      addLog(`[${processedChapters + 1}/${totalChaptersCount}] Загрузка: ${chapter.displayTitle}...`);

      const volumeNum = chapter.volume || '1';
      const number = chapter.number || '0';

      let pagesResult;
      let shouldRetry = false;

      // Цикл для повторных попыток
      do {
        shouldRetry = false;
        try {
          pagesResult = await this.loadMangaChapterPages(tabId, chapterId, volumeNum, number, slug, imageServer, branchId, selectedTranslatorName);

          // Логируем переводчик если включен debugMode
          if (pagesResult.success && pagesResult.translatorInfo && this.options.debug && this.options.onTranslatorSelected) {
            const tempChapter = { volume: volumeNum, number: number };
            this.options.onTranslatorSelected(
              tempChapter,
              selectedTranslatorName,
              branchId,
              pagesResult.translatorInfo.downloadedTranslatorName,
              pagesResult.translatorInfo.downloadedBranchId
            );
          }
        } catch (error) {
          addLog(`  Ошибка при вызове loadChapterPages: ${error.message}`, true);

          // Сохраняем информацию об ошибке для retry/skip
          if (this.options.onChapterError) {
            const errorResult = await this.options.onChapterError(chapter, error, processedChapters);
            if (errorResult && errorResult.shouldRetry) {
              addLog(`  Повторная попытка загрузки главы...`);
              shouldRetry = true;
              continue;
            } else {
              // Если пользователь выбрал skip - продолжаем к следующей главе
              break;
            }
          } else {
            // Если нет обработчика ошибок - пропускаем главу как раньше
            break;
          }
        }

        if (!pagesResult || !pagesResult.success) {
          addLog(`  Ошибка загрузки страниц: ${pagesResult?.error || 'Unknown error'}`, true);

          // Сохраняем информацию об ошибке для retry/skip
          if (this.options.onChapterError) {
            const errorResult = await this.options.onChapterError(chapter, new Error(pagesResult?.error || 'Unknown error'), processedChapters);
            if (errorResult && errorResult.shouldRetry) {
              addLog(`  Повторная попытка загрузки главы...`);
              shouldRetry = true;
              continue;
            } else {
              // Если пользователь выбрал skip - продолжаем к следующей главе
              break;
            }
          } else {
            // Если нет обработчика ошибок - пропускаем главу как раньше
            break;
          }
        }
      } while (shouldRetry);

      // Если после retry всё равно не удалось загрузить - пропускаем главу
      if (!pagesResult || !pagesResult.success) {
        continue;
      }

      // Добавляем переводчика в Set для ComicInfo.xml
      if (pagesResult.translatorInfo && pagesResult.translatorInfo.downloadedTranslatorName) {
        volumeTranslators.add(pagesResult.translatorInfo.downloadedTranslatorName);
      } else if (selectedTranslatorName && selectedTranslatorName !== 'Неизвестный') {
        volumeTranslators.add(selectedTranslatorName);
      }

      // Обновляем прогресс с глобальным счётчиком
      if (this.options.updateProgress) {
        this.options.updateProgress(globalProcessedCount + processedChapters, totalChaptersCount);
      }
      
      // Обновляем индекс текущей главы
      if (this.options.updateChapterIndex) {
        this.options.updateChapterIndex(globalProcessedCount + processedChapters);
      }
      
      // Записываем время загрузки главы
      if (this.options.recordChapterTime) {
        this.options.recordChapterTime();
      }

      // Проверяем, отключено ли скачивание картинок
      const imageQuality = this.options.quality || 'ORIGINAL';
      if (imageQuality === 'NONE') {
        continue; // Пропускаем скачивание страниц для этой главы
      }

      // Скачиваем и добавляем изображения в архив
      let pageIndex = 0;
      const takePage = this.pageLoader(pagesResult.pages.map(page => page.url), url => this.downloadImage(url));
      while (pageIndex < pagesResult.pages.length) {
        this.options.updateImageProgress?.(pageIndex, pagesResult.pages.length);
        const page = pagesResult.pages[pageIndex];
        try {
          const imageBlob = await takePage(pageIndex);
          if (imageBlob) {
            const imageFormat = this.options.imageFormat || 'original';
            const imgExtension = this.getImageExtension(imageBlob, imageFormat, page.url);
            const filename = this.generatePageFilename(chapter, page, imgExtension);
            volumeZip.file(filename, imageBlob);
            totalImages++;
            if (window.incrementTotalImages) {
              window.incrementTotalImages();
            }

            // Статистика
            if (this.options.addFileSize) {
              this.options.addFileSize(imageBlob.size);
            }

            pageIndex++; // Переходим к следующей картинке
          } else {
            addLog(`    Не удалось загрузить изображение`, true);
            imagesFailed++;
            // Для манги останавливаем главу при ошибке картинки
            if (this.options.onImageError) {
              const errorResult = await this.options.onImageError(chapter, new Error('Не удалось загрузить изображение'), processedChapters, page.url);
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
          addLog(`    Ошибка загрузки изображения ${page.image}: ${error.message}`, true);
          imagesFailed++;
          // Для манги останавливаем главу при ошибке картинки
          if (this.options.onImageError) {
            const errorResult = await this.options.onImageError(chapter, error, processedChapters, page.url);
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
      processedChapters++;
      if (window.incrementTotalChapters) {
        window.incrementTotalChapters();
      }
    }

    // Генерируем ComicInfo.xml для CBZ формата (манга)
    const format = this.options.format || 'cbz';
    const generateComicInfo = this.options.generateComicInfo !== false; // По умолчанию включено

    if (format === 'cbz' || format === 'zip') {
      if (generateComicInfo) {
        // Собираем переводчиков в строку через "/"
        const translatorsString = Array.from(volumeTranslators).join(' / ');

        // Вычисляем PageCount (страницы без обложек)
        const pageCount = totalImages - coversStats.downloaded;

        // Вычисляем общее количество томов (количество уникальных томов)
        let totalVolumes = 0;
        if (allChapters && allChapters.length > 0) {
          const volumes = allChapters.map(ch => parseInt(ch.volume) || 0);
          const uniqueVolumes = [...new Set(volumes)];
          totalVolumes = uniqueVolumes.length;
        }

        // Генерируем ComicInfo.xml
        const comicInfoXml = this.generateComicInfoXml(
          metadata,
          originalMetadata,
          volume,
          pageCount,
          translatorsString,
          sourceUrl,
          coverFiles,
          totalVolumes
        );

        // Добавляем ComicInfo.xml в архив первым файлом
        if (comicInfoXml) {
          volumeZip.file('ComicInfo.xml', comicInfoXml);
        }
      }
    }

    // Генерируем архив тома с store compression
    const volumeBlob = await volumeZip.generateAsync({
      type: 'blob',
      compression: 'STORE',
      compressionOptions: { level: 0 }
    });

    // Возвращаем статистику для агрегации
    return {
      blob: volumeBlob,
      totalImages: totalImages,
      coversDownloaded: coversStats.downloaded
    };
  }
  
  generateVolumeFilename(metadata, volume) {
    const originalMetadata = this.options.originalMetadata || {};
    const titleRu = metadata.titleRu || originalMetadata.titleRu || originalMetadata.titleEn || originalMetadata.titleOriginal || 'Без названия';
    const cleanTitle = titleRu.replace(/[\\/:*?"<>|]/g, '#');
    const volumeNum = String(volume).padStart(2, '0');
    return `${cleanTitle} - Vol. ${volumeNum}`;
  }
  
  
  async downloadImage(url) {
    try {
      const result = await this.downloadAndResizeImage(url, this.options.quality || 'ORIGINAL', this.options.imageFormat, 'картинка');
      return result.blob;
    } catch (error) {
      if (this.options.addLog) {
        this.options.addLog(`Ошибка скачивания ${url}: ${error.message}`, true);
      }
      throw error;
    }
  }

  async processCovers(volumeZip) {
    const metadata = this.options.metadata || {};
    const coverQuality = this.options.coverQuality || 'ORIGINAL';

    if (coverQuality === 'NONE') {
      return { downloaded: 0, failed: 0, total: 0, coverFiles: [] };
    }

    const allCovers = this.options.allCovers ? this.options.allCovers : [metadata.cover || this.options.originalCover || ''];

    if (allCovers.length === 0) {
      return { downloaded: 0, failed: 0, total: 0, coverFiles: [] };
    }

    let coversDownloaded = 0;
    let coversFailed = 0;
    let coverFiles = []; // Список имён файлов загруженных обложек

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
        }
        coversFailed++;
        if (this.options.incrementSkippedImagesCount) {
          this.options.incrementSkippedImagesCount();
        }
        continue;
      }

      try {
        const coverBlob = await this.downloadCoverWithFallback(actualUrl, coverQuality);

        if (coverBlob) {
          const imageFormat = this.options.imageFormat || 'original';
          const coverExtension = this.getImageExtension(coverBlob, imageFormat);
          const coverFileName = `!cover_${String(i).padStart(3, '0')}${coverExtension}`;
          volumeZip.file(coverFileName, coverBlob);

          // Добавляем в список загруженных обложек
          coverFiles.push(coverFileName);

          coversDownloaded++;
          if (window.incrementTotalCovers) {
            window.incrementTotalCovers();
          }
        }
      } catch (e) {
        console.error(`Ошибка загрузки обложки ${i + 1}:`, e);
        coversFailed++;
        if (this.options.incrementSkippedImagesCount) {
          this.options.incrementSkippedImagesCount();
        }
        if (this.options.addLog) {
          this.options.addLog(`Ошибка загрузки обложки ${i + 1}: ${e.message}`, true);
        }
      }
    }

    return { downloaded: coversDownloaded, failed: coversFailed, total: allCovers.length, coverFiles };
  }

  generatePageFilename(chapter, page, extension) {
    // Формируем имя файла: chXXXX_YY_ZZZ.расширение
    const chapterNum = chapter.number || '0';

    // Разбираем номер главы на целую и дробную части
    let chapterWhole, chapterFraction;
    if (String(chapterNum).includes('.')) {
      const parts = String(chapterNum).split('.');
      chapterWhole = parts[0];
      chapterFraction = parts[1] || '0';
      // Дробная часть - до 2 цифр
      chapterFraction = chapterFraction.substring(0, 2);
    } else {
      chapterWhole = chapterNum;
      chapterFraction = '0';
    }

    // Целая часть главы до 4 цифр
    chapterWhole = String(chapterWhole).padStart(4, '0');

    // Дробная часть до 2 цифр
    chapterFraction = String(chapterFraction).padStart(2, '0');

    // Номер страницы до 3 цифр
    const pageNum = String(page.slug).padStart(3, '0');

    return `ch${chapterWhole}_${chapterFraction}_${pageNum}${extension}`;
  }
  
  getExtension() {
    const format = this.options.format || 'cbz';
    return format === 'zip' ? '.zip' : '.cbz';
  }
  
  getMimeType() {
    return 'application/vnd.comicbook+zip';
  }
}
