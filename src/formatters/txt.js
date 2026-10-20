class TxtFormatter extends BaseFormatter {
  constructor(options) {
    super(options);
    this.zip = new JSZip();
  }

  getExtension() {
    const textOnly = this.options.textOnly || false;
    return textOnly ? 'txt' : 'zip';
  }

  getMimeType() {
    const textOnly = this.options.textOnly || false;
    return textOnly ? 'text/plain' : 'application/zip';
  }

  async format(chapters, metadata) {
    const filteredChapters = this.filterChapters(chapters);

    if (!filteredChapters || filteredChapters.length === 0) {
      throw new Error('Нет глав для генерации TXT');
    }

    // Для обнаружения глав старого формата (только ранобэ)
    const siteType = this.options.siteType || 'ranobe';
    this.isRanobe = siteType === 'ranobe' || siteType === 'ranobelib';
    const addLog = this.options.addLog || (() => {});

    let txtContent = '';
    let imagesDownloaded = 0;
    let imagesFailed = 0;
    let globalImageCounter = 1; // Глобальный счетчик для нумерации картинок

    // Добавляем информацию о произведении
    if (metadata) {
      txtContent += this.generateInfoPage(metadata);
    }

    // Проверяем, нужно ли скачивать картинки
    const textOnly = this.options.textOnly || false;
    const includeImages = !textOnly && this.options.quality !== 'NONE';
    const includeCovers = !textOnly && this.options.coverQuality !== 'NONE';

    let coversStats = { downloaded: 0, failed: 0, total: 0 };
    if (includeCovers) {
      // Скачиваем обложки в ZIP
      coversStats = await this.processCovers(this.zip);
    } else {
      // В режиме "Без обложек" или "Только текст" - только считаем обложки по URL (не скачиваем)
      const metadata = this.options.metadata || {};
      const allCovers = this.options.allCovers || [metadata.cover || this.options.originalCover || ''];
      const coversToDownload = allCovers.filter(c => c);
      coversStats = { downloaded: 0, failed: 0, total: coversToDownload.length };
    }

    // Обрабатываем главы
    for (let i = 0; i < filteredChapters.length; i++) {
      const ch = filteredChapters[i];

      if (this.options.addLog) {
        this.options.addLog(`[${i + 1}/${filteredChapters.length}] ЗАГРУЗКА: ${ch.displayTitle}...`);
      }

      const { chapterContent, attachments } = await this.fetchChapterData(ch);

      // Проверяем на старый формат (только для ранобэ)
      if (this.isRanobe && typeof chapterContent === 'string') {
        if (this.options.addOldFormatChapter) {
          this.options.addOldFormatChapter(ch.displayTitle);
        }
      }

      // Создаем attachment map для картинок
      const attachmentMap = this.buildAttachmentMap(attachments);

      let mangaId = this.extractMangaId(attachments);

      const textContent = await this.convertJsonToText(chapterContent, {
        mangaId: mangaId,
        chapterId: ch.id || '',
        attachmentMap: attachmentMap,
        attachments: attachments,
        textOnly: textOnly,
        includeImages: includeImages,
        onImageDownloaded: () => {
          imagesDownloaded++;
          if (window.incrementTotalImages) {
            window.incrementTotalImages();
          }
        },
        onImageFailed: () => { imagesFailed++; },
        getNextImageNumber: () => {
          const num = globalImageCounter++;
          return String(num).padStart(4, '0');
        }
      });

      const noHeaders = this.options.settings?.tocFormat === 'no_headers';
      if (!noHeaders) {
        txtContent += `${ch.displayTitle}\n`;
        txtContent += '-'.repeat(30) + '\n\n';
      }
      txtContent += textContent + '\n\n';

      if (this.options.updateProgress) {
        this.options.updateProgress(i + 1, filteredChapters.length);
      }

      // Статистика
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
      if (this.options.addFileSize) {
        this.options.addFileSize(txtContent.length);
      }
    }

    if (includeImages) {
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
      if (window.setTotalImages) {
        window.setTotalImages(imagesDownloaded);
      }

      // Создаем ZIP архив с умным названием файла
      const fileName = this.generateFileName(metadata);
      this.zip.file(`${fileName}.txt`, txtContent);
      const content = await this.generateZip(this.zip);

      return { blob: content, filename: fileName + '.zip' };
    } else {
      // Только текст
      const blob = new Blob([txtContent], { type: 'text/plain; charset=utf-8' });
      const fileName = this.generateFileName(metadata);

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

      // В режиме Только текст считаем картинки по количеству меток [Картинка]
      const imageMarkerCount = (txtContent.match(/\[Картинка/g) || []).length;

      // Обновляем статистику
      if (window.setTotalChapters) {
        window.setTotalChapters(filteredChapters.length);
      }
      if (window.setTotalCovers && coversStats) {
        window.setTotalCovers(coversStats.downloaded);
      }
      if (window.setTotalImages) {
        window.setTotalImages(imageMarkerCount);
      }

      return { blob: blob, filename: fileName + '.txt' };
    }
  }


  async processCovers(zip) {
    const metadata = this.options.metadata || {};
    const coverQuality = this.options.coverQuality || 'ORIGINAL';
    const allCovers = this.options.allCovers || [metadata.cover || this.options.originalCover || ''];
    const coversToDownload = allCovers.filter(c => c);

    if (coverQuality === 'NONE') {
      return { downloaded: 0, failed: 0, total: coversToDownload.length };
    }

    if (coversToDownload.length === 0) {
      return { downloaded: 0, failed: 0, total: 0 };
    }

    const coversFolder = zip.folder("Обложки");
    let downloaded = 0;
    let failed = 0;

    for (let i = 0; i < coversToDownload.length; i++) {
      const coverItem = coversToDownload[i];
      if (!coverItem) continue;

      const actualUrl = this.extractCoverUrl(coverItem);

      if (!actualUrl) {
        if (this.options.addLog) {
          this.options.addLog(`Пропуск обложки ${i + 1}: неверный формат URL`);
          failed++;
        }
        continue;
      }

      try {
        const blob = await this.downloadCoverWithFallback(actualUrl, coverQuality);

        const imageFormat = this.options.imageFormat || 'original';
        const coverExtension = this.getImageExtension(blob, imageFormat, actualUrl);
        const coverFileName = `cover_${i + 1}${coverExtension}`;
        coversFolder.file(coverFileName, blob);
        downloaded++;
        if (window.incrementTotalCovers) {
          window.incrementTotalCovers();
        }
      } catch (e) {
        if (this.options.addLog) {
          this.options.addLog(`Ошибка загрузки обложки ${i + 1}: ${e.message}`, true);
        }
        failed++;
        if (this.options.incrementErrorCount) {
          this.options.incrementErrorCount();
        }
      }
    }

    return { downloaded, failed, total: coversToDownload.length };
  }

  async convertJsonToText(chapterContent, context = {}) {
    if (!chapterContent) return '';

    let text = '';

    if (chapterContent.content) {
      // Если content - это HTML строка, парсим её
      if (typeof chapterContent.content === 'string') {
        text += await this.htmlToText(chapterContent.content, context);
      } else {
        // Если content - это JSON структура, обрабатываем через processNode
        text += await this.processNode(chapterContent.content, context);
      }
    } else {
      // Если content нет, пробуем обработать сам chapterContent как структуру
      text += await this.processNode(chapterContent, context);
    }

    return text;
  }

  async processNode(node, context = {}) {
    if (!node) return '';

    if (typeof node === 'string') {
      // Обработка HTML строк с скачиванием картинок (как в EPUB)
      return await this.htmlToText(node, context);
    }

    if (Array.isArray(node)) {
      let text = '';
      for (const item of node) {
        text += await this.processNode(item, context);
      }
      return text;
    }

    if (node.type === 'doc') {
      return await this.processNode(node.content, context);
    }
    
    if (node.type === 'heading') {
      const content = await this.processNode(node.content, context) || '';
      return `\n${content}\n`;
    }
    
    if (node.type === 'paragraph') {
      const content = await this.processNode(node.content, context) || '';
      return `${content}\n\n`;
    }
    
    if (node.type === 'horizontalRule') {
      return '\n' + '-'.repeat(30) + '\n\n';
    }
    
    if (node.type === 'hardBreak') {
      return '\n';
    }
    
    if (node.type === 'text') {
      let text = node.text || "";
      if (node.marks) {
        node.marks.forEach(mark => {
          if (mark.type === 'italic') text = `_${text}_`;
          else if (mark.type === 'bold') text = `*${text}*`;
          else if (mark.type === 'underline') text = `<u>${text}</u>`;
          else if (mark.type === 'strike') text = `~~${text}~~`;
        });
      }
      return text;
    }

    if (node.type === 'image') {
      const textOnly = context.textOnly || false;
      const includeImages = context.includeImages !== false && this.options.quality !== 'NONE';
      const caption = node.attrs?.description || '';

      if (textOnly || !includeImages) {
        // Определяем маркер из настроек
        const markerStyle = this.options.txtImageMarker || 'numbered';
        const getNextImageNumber = context.getNextImageNumber || (() => '???');
        let marker = '';
        if (markerStyle === 'numbered') {
          const imageNumber = getNextImageNumber();
          marker = `[Картинка ${imageNumber}]${caption ? ` - ${caption}` : ''}\n`;
        } else if (markerStyle === 'simple') {
          marker = `[Картинка]${caption ? ` - ${caption}` : ''}\n`;
        } else {
          marker = caption ? `${caption}\n` : '\n';
        }
        return marker;
      }

      const imagesData = node.attrs?.images;
      
      if (Array.isArray(imagesData) && imagesData.length > 0) {
        const attachmentMap = context.attachmentMap || {};
        const mangaId = context.mangaId || this.options.mangaId || '';
        const chapterId = context.chapterId || this.options.chapterId || '';
        const getNextImageNumber = context.getNextImageNumber || (() => '???');

        let imageText = '';
        
        for (const img of imagesData) {
          const imgUrl = img?.image || img?.src || img?.url;
          
          if (!imgUrl) {
            if (this.options.debug && this.options.addLog) {
              this.options.addLog(`Пропуск картинки без URL в группе`);
            }
            continue;
          }
          
          const imageNumber = getNextImageNumber();
          
          // Если это UUID (без расширения), используем URL из attachmentMap
          if (!imgUrl.startsWith('http') && !imgUrl.startsWith('/') && !imgUrl.includes('.')) {
            const attachmentInfo = attachmentMap[imgUrl];
            if (attachmentInfo && attachmentInfo.url) {
              const fullUrl = attachmentInfo.url;

              try {
                const imageResult = await this.downloadAndResizeImage(fullUrl, this.options.quality, this.options.imageFormat, 'картинка');
                const blob = imageResult.blob;
                const imageFormat = this.options.imageFormat || 'original';
                const imgExtension = this.getImageExtension(blob, imageFormat, fullUrl);
                const imgFileName = `${imageNumber}${imgExtension}`;
                const imagesFolder = this.zip.folder("Картинки");
                imagesFolder.file(imgFileName, blob);

                // Определяем маркер из настроек
                const markerStyle = this.options.txtImageMarker || 'numbered';
                if (markerStyle === 'numbered') {
                  imageText += `[Картинка ${imageNumber}]`;
                } else if (markerStyle === 'simple') {
                  imageText += `[Картинка]`;
                }
                if (caption) imageText += ` - ${caption}`;
                imageText += '\n';

                if (context.onImageDownloaded) context.onImageDownloaded();
              } catch (e) {
                if (this.options.addLog) {
                  this.options.addLog(`Error loading UUID image ${fullUrl}: ${e.message}`, true);
                }
                if (this.options.incrementErrorCount) {
                  this.options.incrementErrorCount();
                }
                if (context.onImageFailed) context.onImageFailed();
                imageText += '[Не удалось загрузить картинку]\n';
              }
            } else {
              if (this.options.addLog) {
                this.options.addLog(`URL не найден в attachmentMap для UUID: ${imgUrl}`, true);
              }
              imageText += '[Не удалось загрузить картинку]\n';
            }
          } else {
            // Обычный URL
            try {
              const imageResult = await this.downloadAndResizeImage(imgUrl, this.options.quality, this.options.imageFormat, 'картинка');
              const blob = imageResult.blob;
              const imageFormat = this.options.imageFormat || 'original';
              const imgExtension = this.getImageExtension(blob, imageFormat, imgUrl);
              const imgFileName = `${imageNumber}${imgExtension}`;
              const imagesFolder = this.zip.folder("Картинки");
              imagesFolder.file(imgFileName, blob);

              // Определяем маркер из настроек
              const markerStyle = this.options.txtImageMarker || 'numbered';
              if (markerStyle === 'numbered') {
                imageText += `[Картинка ${imageNumber}]`;
              } else if (markerStyle === 'simple') {
                imageText += `[Картинка]`;
              }
              if (caption) imageText += ` - ${caption}`;
              imageText += '\n';

              if (context.onImageDownloaded) context.onImageDownloaded();
            } catch (e) {
              if (this.options.addLog) {
                this.options.addLog(`Error loading image ${imgUrl}: ${e.message}`, true);
              }
              if (this.options.incrementErrorCount) {
                this.options.incrementErrorCount();
              }
              if (context.onImageFailed) context.onImageFailed();
              imageText += '[Не удалось загрузить картинку]\n';
            }
          }
        }
        
        return imageText;
      }
      
      // Обычная логика для одиночных картинок (обратная совместимость) - как в EPUB
      const imgData = node.attrs?.images?.[0] || node.attrs;
      let imgUrl = imgData?.src || imgData?.url || imgData?.image;
      const getNextImageNumber = context.getNextImageNumber || (() => '???');
      
      if (imgUrl && !imgUrl.startsWith('http') && !imgUrl.startsWith('/') && !imgUrl.includes('.')) {
        const attachmentMap = context.attachmentMap || {};
        const attachmentInfo = attachmentMap[imgUrl];
        
        if (attachmentInfo && attachmentInfo.url) {
          const fullUrl = attachmentInfo.url;
          const imageNumber = getNextImageNumber();
          
          try {
            const imageResult = await this.downloadAndResizeImage(fullUrl, this.options.quality, this.options.imageFormat, 'картинка');
            const blob = imageResult.blob;
            const imageFormat = this.options.imageFormat || 'original';
            const imgExtension = this.getImageExtension(blob, imageFormat, fullUrl);
            const imgFileName = `${imageNumber}${imgExtension}`;
            const imagesFolder = this.zip.folder("Картинки");
            imagesFolder.file(imgFileName, blob);
            
            if (context.onImageDownloaded) context.onImageDownloaded();
            return `[Картинка ${imageNumber}]${caption ? ` - ${caption}` : ''}\n`;
          } catch (e) {
            if (this.options.addLog) {
              this.options.addLog(`Error loading UUID image ${fullUrl}: ${e.message}`, true);
            }
            if (this.options.incrementErrorCount) {
              this.options.incrementErrorCount();
            }
            if (context.onImageFailed) context.onImageFailed();
            return '[Не удалось загрузить картинку]\n';
          }
        } else {
          if (this.options.addLog) {
            this.options.addLog(`URL не найден в attachmentMap для UUID: ${imgUrl}`, true);
          }
          return '[Не удалось загрузить картинку]\n';
        }
      }
      
      if (imgUrl) {
        const imageNumber = getNextImageNumber();
        try {
          const imageResult = await this.downloadAndResizeImage(imgUrl, this.options.quality, this.options.imageFormat, 'картинка');
          const blob = imageResult.blob;
          const imageFormat = this.options.imageFormat || 'original';
          const imgExtension = this.getImageExtension(blob, imageFormat, imgUrl);
          const imgFileName = `${imageNumber}${imgExtension}`;
          const imagesFolder = this.zip.folder("Картинки");
          imagesFolder.file(imgFileName, blob);

          // Определяем маркер из настроек
          const markerStyle = this.options.txtImageMarker || 'numbered';
          if (this.options.addLog) {
            this.options.addLog(`[TXT] markerStyle: ${markerStyle}`, false);
          }
          let marker = '';
          if (markerStyle === 'numbered') {
            marker = `[Картинка ${imageNumber}]${caption ? ` - ${caption}` : ''}\n`;
          } else if (markerStyle === 'simple') {
            marker = `[Картинка]${caption ? ` - ${caption}` : ''}\n`;
          } else {
            marker = caption ? `${caption}\n` : '\n';
          }

          if (context.onImageDownloaded) context.onImageDownloaded();
          return marker;
        } catch (e) {
          if (this.options.addLog) {
            this.options.addLog(`Error loading image ${imgUrl}: ${e.message}`, true);
          }
          if (this.options.incrementErrorCount) {
            this.options.incrementErrorCount();
          }
          if (context.onImageFailed) context.onImageFailed();
          return '[Не удалось загрузить картинку]\n';
        }
      } else {
        if (this.options.addLog) {
          this.options.addLog(`Картинка без URL. node.attrs: ${JSON.stringify(node.attrs)}`, true);
        }
        return '[Не удалось загрузить картинку]\n';
      }
    }

    if (node.content) return await this.processNode(node.content, context);
    return "";
  }

  async htmlToText(html, context = {}) {
    const textOnly = context.textOnly || false;
    const includeImages = context.includeImages !== false && this.options.quality !== 'NONE';
    const onImageDownloaded = context.onImageDownloaded || (() => {});
    const onImageFailed = context.onImageFailed || (() => {});
    const getNextImageNumber = context.getNextImageNumber || (() => '???');

    // Если есть attachments, встраиваем их в HTML перед парсингом
    if (context.attachments && Array.isArray(context.attachments) && context.attachments.length > 0) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = html;

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

      html = tempDiv.innerHTML;
    }

    // Создаем временный DOM для парсинга HTML
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html');

    // Обрабатываем картинки если нужно
    if (includeImages && !textOnly) {
      const images = doc.querySelectorAll('img');
      for (const img of images) {
        const src = img.getAttribute('src');
        if (src) {
          try {
            const imageResult = await this.downloadAndResizeImage(src, this.options.quality, this.options.imageFormat, 'картинка');
            const blob = imageResult.blob;
            const imageFormat = this.options.imageFormat || 'original';
            const imgExtension = this.getImageExtension(blob, imageFormat, src);
            const imageNumber = getNextImageNumber();
            const imgFileName = `${imageNumber}${imgExtension}`;
            const imagesFolder = this.zip.folder("Картинки");
            imagesFolder.file(imgFileName, blob);

            // Определяем маркер из настроек
            const markerStyle = this.options.txtImageMarker || 'numbered';
            let marker = '';
            if (markerStyle === 'numbered') {
              marker = `\n[Картинка ${imageNumber}]\n`;
            } else if (markerStyle === 'simple') {
              marker = '\n[Картинка]\n';
            } else {
              marker = '\n';
            }

            // Заменяем тег img на текстовый маркер
            img.outerHTML = marker;

            if (onImageDownloaded) onImageDownloaded();
          } catch (e) {
            if (this.options.addLog) {
              this.options.addLog(`Error loading image ${src}: ${e.message}`, true);
            }
            if (this.options.incrementErrorCount) {
              this.options.incrementErrorCount();
            }
            if (onImageFailed) onImageFailed();
            img.outerHTML = '[Не удалось загрузить картинку]\n';
          }
        }
      }
    } else if (textOnly || !includeImages) {
      // В режиме "Только текст" заменяем картинки на маркер с учётом настроек
      const markerStyle = this.options.txtImageMarker || 'numbered';
      const images = doc.querySelectorAll('img');
      for (const img of images) {
        const caption = img.alt || '';
        let marker = '';
        if (markerStyle === 'numbered') {
          const imageNumber = getNextImageNumber();
          marker = `\n[Картинка ${imageNumber}]${caption ? ` - ${caption}` : ''}\n`;
        } else if (markerStyle === 'simple') {
          marker = `\n[Картинка]${caption ? ` - ${caption}` : ''}\n`;
        } else {
          marker = caption ? `\n${caption}\n` : '\n';
        }
        img.outerHTML = marker;
      }
    }

    // textContent склеивает соседние абзацы (<p>…</p><p>…</p> без переносов): разделяем блоки пустой строкой, <br> — переносом
    doc.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    doc.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, li, blockquote').forEach(block => block.append('\n\n'));

    // Используем textContent чтобы захватить весь текст включая маркеры между параграфами
    let text = doc.body.textContent;

    // Очистка текста
    text = text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n\s*\n/g, '\n\n')
      .trim();

    return text;
  }

  generateInfoPage(metadata) {
    const hasMetadata = (metadata.titleRu || metadata.titleEn || metadata.titleOriginal || metadata.titleAlt ||
                       metadata.author || metadata.artist || metadata.year || metadata.country ||
                       metadata.publisher || metadata.description || metadata.status ||
                       metadata.ageRestriction || metadata.genres || metadata.tags);

    if (!hasMetadata) {
      return '';
    }

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
      'description': { label: fieldLabels['description'] || defaultFieldLabels['description'], value: metadata.description }
    };

    const fieldOrder = this.options.metadataFieldOrder || Object.keys(fieldMapping);

    let infoContent = '='.repeat(50) + '\n';
    infoContent += 'ИНФОРМАЦИЯ О ПРОИЗВЕДЕНИИ\n';
    infoContent += '='.repeat(50) + '\n\n';

    for (const fieldId of fieldOrder) {
      const field = fieldMapping[fieldId];
      if (field && field.value) {
        const formattedValue = field.format ? field.format(field.value) : field.value;
        infoContent += `${field.label}: ${formattedValue}\n`;
      }
    }

    infoContent += '\n' + '='.repeat(50) + '\n\n';

    return infoContent;
  }

}
