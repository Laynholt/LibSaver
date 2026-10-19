// Самое частое значение массива (при равенстве — встреченное первым); пустой массив → undefined
function mostCommonValue(values) {
  const counts = new Map();
  let best, top = 0;
  for (const value of values) {
    const count = (counts.get(value) || 0) + 1;
    counts.set(value, count);
    if (count > top) { top = count; best = value; }
  }
  return best;
}

class BaseFormatter {
  constructor(options) {
    this.options = options;
    // Счётчики для статистики по картинкам
    this.imageStats = {
      originalFormats: {},
      finalFormats: {},
      totalImages: 0,
      totalOriginalSize: 0,
      totalFinalSize: 0
    };
    // Счётчики для статистики по обложкам
    this.coverStats = {
      originalFormats: {},
      finalFormats: {},
      totalCovers: 0,
      totalOriginalSize: 0,
      totalFinalSize: 0
    };
  }

  // Текст в архиве сжимаем, а картинки уже сжаты: DEFLATE для них только тратит время. mimetype в EPUB обязан быть несжатым
  generateZip(zip) {
    zip.forEach((path, file) => {
      if (path !== 'mimetype' && !/\.(jpe?g|png|webp|gif|avif)$/i.test(path)) {
        file.options.compression = 'DEFLATE';
      }
    });
    return zip.generateAsync({ type: 'blob' });
  }

  // Обновить статистику по картинке
  updateImageStats(imageResult, isCover = false) {
    const stats = isCover ? this.coverStats : this.imageStats;

    if (isCover) {
      stats.totalCovers++;
    } else {
      stats.totalImages++;
    }
    stats.totalOriginalSize += imageResult.originalSize;
    stats.totalFinalSize += imageResult.finalSize;

    // Счётчик исходных форматов
    stats.originalFormats[imageResult.originalFormat] = (stats.originalFormats[imageResult.originalFormat] || 0) + 1;

    // Счётчик итоговых форматов
    stats.finalFormats[imageResult.finalFormat] = (stats.finalFormats[imageResult.finalFormat] || 0) + 1;
  }

  // Сбросить статистику по картинкам
  resetImageStats() {
    this.imageStats = {
      originalFormats: {},
      finalFormats: {},
      totalImages: 0,
      totalOriginalSize: 0,
      totalFinalSize: 0
    };
  }

  // Получить строку статистики форматов
  getFormatsString(formats) {
    const entries = Object.entries(formats).sort((a, b) => b[1] - a[1]);
    return entries.map(([format, count]) => `${count} - ${format}`).join(', ');
  }

  // Логировать итоговую статистику по картинкам (отключено по запросу пользователя)
  logImageStats() {
    // Функция оставлена для внутреннего использования, но не логирует
  }

  // Логировать итоговую статистику по обложкам (отключено по запросу пользователя)
  logCoverStats() {
    // Функция оставлена для внутреннего использования, но не логирует
  }

  async format(chapters, metadata) {
    throw new Error('Not implemented');
  }

  getExtension() {
    throw new Error('Not implemented');
  }

  getMimeType() {
    throw new Error('Not implemented');
  }

  async fetchWithRetry(url, options = {}, maxRetries = 5) {
    const delays = [5000, 10000, 15000];
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, options);

        if (attempt === 0 && !response.ok) {
          if (this.options.addLog) {
            this.options.addLog(`HTTP Status: ${response.status} (${response.statusText})`, true);
          }
        }

        if (response.ok) return response;

        if (response.status === 429) {
          if (attempt < maxRetries) {
            const delay = delays[Math.min(attempt, delays.length - 1)];
            if (this.options.addLog) {
              this.options.addLog(`Rate limited (429), waiting ${delay/1000}s before retry ${attempt + 1}/${maxRetries + 1}`);
            }
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          } else {
            throw new Error('Rate limited after 5 retry attempts (5s, 10s, 15s)');
          }
        }

        if (response.status >= 500) {
          if (this.options.addLog) {
            this.options.addLog(`Server error (${response.status}), adaptive speed reduced`, true);
          }
        } else if (response.status !== 408) {
          // 404/403 и прочие 4xx повтор не исправит — не ждём зря минуту
          throw Object.assign(new Error(`HTTP ${response.status}: ${response.statusText}`), { noRetry: true });
        }

        if (attempt < maxRetries) {
          const delay = delays[Math.min(attempt, delays.length - 1)];
          if (this.options.addLog) {
            this.options.addLog(`Request failed (${response.status}), retrying in ${delay/1000}s (attempt ${attempt + 1}/${maxRetries + 1})`);
          }
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } catch (error) {
        if (error.noRetry) throw error;
        lastError = error;
        if (attempt < maxRetries) {
          const delay = delays[Math.min(attempt, delays.length - 1)];
          if (this.options.addLog) {
            this.options.addLog(`Network error (${error.message}), retrying in ${delay/1000}s (attempt ${attempt + 1}/${maxRetries + 1})`);
          }
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError || new Error('Max retries exceeded');
  }

  async fetchChapterData(ch) {
    const slug = this.options.slug;
    
    // Используем переданную функцию trackRequest если она есть
    if (this.options.trackRequest) {
      await this.options.trackRequest();
    }
    
    // Определяем branch_id для выбора перевода
    const allChapters = this.options.chapters || [];
    const hasTitleTranslationVariants = allChapters.some(chapter => 
        chapter.branches && Array.isArray(chapter.branches) && chapter.branches.some(branch => 
            branch.branch_id !== null
        )
    );

    let branchId = null;
    const chapterBranchOverrides = this.options.chapterBranchOverrides || {};
    const translatorPriority = this.options.translatorPriority || [];

    // Функция для получения имени переводчика из ch.branches по branch_id
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

    let selectedTranslatorName = null;

    if (hasTitleTranslationVariants) {
        if (chapterBranchOverrides[ch.id]) {
            const translatorKey = chapterBranchOverrides[ch.id];
            branchId = translatorKey.split('_')[0];
            // Получаем имя выбранного переводчика из ch.branches
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
                    // Получаем имя выбранного переводчика из ch.branches
                    selectedTranslatorName = getTranslatorNameFromBranches(branchId);
                    break;
                }
            }
        }
    } else {
        // Если нет вариантов перевода, проверяем есть ли хоть один branch
        if (ch.branches && ch.branches.length > 0) {
            branchId = ch.branches[0].branch_id;
            selectedTranslatorName = getTranslatorNameFromBranches(branchId);
        }
    }

    const branchParam = (branchId && branchId !== 'null') ? `&branch_id=${branchId}` : '';
    
    const urls = [
      `https://api.cdnlibs.org/api/manga/${slug}/chapter?number=${ch.number}&volume=${ch.volume}${branchParam}`,
      `https://api.cdnlibs.org/api/manga/${slug}/chapters/players?chapter_ids[]=${ch.id}`
    ];

    let lastError = null;

    for (const url of urls) {
      try {
        const resp = await this.fetchWithRetry(url);
        if (!resp.ok) {
          continue;
        }

        const body = await resp.arrayBuffer();
        this.options.addDownloadedBytes?.(body.byteLength); // для скорости загрузки
        const json = JSON.parse(new TextDecoder().decode(body));

        if (!json || typeof json !== 'object') {
          continue;
        }

        let data = json.data;
        if (Array.isArray(data)) {
          if (data.length === 0) {
            continue;
          }
          data = data[0];
        }

        if (!data || typeof data !== 'object') {
          continue;
        }

        if (data.content) {
          const attachments = Array.isArray(data.attachments) ? data.attachments : [];

          // Получаем скачанного переводчика из API ответа
          let downloadedTranslatorName = 'Неизвестный';
          const downloadedBranchId = data.branch_id;
          if (data.teams && data.teams.length > 0) {
            downloadedTranslatorName = data.teams[0].name || 'Неизвестный';
          }

          // Логируем выбранного и скачанного переводчика если включен debugMode
          if (this.options.debug && this.options.onTranslatorSelected) {
            this.options.onTranslatorSelected(ch, selectedTranslatorName, branchId, downloadedTranslatorName, downloadedBranchId);
          }

          if (typeof data.content === 'string' && data.content.startsWith('{')) {
            try {
              const parsed = JSON.parse(data.content);
              return { chapterContent: parsed, attachments };
            } catch (e) {
              if (this.options.addLog) {
                this.options.addLog(`Failed to parse JSON content: ${e.message}`, true);
              }
              continue;
            }
          }
          if (typeof data.content === 'object') {
            return { chapterContent: data.content, attachments };
          }
          return { chapterContent: data.content, attachments };
        }
      } catch (e) {
        lastError = e;
        console.error('[fetchChapterData] Error fetching chapter:', e);
        if (this.options.addLog) {
          this.options.addLog(`Error fetching from ${url}: ${e.message}`, true);
        }
      }
    }

    if (this.options.addLog) {
      this.options.addLog(`Failed to fetch chapter ${ch.displayTitle} from all URLs`, true);
    }
    throw new Error(`Контент главы не найден. Возможно, глава доступна только авторизованным пользователям или по подписке. ${lastError ? `Ошибка: ${lastError.message}` : ''}`);
  }

  async downloadAndResizeImage(url, quality, targetFormat = null, imageType = 'картинка') {
    let imageError = false;

    try {
      // RateLimiter и пауза между картинками - только без «Ускорить» (см. trackImageRequest в download.js)
      await (this.options.trackImageRequest || this.options.trackRequest)?.();

      // Always use content script through tab context (like RanobeLIB)
      // В Firefox движок и background.js - одна фоновая страница, а своё сообщение страница не получает: directFetch зовём напрямую
      const fetchImage = imageUrl => new Promise(resolve => typeof directFetch === 'function'
        ? directFetch({ url: imageUrl }, resolve)
        : chrome.runtime.sendMessage({ action: 'fetchImage', url: imageUrl }, resolve));

      // Сервер оригиналов бывает закрыт целиком (403 на любой файл или нет ответа) — тот же файл в полном размере,
      // но сжатый, лежит на сервере сжатых картинок (с него же качает NekoShelf).
      // Раз отказав, он до конца загрузки не спрашивается: иначе каждая картинка ждала бы его повторов (до минуты)
      const compressedUrl = this.compressedImageUrl(url);
      let response = this.compressedFallbackLogged && compressedUrl ? null : await fetchImage(url);
      const fallbackUrl = !response?.success ? compressedUrl : null;
      if (fallbackUrl) {
        // Только строка лога (раздел «Загрузки»): форматтеры работают в движке, showToast там нет
        if (!this.compressedFallbackLogged && this.options.addLog) {
          this.options.addLog(`Сервер оригиналов ${new URL(url).hostname} недоступен (${response?.error || 'нет ответа'}) — картинки берутся сжатыми того же размера с ${new URL(fallbackUrl).hostname}`, true);
        }
        this.compressedFallbackLogged = true;
        response = await fetchImage(fallbackUrl);
      }

      if (!response || !response.success) {
        throw new Error(response?.error || 'Failed to fetch image through content script');
      }

      const base64 = response.data;
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = base64;
      });

      // Получаем оригинальный размер в байтах для статистики
      const originalBlob = await (await fetch(base64)).blob();
      const originalSize = originalBlob.size;
      this.options.addDownloadedBytes?.(originalSize); // для скорости загрузки
      const originalType = originalBlob.type;
      const originalFormat = originalType.replace('image/', '').toUpperCase();
      const originalKB = (originalSize / 1024).toFixed(1);

      // «Одинаковая ширина страниц»: широкие ужимаем, узкие растягиваем; дальше сжатие по качеству считается от этого размера
      // shortcut: полосу выше 32000px не трогаем — такой canvas Chrome не создаст
      const commonWidth = imageType === 'картинка' ? this.commonPageWidth : null;
      const sourceWidth = commonWidth && Math.round(img.height * commonWidth / img.width) <= 32000 ? commonWidth : img.width;
      const sourceHeight = Math.round(img.height * sourceWidth / img.width);
      let targetWidth = sourceWidth;
      let targetHeight = sourceHeight;

      // Get target size from quality
      let targetSize = 0;
      if (quality === '2K') targetSize = 1600;
      else if (quality === 'QHD') targetSize = 1440;
      else if (quality === 'FHD') targetSize = 1080;
      else if (quality === 'HD') targetSize = 720;
      else if (quality === 'qHD') targetSize = 540;
      else if (quality === 'SD') targetSize = 480;

      // Get resize method (default: MIN_SIDE)
      const resizeMethod = this.options.resizeMethod || 'MIN_SIDE';
      const adaptiveRatio = this.options.adaptiveRatio || 3;

      // Определяем формат изображений: переданный targetFormat или из настроек
      const imageFormat = targetFormat || this.options.imageFormat || 'original';

      // Логируем исходную картинку при подробном логировании
      if (this.options.debug && this.options.addLog) {
        const label = imageType === 'обложка' ? 'ИСХОДНАЯ ОБЛОЖКА' : 'ИСХОДНАЯ КАРТИНКА';
        this.options.addLog(`${label}: ${originalFormat}, ${img.width}x${img.height}, ${originalKB}KB`);
      }

      if (targetSize > 0) {
        // Calculate larger and smaller sides (orientation-independent)
        const largerSide = Math.max(sourceWidth, sourceHeight);
        const smallerSide = Math.min(sourceWidth, sourceHeight);
        const aspectRatio = largerSide / smallerSide; // Always >= 1

        // ADAPTIVE method: check aspect ratio first
        if (resizeMethod === 'ADAPTIVE') {
          // If aspect ratio is greater than threshold, don't resize
          if (aspectRatio >= adaptiveRatio) {
            // Don't resize - image is too stretched
            targetWidth = sourceWidth;
            targetHeight = sourceHeight;
          } else {
            // Use MIN_SIDE logic for normal aspect ratios
            if (smallerSide > targetSize) {
              const ratio = targetSize / smallerSide;
              targetWidth = Math.round(sourceWidth * ratio);
              targetHeight = Math.round(sourceHeight * ratio);
            }
          }
        }
        // MIN_SIDE method: resize based on smaller side
        else if (resizeMethod === 'MIN_SIDE') {
          if (smallerSide > targetSize) {
            const ratio = targetSize / smallerSide;
            targetWidth = Math.round(sourceWidth * ratio);
            targetHeight = Math.round(sourceHeight * ratio);
          }
        }
        // MAX_SIDE method: resize based on larger side
        else if (resizeMethod === 'MAX_SIDE') {
          if (largerSide > targetSize) {
            const ratio = targetSize / largerSide;
            targetWidth = Math.round(sourceWidth * ratio);
            targetHeight = Math.round(sourceHeight * ratio);
          }
        }
      }

      if (targetWidth !== img.width || targetHeight !== img.height) {
        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

        // Определяем формат вывода
        const jpegQuality = this.options.jpegQuality || 1.0;
        let outputFormat = 'image/jpeg';
        let outputQuality = jpegQuality;

        if (imageFormat === 'original') {
          // Сохраняем оригинальный формат если возможно
          if (originalType === 'image/png') {
            outputFormat = 'image/png';
            outputQuality = undefined; // PNG не поддерживает качество
          } else if (originalType === 'image/webp') {
            outputFormat = 'image/webp';
            outputQuality = jpegQuality;
          }
        } else if (imageFormat === 'original-png') {
          // Сохраняем PNG/JPEG как есть, WebP/AVIF/GIF → PNG
          if (originalType === 'image/png') {
            outputFormat = 'image/png';
            outputQuality = undefined;
          } else if (originalType === 'image/jpeg') {
            outputFormat = 'image/jpeg';
            outputQuality = jpegQuality;
          } else {
            // WebP/AVIF/GIF → PNG
            outputFormat = 'image/png';
            outputQuality = undefined;
          }
        } else if (imageFormat === 'original-jpeg') {
          // Сохраняем PNG/JPEG как есть, WebP/AVIF/GIF → JPEG
          if (originalType === 'image/png') {
            outputFormat = 'image/png';
            outputQuality = undefined;
          } else if (originalType === 'image/jpeg') {
            outputFormat = 'image/jpeg';
            outputQuality = jpegQuality;
          } else {
            // WebP/AVIF/GIF → JPEG
            outputFormat = 'image/jpeg';
            outputQuality = jpegQuality;
          }
        } else if (imageFormat === 'png') {
          outputFormat = 'image/png';
          outputQuality = undefined;
        } else if (imageFormat === 'webp') {
          outputFormat = 'image/webp';
          outputQuality = jpegQuality;
        }
        // для jpeg оставляем дефолт

        const blob = await new Promise(resolve => canvas.toBlob(resolve, outputFormat, outputQuality));
        const finalSize = blob.size;
        const finalFormat = outputFormat.replace('image/', '').toUpperCase();
        const finalKB = (finalSize / 1024).toFixed(1);
        const reduction = ((originalSize - finalSize) / originalSize * 100).toFixed(1);

        // Логируем сжатие при подробном логировании
        if (this.options.debug && this.options.addLog) {
          this.options.addLog(`Сжатие: ${originalFormat}, ${img.width}x${img.height} → ${targetWidth}x${targetHeight}, ${originalKB}KB → ${finalKB}KB`);
        }

        // Проверяем, была ли конвертация формата
        const formatChanged = finalFormat !== originalFormat;
        if (formatChanged && this.options.debug && this.options.addLog) {
          this.options.addLog(`Конвертация: ${originalFormat} → ${finalFormat}, ${targetWidth}x${targetHeight}, ${finalKB}KB → ${finalKB}KB`);
        }

        // Логируем итоговую картинку
        if (this.options.addLog) {
          if (this.options.debug) {
            const label = imageType === 'обложка' ? 'ИТОГОВАЯ ОБЛОЖКА' : 'ИТОГОВАЯ КАРТИНКА';
            this.options.addLog(`${label}: ${finalFormat}, ${targetWidth}x${targetHeight}, ${finalKB}KB`);
          } else {
            const label = imageType === 'обложка' ? 'Итоговая обложка' : 'Итоговая картинка';
            this.options.addLog(`${label}: ${finalFormat}, ${targetWidth}x${targetHeight}, ${finalKB}KB`);
          }
        }

        // Возвращаем blob + информация для статистики
        const result = {
          blob: blob,
          originalFormat: originalFormat,
          finalFormat: finalFormat,
          originalSize: originalSize,
          finalSize: finalSize,
          originalWidth: img.width,
          originalHeight: img.height,
          finalWidth: targetWidth,
          finalHeight: targetHeight
        };

        // Автоматически обновляем статистику
        this.updateImageStats(result, imageType === 'обложка');

        return result;
      }

      // ORIGINAL: возвращаем оригинальный blob без изменений
      // Но если нужно изменить формат даже без изменения размера
      let needsConversion = false;
      let conversionTargetFormat = null;

      if (imageFormat === 'original-png') {
        // Конвертировать только если не PNG и не JPEG
        needsConversion = originalType !== 'image/png' && originalType !== 'image/jpeg';
        conversionTargetFormat = 'png';
      } else if (imageFormat === 'original-jpeg') {
        // Конвертировать только если не PNG и не JPEG
        needsConversion = originalType !== 'image/png' && originalType !== 'image/jpeg';
        conversionTargetFormat = 'jpeg';
      } else if (imageFormat !== 'original' && imageFormat !== originalType.replace('image/', '')) {
        // Обычная конвертация
        needsConversion = true;
        conversionTargetFormat = imageFormat;
      }

      if (needsConversion && conversionTargetFormat) {
        // Конвертируем формат без изменения размера
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        const jpegQuality = this.options.jpegQuality || 1.0;
        let outputFormat = 'image/jpeg';
        let outputQuality = jpegQuality;

        if (conversionTargetFormat === 'png') {
          outputFormat = 'image/png';
          outputQuality = undefined;
        } else if (conversionTargetFormat === 'webp') {
          outputFormat = 'image/webp';
          outputQuality = jpegQuality;
        }

        const blob = await new Promise(resolve => canvas.toBlob(resolve, outputFormat, outputQuality));
        const finalSize = blob.size;
        const finalFormat = outputFormat.replace('image/', '').toUpperCase();
        const finalKB = (finalSize / 1024).toFixed(1);
        const change = ((finalSize - originalSize) / originalSize * 100).toFixed(1);

        // Логируем конвертацию при подробном логировании
        if (this.options.debug && this.options.addLog) {
          this.options.addLog(`Конвертация: ${originalFormat} → ${finalFormat}, ${img.width}x${img.height}, ${originalKB}KB → ${finalKB}KB`);
        }

        // Логируем итоговую картинку
        if (this.options.addLog) {
          const label = this.options.debug
            ? (imageType === 'обложка' ? 'ИТОГОВАЯ ОБЛОЖКА' : 'ИТОГОВАЯ КАРТИНКА')
            : (imageType === 'обложка' ? 'Итоговая обложка' : 'Итоговая картинка');
          this.options.addLog(`${label}: ${finalFormat}, ${img.width}x${img.height}, ${finalKB}KB`);
        }

        // Возвращаем blob + информация для статистики
        const result = {
          blob: blob,
          originalFormat: originalFormat,
          finalFormat: finalFormat,
          originalSize: originalSize,
          finalSize: finalSize,
          originalWidth: img.width,
          originalHeight: img.height,
          finalWidth: img.width,
          finalHeight: img.height
        };

        // Автоматически обновляем статистику
        this.updateImageStats(result, imageType === 'обложка');

        return result;
      }

      // Без изменений - возвращаем оригинальный blob
      const blob = await (await fetch(base64)).blob();

      // Логируем итоговую картинку
      if (this.options.addLog) {
        if (this.options.debug) {
          const label = imageType === 'обложка' ? 'ИТОГОВАЯ ОБЛОЖКА' : 'ИТОГОВАЯ КАРТИНКА';
          this.options.addLog(`${label}: ${originalFormat}, ${img.width}x${img.height}, ${originalKB}KB`);
        } else {
          const label = imageType === 'обложка' ? 'Итоговая обложка' : 'Итоговая картинка';
          this.options.addLog(`${label}: ${originalFormat}, ${img.width}x${img.height}, ${originalKB}KB`);
        }
      }

      // Возвращаем blob + информацию для статистики
      const result = {
        blob: blob,
        originalFormat: originalFormat,
        finalFormat: originalFormat,
        originalSize: originalSize,
        finalSize: originalSize,
        originalWidth: img.width,
        originalHeight: img.height,
        finalWidth: img.width,
        finalHeight: img.height
      };

      // Автоматически обновляем статистику
      this.updateImageStats(result, imageType === 'обложка');

      return result;
    } catch (error) {
      if (this.options.addLog) {
        this.options.addLog(`Ошибка загрузки ${imageType}: ${error.message}`, true);
      }
      if (this.options.incrementErrorCount) {
        this.options.incrementErrorCount();
      }
      throw error;
    }
  }

  filterChapters(chapters) {
    if (!this.options.selectedChapterIds || this.options.selectedChapterIds.length === 0) {
      return chapters;
    }
    return chapters.filter(ch => this.options.selectedChapterIds.includes(ch.id));
  }

  generateFileName(metadata) {
    const originalMetadata = this.options.originalMetadata || {};
    const titleRu = metadata.titleRu || originalMetadata.titleRu || originalMetadata.titleEn || originalMetadata.titleOriginal || 'Без названия';
    const author = metadata.author || '';
    const year = metadata.year || '';

    let fileName = titleRu;
    if (author && year) {
      fileName = `${author} - ${titleRu} (${year})`;
    } else if (author) {
      fileName = `${author} - ${titleRu}`;
    } else if (year) {
      fileName = `${titleRu} (${year})`;
    }

    return fileName.replace(/[\\/:*?"<>|]/g, '#');
  }

  buildAttachmentMap(attachments) {
    const attachmentMap = {};
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        if (att.name && att.url) {
          attachmentMap[att.name] = {
            url: att.url.startsWith('http') ? att.url : `https://ranobelib.me${att.url}`,
            extension: att.extension || 'jpg'
          };
        }
      }
    }
    return attachmentMap;
  }

  extractMangaId(attachments) {
    let mangaId = this.options.mangaId || '';
    if (attachments && attachments.length > 0 && attachments[0].url) {
      const urlMatch = attachments[0].url.match(/\/uploads\/ranobe\/([^\/]+)/);
      if (urlMatch) {
        mangaId = urlMatch[1];
      }
    }
    return mangaId;
  }



  extractCoverUrl(coverUrl) {
    if (!coverUrl) return null;
    
    if (typeof coverUrl === 'object' && coverUrl.url) {
      return coverUrl.url;
    } else if (typeof coverUrl === 'object' && coverUrl.dataUrl) {
      return coverUrl.dataUrl;
    }
    
    if (typeof coverUrl === 'string' && coverUrl) {
      return coverUrl;
    }
    
    return null;
  }

  async downloadCoverWithFallback(actualUrl, coverQuality) {
    if (actualUrl.startsWith('data:')) {
      // Для data: URI применяем настройки качества
      try {
        const res = await fetch(actualUrl);
        const blob = await res.blob();

        // Применяем resize (та же логика что в downloadAndResizeImage)
        return await this.applyImageQuality(blob, coverQuality);
      } catch (error) {
        if (this.options.addLog) {
          this.options.addLog(`Ошибка обработки локальной обложки: ${error.message}`, true);
        }
        throw error;
      }
    }

    // Always use content script through tab context (like RanobeLIB)
    const result = await this.downloadAndResizeImage(actualUrl, coverQuality, null, 'обложка');
    return result.blob;
  }

  /**
   * Применяет настройки качества к уже загруженному blob
   * @param {Blob} blob - Изображение
   * @param {string} quality - Настройка качества
   * @returns {Blob} - Обработанное изображение
   */
  async applyImageQuality(blob, quality) {
    if (quality === 'ORIGINAL' || quality === 'NONE') {
      return blob;
    }

    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = URL.createObjectURL(blob);
    });

    const originalType = blob.type;
    const width = img.width;
    const height = img.height;
    const smallerSide = Math.min(width, height);
    const largerSide = Math.max(width, height);

    // Определяем размер для resize
    const qualityMap = {
      '2K': 1600,
      'QHD': 1440,
      'FHD': 1080,
      'HD': 720,
      'qHD': 540,
      'SD': 480
    };
    const targetSize = qualityMap[quality];

    if (!targetSize) {
      URL.revokeObjectURL(img.src);
      return blob;
    }

    const resizeMethod = this.options.resizeMethod || 'MIN_SIDE';
    const adaptiveRatio = this.options.adaptiveRatio || 3;
    let targetWidth = width;
    let targetHeight = height;

    if (resizeMethod === 'ADAPTIVE') {
      const aspectRatio = largerSide / smallerSide;
      if (aspectRatio > adaptiveRatio) {
        if (largerSide > targetSize) {
          const ratio = targetSize / largerSide;
          targetWidth = Math.round(width * ratio);
          targetHeight = Math.round(height * ratio);
        }
      } else {
        if (smallerSide > targetSize) {
          const ratio = targetSize / smallerSide;
          targetWidth = Math.round(width * ratio);
          targetHeight = Math.round(height * ratio);
        }
      }
    } else if (resizeMethod === 'MIN_SIDE') {
      if (smallerSide > targetSize) {
        const ratio = targetSize / smallerSide;
        targetWidth = Math.round(width * ratio);
        targetHeight = Math.round(height * ratio);
      }
    } else if (resizeMethod === 'MAX_SIDE') {
      if (largerSide > targetSize) {
        const ratio = targetSize / largerSide;
        targetWidth = Math.round(width * ratio);
        targetHeight = Math.round(height * ratio);
      }
    }

    // Всегда создаём canvas для конвертации формата (даже если размер не меняется)
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

    const jpegQuality = this.options.jpegQuality || 1.0;
    const imageFormat = this.options.imageFormat || 'original';
    let outputFormat = 'image/jpeg';
    let outputQuality = jpegQuality;

    if (imageFormat === 'original') {
      if (originalType === 'image/png') {
        outputFormat = 'image/png';
        outputQuality = undefined;
      } else if (originalType === 'image/webp') {
        outputFormat = 'image/webp';
        outputQuality = jpegQuality;
      }
    } else if (imageFormat === 'png') {
      outputFormat = 'image/png';
      outputQuality = undefined;
    } else if (imageFormat === 'webp') {
      outputFormat = 'image/webp';
      outputQuality = jpegQuality;
    }

    const resizedBlob = await new Promise(resolve => canvas.toBlob(resolve, outputFormat, outputQuality));
    URL.revokeObjectURL(img.src);



    return resizedBlob;
  }

  /**
   * Определяет расширение файла на основе настроек формата и blob
   * @param {Blob} blob - Изображение
   * @param {string} imageFormat - Настройка формата (original/jpeg/png/webp)
   * @param {string} url - URL изображения (для fallback если blob.type неизвестен)
   * @returns {string} - Расширение файла с точкой (.jpg, .png, .webp, .avif, и т.д.)
   */
  getImageExtension(blob, imageFormat = 'original', url = '') {
    // Явный выбор формата
    if (imageFormat === 'jpeg') {
      return '.jpg';
    } else if (imageFormat === 'png') {
      return '.png';
    } else if (imageFormat === 'webp') {
      return '.webp';
    }

    // Original - определяем из blob.type
    const type = blob.type.toLowerCase();
    if (type === 'image/jpeg' || type === 'image/jpg') {
      return '.jpg';
    } else if (type === 'image/png') {
      return '.png';
    } else if (type === 'image/webp') {
      return '.webp';
    } else if (type === 'image/gif') {
      return '.gif';
    } else if (type === 'image/avif') {
      return '.avif';
    } else if (type === 'image/bmp') {
      return '.bmp';
    } else if (type === 'image/svg+xml') {
      return '.svg';
    } else if (type === 'image/tiff') {
      return '.tiff';
    } else if (type === 'image/heic') {
      return '.heic';
    } else if (type === 'image/heif') {
      return '.heif';
    }

    // Fallback: определяем из URL
    if (url) {
      const urlLower = url.toLowerCase();
      if (urlLower.includes('.jpg') || urlLower.includes('.jpeg')) {
        return '.jpg';
      } else if (urlLower.includes('.png')) {
        return '.png';
      } else if (urlLower.includes('.webp')) {
        return '.webp';
      } else if (urlLower.includes('.gif')) {
        return '.gif';
      } else if (urlLower.includes('.avif')) {
        return '.avif';
      } else if (urlLower.includes('.bmp')) {
        return '.bmp';
      } else if (urlLower.includes('.svg')) {
        return '.svg';
      } else if (urlLower.includes('.tiff') || urlLower.includes('.tif')) {
        return '.tiff';
      } else if (urlLower.includes('.heic')) {
        return '.heic';
      } else if (urlLower.includes('.heif')) {
        return '.heif';
      }
    }

    // Последний fallback - конвертируем в JPEG (наиболее совместимый формат)
    return '.jpg';
  }

  async loadMangaChapterPages(tabId, chapterId, volume, number, slug, imageServer = 'normal', branchId = null, selectedTranslatorName = null) {
    try {
      const siteKey = this.options.siteKey || await siteKeyOfTab(tabId);
      const loaded = await pageCall(siteKey, 'mangaChapterPages', [chapterId, volume, number, slug, imageServer, branchId], tabId);

      if (loaded) {
        // «Одинаковая ширина страниц»: ширину берём из API первой главы, где она есть, и держим до конца загрузки
        if (this.options.sameWidth && !this.commonPageWidth && loaded.success) {
          this.commonPageWidth = mostCommonValue((loaded.pages || []).map(page => page.width).filter(width => width > 0));
          if (this.commonPageWidth && this.options.addLog) this.options.addLog(`Страницы приводятся к ширине ${this.commonPageWidth}px`);
        }
        return loaded;
      }

      return { success: false, error: 'Не удалось загрузить страницы главы' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // Конвертация ageRestriction.label с сайта в ComicInfo формат
  convertAgeRatingToComicInfo(ageRestriction) {
    if (!ageRestriction) return null;

    const rating = ageRestriction.trim();
    switch (rating) {
      case '6+':
        return 'G';
      case '12+':
        return 'PG';
      case '16+':
        return 'Teen';
      case '18+':
        return 'Mature 17+';
      case '18+ (RX)':
        return 'Adult 18+';
      default:
        return null;
    }
  }

  // Определение Manga типа по Типу и Формату с сайта
  determineMangaType(type, releaseFormat) {
    // Если в Формате есть "Вебтун" → всегда YesAndWebtoon
    if (releaseFormat && releaseFormat.includes('Вебтун')) {
      return 'YesAndWebtoon';
    }

    // Если Тип = "Манга" и нет "Вебтун" → Yes
    if (type && type === 'Манга') {
      return 'Yes';
    }

    // Во всех остальных случаях → не создавать строку (возвращаем null)
    return null;
  }

  // Генерация ComicInfo.xml
  generateComicInfoXml(
    editedMetadata,
    originalMetadata,
    volumeNum,
    pageCount,
    translators,
    webUrl,
    coverFiles = [],
    totalVolumes = 0
  ) {
    // Проверка и подготовка данных
    const series = editedMetadata.titleRu || originalMetadata.titleRu;
    if (!series) return null; // Series обязателен

    // LocalizedSeries: только непустые отредактированные EN/SRC/ALT через "/"
    const localizedSeriesParts = [];
    if (editedMetadata.titleEn) localizedSeriesParts.push(editedMetadata.titleEn);
    if (editedMetadata.titleOriginal) localizedSeriesParts.push(editedMetadata.titleOriginal);
    if (editedMetadata.titleAlt) {
      const altTitles = editedMetadata.titleAlt.split('\n').filter(t => t.trim());
      localizedSeriesParts.push(...altTitles);
    }
    const localizedSeries = localizedSeriesParts.length > 0 ? localizedSeriesParts.join(' / ') : null;

    // Summary: отредактированное описание
    const summary = editedMetadata.description || null;

    // Genre: только жанры и метки (отредактированные) через запятую
    const genreParts = [];
    if (editedMetadata.genres) genreParts.push(editedMetadata.genres);
    if (editedMetadata.tags) {
      // Убираем знак # из меток и разделяем по пробелам
      const tagsWithoutHash = editedMetadata.tags.replace(/#/g, '').trim();
      if (tagsWithoutHash) {
        const tagsArray = tagsWithoutHash.split(/\s+/);
        genreParts.push(...tagsArray);
      }
    }
    const genre = genreParts.length > 0 ? genreParts.join(', ') : null;

    // AgeRating: конвертируем из ageRestriction.label с сайта
    const ageRating = this.convertAgeRatingToComicInfo(originalMetadata.ageRestriction);

    // Year: отредактированный → с сайта
    const year = editedMetadata.year || originalMetadata.year || null;
    // Убираем букву "г." если есть
    const yearClean = year ? year.replace(/г\./g, '').trim() : null;

    // Publisher: отредактированный → с сайта
    const publisher = editedMetadata.publisher || originalMetadata.publisher || null;

    // Writer: отредактированный → с сайта
    const writer = editedMetadata.author || originalMetadata.author || null;

    // Penciller: отредактированный → с сайта → дублировать Writer
    const penciller = editedMetadata.artist || originalMetadata.artist || writer;

    // Manga: определяем по Типу и Формату с сайта
    const mangaType = this.determineMangaType(originalMetadata.country, originalMetadata.releaseFormat);

    // Генерация XML
    let xml = '<?xml version="1.0" encoding="utf-8"?>\n';
    xml += '<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n';

    xml += `  <Series>${this.escapeXml(series)}</Series>\n`;

    if (localizedSeries) {
      xml += `  <LocalizedSeries>${this.escapeXml(localizedSeries)}</LocalizedSeries>\n`;
    }

    xml += `  <Number>${volumeNum}</Number>\n`;
    xml += `  <Volume>${volumeNum}</Volume>\n`;

    // Добавляем Count только если статус = "Завершён / Завершён"
    if (originalMetadata.status === 'Завершён / Завершён' && totalVolumes >= 0) {
      xml += `  <Count>${totalVolumes}</Count>\n`;
    }

    if (summary) {
      xml += `  <Summary>${this.escapeXml(summary)}</Summary>\n`;
    }

    if (genre) {
      xml += `  <Genre>${this.escapeXml(genre)}</Genre>\n`;
    }

    if (webUrl) {
      // Убираем query параметры из URL
      const cleanWebUrl = webUrl.split('?')[0];
      xml += `  <Web>${this.escapeXml(cleanWebUrl)}</Web>\n`;
    }

    xml += '  <LanguageISO>ru</LanguageISO>\n';

    if (ageRating) {
      xml += `  <AgeRating>${ageRating}</AgeRating>\n`;
    }

    if (yearClean) {
      xml += `  <Year>${this.escapeXml(yearClean)}</Year>\n`;
    }

    if (publisher) {
      xml += `  <Publisher>${this.escapeXml(publisher)}</Publisher>\n`;
    }

    if (translators) {
      xml += `  <Translator>${this.escapeXml(translators)}</Translator>\n`;
    }

    if (writer) {
      xml += `  <Writer>${this.escapeXml(writer)}</Writer>\n`;
    }

    if (penciller) {
      xml += `  <Penciller>${this.escapeXml(penciller)}</Penciller>\n`;
    }

    xml += `  <PageCount>${pageCount}</PageCount>\n`;

    if (mangaType) {
      xml += `  <Manga>${mangaType}</Manga>\n`;
    }

    // Добавляем блок Pages с обложками, если они есть
    if (coverFiles && coverFiles.length > 0) {
      xml += '  <Pages>\n';
      coverFiles.forEach((coverFile, index) => {
        const pageType = index === 0 ? 'Cover' : 'AlternativeCover';
        xml += `    <Page Key="${this.escapeXml(coverFile)}" Image="${index}" Type="${pageType}" />\n`;
      });
      xml += '  </Pages>\n';
    }

    xml += '</ComicInfo>';

    return xml;
  }

  // Страницы главы качаются по 3 сразу, как в NekoShelf: take(i) запускает страницы i..i+2 и отдаёт промис i-й.
  // Ошибка страницы всплывает только в её очередь (решение «повторить/пропустить» идёт по порядку), повторный take(i) качает её заново
  pageLoader(urls, download, ahead = 3) {
    const started = [];
    return i => {
      for (let k = i; k < Math.min(i + ahead, urls.length); k++) {
        if (!started[k]) (started[k] = download(urls[k])).catch(() => {}); // ошибку заберёт её take
      }
      const promise = started[i];
      started[i] = null;
      return promise;
    };
  }

  // Тот же файл на сервере сжатых картинок (пары из /api/constants?fields[]=imageServers); null, если пары нет
  compressedImageUrl(url) {
    const hosts = {
      'img2.imglib.info': 'img3.cdnlibs.org',
      'img2h.hentaicdn.org': 'img3h.hentaicdn.org',
      'img2.hentaicdn.org': 'img3.hentaicdn.org',
      'img2.animelib.org': 'img3.animelib.org'
    };
    try {
      const parsed = new URL(url);
      if (!hosts[parsed.hostname]) return null;
      parsed.hostname = hosts[parsed.hostname];
      return parsed.href;
    } catch {
      return null;
    }
  }

  // Экранирование XML специальных символов
  escapeXml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // HTML главы пишут пользователи сайта: в итоговый файл не пускаем скрипты, обработчики и javascript:-ссылки
  sanitizeChapterDom(root) {
    root.querySelectorAll('script,style,iframe,frame,frameset,object,embed,applet,form,link,meta,base,template,noscript,animate,set').forEach(el => el.remove());
    for (const el of root.querySelectorAll('*')) {
      for (const { name, value } of Array.from(el.attributes)) {
        // Браузер игнорирует пробелы и управляющие символы в схеме URL (java\tscript:), поэтому убираем их перед проверкой
        if (/^on/i.test(name) || (/^(href|src|xlink:href|action|formaction|srcdoc)$/i.test(name) && /^(javascript|vbscript|data:text)/i.test(value.replace(/[\u0000- ]/g, '')))) {
          el.removeAttribute(name);
        }
      }
    }
    return root;
  }

  // Картинки выключены: заменяем их текстовой пометкой (textContent сам экранирует alt)
  replaceImagesWithPlaceholders(doc, withAlt) {
    for (const img of Array.from(doc.querySelectorAll('img'))) {
      const alt = withAlt ? img.getAttribute('alt') || '' : '';
      const span = doc.createElement('span');
      span.className = 'image-placeholder';
      span.textContent = alt ? `[Изображение пропущено: ${alt}]` : '[Изображение пропущено]';
      img.replaceWith(span);
    }
  }

  // innerHTML даёт HTML-сериализацию (<br>, &nbsp;), а главы EPUB — это XML: сериализуем узлы как XHTML
  serializeXhtml(root) {
    const serializer = new XMLSerializer();
    return Array.from(root.childNodes, node => serializer.serializeToString(node)).join('');
  }
}
