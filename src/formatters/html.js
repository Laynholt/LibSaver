class HtmlFormatter extends BaseFormatter {
  constructor(options) {
    super(options);
    this.zip = new JSZip();
  }

  getExtension() {
    return 'html';
  }

  getMimeType() {
    return 'text/html';
  }

  async format(chapters, metadata) {
    const filteredChapters = this.filterChapters(chapters);

    if (!filteredChapters || filteredChapters.length === 0) {
      throw new Error('Нет глав для генерации HTML');
    }

    const addLog = this.options.addLog || (() => {});

    // Обрабатываем обложки
    const coversStats = await this.processCovers();

    // Обрабатываем главы
    await this.processChapters(filteredChapters);

    // Генерируем ZIP с картинками
    const imagesZipBlob = await this.zip.generateAsync({ type: 'blob' });
    const imagesZipBase64 = await this.blobToBase64Pure(imagesZipBlob);

    // Генерируем HTML с images.zip как Base64 внутри
    const htmlContent = await this.generateHTML(filteredChapters, metadata, coversStats, imagesZipBase64);

    // Возвращаем HTML blob
    const blob = new Blob([htmlContent], { type: 'text/html' });
    const fileName = this.generateFileName(metadata) + '.html';

    return { blob: blob, filename: fileName };
  }

  async processCovers() {
    const metadata = this.options.metadata || {};
    const coverQuality = this.options.coverQuality || 'ORIGINAL';
    const allCovers = this.options.allCovers || [metadata.cover || this.options.originalCover || ''];

    let downloaded = 0;
    let failed = 0;
    const total = allCovers.length;
    const coverBase64 = [];
    const coverFiles = [];

    for (let i = 0; i < allCovers.length; i++) {
      const coverItem = allCovers[i];

      if (!coverItem) continue;

      const actualUrl = this.extractCoverUrl(coverItem);

      if (!actualUrl) {
        failed++;
        continue;
      }

      try {
        const result = await this.downloadAndResizeImage(actualUrl, coverQuality, null, 'обложка');
        const base64 = await this.blobToBase64(result.blob);
        coverBase64.push(base64);

        // Добавляем в ZIP
        const coverExtension = this.getImageExtension(result.blob, 'original', actualUrl);
        const coverFileName = `!cover_${String(i).padStart(3, '0')}${coverExtension}`;
        this.zip.file(coverFileName, result.blob);
        coverFiles.push(coverFileName);

        downloaded++;
      } catch (error) {
        failed++;
        console.error('Ошибка загрузки обложки ' + actualUrl + ':', error);
      }
    }

    return { downloaded, failed, total, coverBase64, coverFiles };
  }

  getImageExtension(blob, imageFormat, url) {
    if (imageFormat && imageFormat !== 'original') {
      return '.' + imageFormat.toLowerCase();
    }

    // Определяем по blob
    if (blob.type) {
      const mime = blob.type;
      if (mime === 'image/jpeg') return '.jpg';
      if (mime === 'image/png') return '.png';
      if (mime === 'image/webp') return '.webp';
      if (mime === 'image/gif') return '.gif';
    }

    // Определяем по URL
    if (url) {
      const urlLower = url.toLowerCase();
      if (urlLower.includes('.jpg') || urlLower.includes('.jpeg')) return '.jpg';
      if (urlLower.includes('.png')) return '.png';
      if (urlLower.includes('.webp')) return '.webp';
      if (urlLower.includes('.gif')) return '.gif';
    }

    return '.jpg';
  }

  extractCoverUrl(coverItem) {
    if (!coverItem) return null;

    if (typeof coverItem === 'string') {
      return coverItem;
    }

    if (coverItem.dataUrl) {
      return coverItem.dataUrl;
    }

    if (coverItem.src) {
      return coverItem.src;
    }

    if (coverItem.url) {
      return coverItem.url;
    }

    if (coverItem.full) {
      return coverItem.full;
    }

    return null;
  }

  async processChapters(chapters) {
    // Определяем тип контента (манга или ранобэ)
    const siteType = this.options.siteType || 'ranobe';
    const isManga = siteType === 'manga' || siteType === 'hentai' || siteType === 'shlib';

    if (isManga) {
      return await this.processMangaChapters(chapters);
    }

    // Обработка ранобэ (текст)
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];

      if (this.options.addLog) {
        this.options.addLog('[' + (i + 1) + '/' + chapters.length + '] ОБРАБОТКА: ' + ch.displayTitle + '...');
      }

      if (typeof window.maybeAddRandomPause === 'function') {
        await window.maybeAddRandomPause(i, this.options.addLog);
      }

      if (!ch.content) {
        try {
          const chapterData = await this.fetchChapterData(ch);
          ch.content = chapterData.chapterContent;
          ch.attachments = chapterData.attachments;
        } catch (error) {
          console.error('Ошибка загрузки контента главы ' + ch.displayTitle + ':', error);
          if (this.options.addLog) {
            this.options.addLog('Ошибка загрузка контента главы: ' + error.message, true);
          }
          continue;
        }
      }

      if (ch.content) {
        try {
          const attachmentMap = this.buildAttachmentMap(ch.attachments);
          const mangaId = this.extractMangaId(ch.attachments);

          // Счётчик картинок для ZIP
          let chapterImageIndex = 0;

          const htmlContent = await this.convertJsonToHtml(ch.content, null, {
            mangaId: mangaId,
            chapterId: ch.id || '',
            attachmentMap: attachmentMap,
            attachments: ch.attachments,
            imageFormat: this.options.imageFormat,
            onImageDownloaded: () => {},
            onImageFailed: () => {},
            getNextImageNumber: () => 'img_' + Math.random().toString(36).substr(2, 9),
            chapter: ch,
            chapterImageIndex: chapterImageIndex,
            addToZip: (blob, extension) => {
              const fileName = this.generatePageFilename(ch, chapterImageIndex, extension);
              this.zip.file(fileName, blob);
              chapterImageIndex++;
              return fileName;
            }
          });

          ch.htmlContent = htmlContent;
        } catch (error) {
          console.error('Ошибка конвертации контента главы ' + ch.displayTitle + ':', error);
          if (this.options.addLog) {
            this.options.addLog('Ошибка конвертации контента: ' + error.message, true);
          }
        }
      }
    }
  }

  async processMangaChapters(chapters) {
    const addLog = this.options.addLog || (() => {});
    const imageQuality = this.options.quality || 'ORIGINAL';
    const imageServer = this.options.imageServer || 'normal';
    const tabId = this.options.tabId;
    const slug = this.options.slug;
    const chapterBranchOverrides = this.options.chapterBranchOverrides || {};
    const translatorPriority = this.options.translatorPriority || [];

    // Если выбрано "Без картинок", пропускаем мангу
    if (imageQuality === 'NONE') {
      for (let i = 0; i < chapters.length; i++) {
        chapters[i].htmlContent = '<div class="manga-placeholder">[Картинки пропущены]</div>';
      }
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

      addLog('[' + (i + 1) + '/' + chapters.length + '] ОБРАБОТКА: ' + ch.displayTitle + '...');

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

      // Загружаем страницы главы через loadMangaChapterPages
      let pagesResult;
      let shouldRetry = false;

      do {
        shouldRetry = false;
        try {
          pagesResult = await this.loadMangaChapterPages(tabId, chapterId, ch.volume, ch.number, slug, imageServer, branchId, selectedTranslatorName);

          if (!pagesResult.success) {
            addLog('Ошибка загрузки страниц: ' + (pagesResult.error || 'Неизвестная ошибка'), true);
            ch.htmlContent = '<div class="manga-placeholder">[Не удалось загрузить главу]</div>';
            chapterImagesFailed++;
            totalImagesFailed++;
            continue;
          }

          if (!pagesResult.pages || pagesResult.pages.length === 0) {
            addLog('В главе нет картинок', true);
            ch.htmlContent = '<div class="manga-placeholder">[В главе нет картинок]</div>';
            continue;
          }

          // Генерируем HTML для манги
          let mangaHtml = '<div class="manga-chapter">';
          let chapterImageIndex = 0;

          for (const page of pagesResult.pages) {
            const imgUrl = page.url || page; // Обработка если это объект или строка
            try {
              const imageResult = await this.downloadAndResizeImage(imgUrl, imageQuality, this.options.imageFormat, 'картинка манги');
              if (imageResult && imageResult.blob) {
                const extension = this.getImageExtension(imageResult.blob, this.options.imageFormat, imgUrl);
                const fileName = this.generatePageFilename(ch, chapterImageIndex, extension);
                this.zip.file(fileName, imageResult.blob);
                chapterImageIndex++;

                // Добавляем тег img с data-zip-path
                mangaHtml += '<img data-zip-path="' + fileName + '" alt="Страница ' + (chapterImageIndex) + '" loading="lazy" />';
                chapterImagesDownloaded++;
                totalImagesDownloaded++;
              }
            } catch (error) {
              console.error('Ошибка загрузки картинки манги:', error);
              mangaHtml += '<div class="image-placeholder">[Не удалось загрузить картинку]</div>';
              chapterImagesFailed++;
              totalImagesFailed++;
            }
          }

          mangaHtml += '</div>';
          ch.htmlContent = mangaHtml;

        } catch (error) {
          console.error('Ошибка загрузки главы манги:', error);
          addLog('Ошибка загрузки главы: ' + error.message, true);
          ch.htmlContent = '<div class="manga-placeholder">[Не удалось загрузить главу]</div>';
          chapterImagesFailed++;
          totalImagesFailed++;
        }
      } while (shouldRetry);
    }

    return { downloaded: totalImagesDownloaded, failed: totalImagesFailed };
  }

  generatePageFilename(chapter, pageIndex, extension) {
    const chapterNum = chapter.number || '0';

    let chapterWhole, chapterFraction;
    if (String(chapterNum).includes('.')) {
      const parts = String(chapterNum).split('.');
      chapterWhole = parts[0];
      chapterFraction = parts[1] || '0';
      chapterFraction = chapterFraction.substring(0, 2);
    } else {
      chapterWhole = chapterNum;
      chapterFraction = '0';
    }

    chapterWhole = String(chapterWhole).padStart(4, '0');
    chapterFraction = String(chapterFraction).padStart(2, '0');
    const pageNum = String(pageIndex).padStart(3, '0');

    return `ch${chapterWhole}_${chapterFraction}_${pageNum}${extension}`;
  }

  buildAttachmentMap(attachments) {
    const attachmentMap = {};
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        // Поддержка нового формата с UUID
        if (att.id && att.url) {
          attachmentMap[att.id] = {
            url: att.url.startsWith('http') ? att.url : `https://ranobelib.me${att.url}`,
            extension: att.extension || 'jpg'
          };
        }
        // Поддержка старого формата с name
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
    if (!attachments || !Array.isArray(attachments) || attachments.length === 0) return null;
    return attachments[0].mangaId || null;
  }

  async blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async blobToBase64Pure(blob) {
    const dataUrl = await this.blobToBase64(blob);
    return dataUrl.split(',')[1];
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
        return doc.body.innerHTML;
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
            } else if (context.addToZip) {
              const imgExtension = this.getImageExtension(blob, imageFormat, src);
              const zipPath = context.addToZip(blob, imgExtension);
              img.setAttribute('data-zip-path', zipPath);
              img.setAttribute('src', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
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
      const caption = this.escapeXml(node.attrs?.description);
      const captionHtml = caption ? `<p class="image-caption">${caption}</p>` : '';

      if (this.options.quality === 'NONE') {
        return `${captionHtml}<span class="image-placeholder">[Картинка пропущена]</span>`;
      }

      const imagesData = node.attrs?.images;

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
                  imagesHtml += `<img src="images/${imgId}" alt="${caption || 'Иллюстрация'}" />`;
                } else if (context.addToZip) {
                  const zipPath = context.addToZip(blob, imgExtension);
                  imagesHtml += `<img data-zip-path="${zipPath}" alt="${caption || 'Иллюстрация'}" />`;
                } else {
                  const reader = new FileReader();
                  const base64 = await new Promise(r => {
                    reader.onloadend = () => r(reader.result);
                    reader.readAsDataURL(blob);
                  });
                  imagesHtml += `<img src="${base64}" alt="${caption || 'Иллюстрация'}" />`;
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
                imagesHtml += `<img src="images/${imgId}" alt="${caption || 'Иллюстрация'}" />`;
              } else if (context.addToZip) {
                const zipPath = context.addToZip(blob, imgExtension);
                imagesHtml += `<img data-zip-path="${zipPath}" alt="${caption || 'Иллюстрация'}" />`;
              } else {
                const reader = new FileReader();
                const base64 = await new Promise(r => {
                  reader.onloadend = () => r(reader.result);
                  reader.readAsDataURL(blob);
                });
                imagesHtml += `<img src="${base64}" alt="${caption || 'Иллюстрация'}" />`;
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
        const captionHtml = caption ? `<p class="image-caption">${caption}</p>` : '';
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
              const captionHtml = caption ? `<p class="image-caption">${caption}</p>` : '';
              onImageDownloaded();
              return `${captionHtml}<img src="images/${imgId}" alt="${caption || 'Иллюстрация'}" />`;
            } else if (context.addToZip) {
              const zipPath = context.addToZip(blob, imgExtension);
              const captionHtml = caption ? `<p class="image-caption">${caption}</p>` : '';
              onImageDownloaded();
              return `${captionHtml}<img data-zip-path="${zipPath}" alt="${caption || 'Иллюстрация'}" />`;
            } else {
              const reader = new FileReader();
              const base64 = await new Promise(r => {
                reader.onloadend = () => r(reader.result);
                reader.readAsDataURL(blob);
              });
              const captionHtml = caption ? `<p class="image-caption">${caption}</p>` : '';
              onImageDownloaded();
              return `${captionHtml}<img src="${base64}" alt="${caption || 'Иллюстрация'}" />`;
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
        try {
          const imageResult = await this.downloadAndResizeImage(imgUrl, this.options.quality, imageFormat, 'картинка');
          const blob = imageResult.blob;
          const getNextImageNumber = context.getNextImageNumber || (() => `img_${Math.random().toString(36).substr(2, 9)}`);
          const imgExtension = this.getImageExtension(blob, imageFormat, imgUrl);
          const imgId = `${getNextImageNumber()}${imgExtension}`;
          if (imagesFolder) {
            imagesFolder.file(imgId, blob);
            const captionHtml = caption ? `<p class="image-caption">${caption}</p>` : '';
            onImageDownloaded();
            return `${captionHtml}<img src="images/${imgId}" alt="${caption || 'Иллюстрация'}" />`;
          } else if (context.addToZip) {
            const zipPath = context.addToZip(blob, imgExtension);
            const captionHtml = caption ? `<p class="image-caption">${caption}</p>` : '';
            onImageDownloaded();
            return `${captionHtml}<img data-zip-path="${zipPath}" alt="${caption || 'Иллюстрация'}" />`;
          } else {
            const reader = new FileReader();
            const base64 = await new Promise(r => {
              reader.onloadend = () => r(reader.result);
              reader.readAsDataURL(blob);
            });
            const captionHtml = caption ? `<p class="image-caption">${caption}</p>` : '';
            onImageDownloaded();
            return `${captionHtml}<img src="${base64}" alt="${caption || 'Иллюстрация'}" />`;
          }
        } catch (e) {
          if (this.options.addLog) {
            this.options.addLog(`Error loading image ${imgUrl}: ${e.message}`, true);
          }
          if (this.options.incrementErrorCount) {
            this.options.incrementErrorCount();
          }
          onImageFailed();
          return '<span class="image-placeholder">[Не удалось загрузить картинку]</span>';
        }
      }

      return captionHtml + '<span class="image-placeholder">[Нет URL картинки]</span>';
    }

    if (node.type === 'bulletList') {
      const items = node.content || [];
      let html = '<ul>';
      for (const item of items) {
        html += await this.convertJsonToHtml(item, imagesFolder, context);
      }
      html += '</ul>';
      return html;
    }

    if (node.type === 'orderedList') {
      const items = node.content || [];
      let html = '<ol>';
      for (const item of items) {
        html += await this.convertJsonToHtml(item, imagesFolder, context);
      }
      html += '</ol>';
      return html;
    }

    if (node.type === 'listItem') {
      const content = await this.convertJsonToHtml(node.content, imagesFolder, context) || '';
      return `<li>${content}</li>`;
    }

    if (node.type === 'blockquote') {
      const content = await this.convertJsonToHtml(node.content, imagesFolder, context) || '';
      return `<blockquote>${content}</blockquote>`;
    }

    if (node.type === 'codeBlock') {
      const code = node.content?.[0]?.text || '';
      return `<pre><code>${code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`;
    }

    if (node.type === 'code') {
      const code = node.text || '';
      return `<code>${code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`;
    }

    return '';
  }

  async generateHTML(chapters, metadata, coversStats, imagesZipBase64) {
    const toc = this.generateToc(chapters);
    const content = await this.generateContent(chapters, metadata, coversStats);
    const jsCode = this.generateJavaScript(chapters, imagesZipBase64, metadata, this.options.siteType);
    const cssCode = this.generateCSS();

    return '<!DOCTYPE html>\n<html lang="ru">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>' + this.escapeXml(metadata.titleRu || 'Книга') + '</title>\n  <script src="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"></script>\n  <script src="https://cdn.jsdelivr.net/npm/@popperjs/core@2.11.8/dist/umd/popper.min.js"></script>\n  <script src="https://cdn.jsdelivr.net/npm/tippy.js@6.3.7/dist/tippy-bundle.umd.min.js"></script>\n  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">\n  <style>\n' + cssCode + '\n  </style>\n</head>\n<body>\n' + content + '\n  <script>\n' + jsCode + '\n  </script>\n</body>\n</html>';
  }

  generateToc(chapters) {
    let toc = '';

    const volumes = {};
    chapters.forEach(ch => {
      const vol = ch.volume || 1;
      if (!volumes[vol]) {
        volumes[vol] = [];
      }
      volumes[vol].push(ch);
    });

    Object.keys(volumes).sort((a, b) => a - b).forEach(vol => {
      toc += '<div class="toc-volume"><div class="toc-volume-title">Том ' + vol + '</div><ul class="toc-chapters">';
      volumes[vol].forEach(ch => {
        const title = this.escapeXml(ch.displayTitle || 'Глава ' + ch.number);
        toc += '<li><a href="#ch-' + ch.volume + '-' + ch.number + '" data-chapter="' + ch.volume + '-' + ch.number + '">' + title + '</a></li>';
      });
      toc += '</ul></div>';
    });

    return toc;
  }

  async generateContent(chapters, metadata, coversStats) {
    let content = '<div class="book-container">';

    // Плавающая панель управления в левом верхнем углу
    content += '<div class="floating-controls" id="floating-controls" data-position="top-left">';
    content += '<div class="panel-group info-group">';
    content += '<button class="btn-float" id="btn-settings" title="Настройки"><i class="fas fa-cog"></i></button>';
    content += '<button class="btn-float" id="btn-toc" title="Оглавление"><i class="fas fa-bars"></i></button>';
    content += '<button class="btn-float" id="btn-covers" title="Галерея обложек"><i class="fas fa-images"></i></button>';
    content += '<button class="btn-float" id="btn-info" title="Информация о произведении"><i class="fas fa-info-circle"></i></button>';
    content += '</div>';
    content += '<div class="divider"></div>';
    content += '<div class="panel-group nav-group">';
    content += '<button class="btn-float" id="btn-prev" title="Предыдущая глава"><i class="fas fa-chevron-left"></i></button>';
    content += '<span class="chapter-progress" id="chapter-progress">1/' + chapters.length + '</span>';
    content += '<button class="btn-float" id="btn-next" title="Следующая глава"><i class="fas fa-chevron-right"></i></button>';
    content += '</div>';
    content += '</div>';

    // Модальное окно оглавления
    content += '<div class="modal" id="toc-modal">';
    content += '<div class="modal-overlay" id="toc-modal-overlay"></div>';
    content += '<div class="modal-content">';
    content += '<div class="modal-header"><h3>Оглавление</h3><button class="btn-close-modal" id="btn-close-toc"><i class="fas fa-times"></i></button></div>';
    content += '<div class="modal-body" id="toc-content">' + this.generateToc(chapters) + '</div>';
    content += '</div></div>';

    // Модальное окно настроек
    content += '<div class="modal" id="settings-modal">';
    content += '<div class="modal-overlay" id="settings-modal-overlay"></div>';
    content += '<div class="modal-content">';
    content += '<div class="modal-header"><h3>Настройки</h3><button class="btn-close-modal" id="btn-close-settings"><i class="fas fa-times"></i></button></div>';
    content += '<div class="modal-body">';
    content += '<div class="setting-group"><label>Тема:</label><select id="theme">';
    content += '<option value="dark">Тёмная</option>';
    content += '<option value="light">Светлая</option>';
    content += '</select></div>';
    content += '<div class="setting-group"><label>Режим чтения:</label><select id="reading-mode">';
    content += '<option value="scroll">Скроллинг</option>';
    content += '<option value="page">Листание</option>';
    content += '</select></div>';
    content += '<div class="setting-group"><label>Положение панели:</label><select id="panel-position">';
    content += '<option value="top-left">Верхний левый угол</option>';
    content += '<option value="top-right">Верхний правый угол</option>';
    content += '<option value="bottom-left">Нижний левый угол</option>';
    content += '<option value="bottom-right">Нижний правый угол</option>';
    content += '</select></div>';
    content += '<div class="setting-group"><label>Выравнивание текста:</label><select id="text-align">';
    content += '<option value="justify">По ширине</option>';
    content += '<option value="left">По левому краю</option>';
    content += '</select></div>';
    content += '<div class="setting-group"><label>Шрифт:</label><select id="font-family">';
    content += '<option value="system-ui">System UI</option>';
    content += '<option value="Arial">Arial</option>';
    content += '<option value="Georgia">Georgia</option>';
    content += '<option value="Times New Roman">Times New Roman</option>';
    content += '<option value="Courier New">Courier New</option>';
    content += '</select></div>';
    content += '<div class="setting-group"><label>Размер шрифта:</label><input type="range" id="font-size" min="8" max="32" value="16"><span id="font-size-value">16px</span></div>';
    content += '<div class="setting-group"><label>Ширина контейнера:</label><input type="range" id="container-width" min="10" max="100" value="80"><span id="container-width-value">80%</span></div>';
    content += '</div>';
    content += '</div></div>';

    // Модальное окно галереи обложек
    content += '<div class="modal" id="covers-modal">';
    content += '<div class="modal-overlay" id="covers-modal-overlay"></div>';
    content += '<div class="modal-content">';
    content += '<div class="modal-header"><h3>Галерея обложек</h3><button class="btn-close-modal" id="btn-close-covers"><i class="fas fa-times"></i></button></div>';
    content += '<div class="modal-body" id="covers-gallery">' + this.generateCoversGalleryHTML(coversStats) + '</div>';
    content += '</div></div>';

    // Модальное окно информации о произведении
    content += '<div class="modal" id="info-modal">';
    content += '<div class="modal-overlay" id="info-modal-overlay"></div>';
    content += '<div class="modal-content">';
    content += '<div class="modal-header"><h3>Информация о произведении</h3><button class="btn-close-modal" id="btn-close-info"><i class="fas fa-times"></i></button></div>';
    content += '<div class="modal-body" id="info-content">' + this.generateMetadataHTML(metadata, coversStats) + '</div>';
    content += '</div></div>';

    // Контент книги
    content += '<div class="content-wrapper">';

    // Заголовок книги (внутри content-wrapper)
    const title = this.escapeXml(metadata.titleRu || metadata.titleEn || metadata.titleOriginal || 'No title');
    const author = this.escapeXml(metadata.author);

    content += '<div class="book-header" id="book-header">';
    if (author) {
      content += '<div class="book-author">' + author + '</div>';
    }
    content += '<div class="book-title">' + title + '</div>';
    content += '</div>';

    // Главы (первая глава теперь index 0)
    for (const chapter of chapters) {
      const title = this.escapeXml(chapter.displayTitle || 'Глава ' + chapter.number);
      const index = chapters.indexOf(chapter);
      const isFirstChapter = index === 0 ? ' first-chapter' : '';
      content += '<div class="chapter' + isFirstChapter + '" id="ch-' + chapter.volume + '-' + chapter.number + '" data-chapter-index="' + index + '">';
      content += '<h3 class="chapter-title">' + title + '</h3>';

      if (chapter.htmlContent) {
        content += chapter.htmlContent;
      }

      content += '</div>';
    }

    content += '</div>';
    content += '</div>';

    return content;
  }

  generateMetadataHTML(metadata, coversStats) {
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
      'description': { label: fieldLabels['description'] || defaultFieldLabels['description'], value: metadata.description, format: v => v.replace(/\n/g, '<br/>') }
    };

    const fieldOrder = this.options.metadataFieldOrder || Object.keys(fieldMapping);

    let html = '';

    // Обложки
    if (coversStats.downloaded > 0 && coversStats.coverFiles && coversStats.coverFiles.length > 0) {
      html += '<div class="cover-gallery">';
      coversStats.coverFiles.forEach(function(coverFile) {
        html += '<img data-zip-path="' + coverFile + '" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="Обложка">';
      });
      html += '</div>';
    }

    // Метаданные
    html += '<div class="metadata-table">';
    fieldOrder.forEach(fieldId => {
      const field = fieldMapping[fieldId];
      if (field && field.value) {
        const value = this.escapeXml(field.value);
        const formattedValue = field.format ? field.format(value) : value;
        html += '<div class="metadata-row"><span class="metadata-label"><strong>' + this.escapeXml(field.label) + ':</strong> </span><span class="metadata-value">' + formattedValue + '</span></div>';
      }
    });
    html += '</div>';

    return html;
  }

  generateCoversGalleryHTML(coversStats) {
    let html = '';
    if (coversStats.downloaded > 0 && coversStats.coverFiles && coversStats.coverFiles.length > 0) {
      html += '<div class="covers-gallery">';
      coversStats.coverFiles.forEach(function(coverFile) {
        html += '<img data-zip-path="' + coverFile + '" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="Обложка" />';
      });
      html += '</div>';
    } else {
      html += '<p>Обложки не загружены</p>';
    }
    return html;
  }

  generateCSS() {
    return `
      * { box-sizing: border-box; margin: 0; padding: 0; }

      :root {
        --bg-primary: #1a1a1a;
        --bg-secondary: #2a2a2a;
        --bg-tertiary: #3a3a3a;
        --text-primary: #e0e0e0;
        --text-secondary: #a0a0a0;
        --border-color: #444;
        --border-hover: #555;
        --accent-color: #ff6b6b;
        --accent-hover: #ff5252;
        --accent-soft: rgba(255, 107, 107, 0.1);
        --accent-text-color: #fff;
        --success-color: #4CAF50;
        --danger-color: #f44336;
        --font-size-sm: 12px;
        --font-size-md: 14px;
        --font-size-lg: 16px;
        --font-size-xl: 18px;
        --spacing-xs: 4px;
        --spacing-sm: 8px;
        --spacing-md: 12px;
        --spacing-lg: 16px;
        --spacing-xl: 24px;
        --border-radius: 4px;
      }

      body {
        font-family: system-ui, -apple-system, sans-serif;
        line-height: 1.6;
        background-color: var(--bg-primary);
        color: var(--text-primary);
      }

      body.light-theme {
        --bg-primary: #ffffff;
        --bg-secondary: #f5f5f5;
        --bg-tertiary: #e0e0e0;
        --text-primary: #333333;
        --text-secondary: #666666;
        --border-color: #ddd;
        --border-hover: #ccc;
      }

      /* Кастомный скроллбар как в расширении */
      ::-webkit-scrollbar {
        width: 6px;
        height: 6px;
      }

      ::-webkit-scrollbar-track {
        background: var(--bg-secondary);
        border-radius: 3px;
      }

      ::-webkit-scrollbar-thumb {
        background: var(--border-color);
        border-radius: 3px;
        border: 1px solid var(--bg-secondary);
      }

      ::-webkit-scrollbar-thumb:hover {
        background: var(--border-hover);
      }

      ::-webkit-scrollbar-corner {
        background: transparent;
      }

      .book-container {
        position: relative;
        min-height: 100vh;
      }

      /* Плавающая панель управления */
      .floating-controls {
        position: fixed;
        top: 20px;
        left: 20px;
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        background-color: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: var(--border-radius);
        padding: var(--spacing-sm);
        z-index: 1000;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        opacity: 1;
        transition: opacity 0.3s ease-in-out;
      }

      .floating-controls.inactive {
        opacity: 0.1;
      }

      .panel-group {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      /* Позиции панели */
      .floating-controls[data-position="top-left"] {
        top: 20px;
        left: 20px;
        flex-direction: row;
      }

      .floating-controls[data-position="top-right"] {
        top: 20px;
        right: 20px;
        left: auto;
        flex-direction: row-reverse;
      }

      .floating-controls[data-position="top-right"] .nav-group {
        flex-direction: row;
      }

      .floating-controls[data-position="top-right"] .info-group {
        flex-direction: row-reverse;
      }

      .floating-controls[data-position="bottom-left"] {
        bottom: 20px;
        left: 20px;
        top: auto;
        flex-direction: row;
      }

      .floating-controls[data-position="bottom-right"] {
        bottom: 20px;
        right: 20px;
        top: auto;
        left: auto;
        flex-direction: row-reverse;
      }

      .floating-controls[data-position="bottom-right"] .nav-group {
        flex-direction: row;
      }

      .floating-controls[data-position="bottom-right"] .info-group {
        flex-direction: row-reverse;
      }

      .btn-float {
        background-color: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        color: var(--text-primary);
        width: 32px;
        height: 32px;
        border-radius: var(--border-radius);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font-size: 14px;
      }

      .btn-float:hover {
        background-color: var(--bg-secondary);
        border-color: var(--border-hover);
      }

      .divider {
        width: 1px;
        height: 20px;
        background-color: var(--border-color);
      }

      .chapter-progress {
        font-size: var(--font-size-sm);
        font-weight: bold;
        color: var(--text-primary);
        padding: 0 var(--spacing-xs);
      }

      .book-header {
        text-align: center;
        padding: 40px 20px 40px;
        border-bottom: 1px solid var(--border-color);
        margin-bottom: 2em;
      }

      .book-author {
        font-size: 1.2em;
        color: var(--text-secondary);
        margin-bottom: var(--spacing-sm);
      }

      .book-title {
        font-size: 1.8em;
        font-weight: bold;
        color: var(--text-primary);
      }

      /* Скрываем заголовок в режиме листания */
      .content-wrapper.page-mode .book-header {
        display: none;
      }

      .content-wrapper {
        padding: 20px;
        max-width: 80%;
        margin: 0 auto;
      }

      .content-wrapper.page-mode {
        padding: 20px;
      }

      .content-wrapper.page-mode .chapter {
        display: none;
      }

      .content-wrapper.page-mode .chapter.active {
        display: block;
      }

      /* Стили для оглавления в модальном окне */
      .toc-volume-title {
        font-weight: bold;
        margin-bottom: var(--spacing-sm);
        color: var(--text-primary);
      }

      .toc-chapters {
        list-style-type: none;
        padding-left: var(--spacing-lg);
      }

      .toc-chapters li {
        margin: var(--spacing-xs) 0;
      }

      .toc-chapters a {
        text-decoration: none;
        color: var(--text-primary);
        display: block;
        padding: var(--spacing-xs);
        border-radius: var(--border-radius);
      }

      .toc-chapters a:hover {
        background-color: var(--bg-tertiary);
      }

      /* Стили для настроек в модальном окне */
      .setting-group {
        margin-bottom: var(--spacing-lg);
      }

      .setting-group label {
        display: block;
        margin-bottom: var(--spacing-xs);
        font-weight: bold;
        color: var(--text-primary);
      }

      .setting-group select,
      .setting-group input[type="range"],
      .setting-group input[type="color"] {
        width: 100%;
        padding: var(--spacing-xs);
        background-color: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: var(--border-radius);
        color: var(--text-primary);
      }

      .setting-group {
        margin-bottom: var(--spacing-lg);
      }

      .setting-group label {
        display: block;
        margin-bottom: var(--spacing-xs);
        font-weight: bold;
        color: var(--text-primary);
      }

      .setting-group select,
      .setting-group input[type="range"],
      .setting-group input[type="color"] {
        width: 100%;
        padding: var(--spacing-xs);
        background-color: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: var(--border-radius);
        color: var(--text-primary);
      }

      .chapter {
        margin-top: 2em;
        padding-top: 1em;
        border-top: none;
      }

      /* Границы между главами только в режиме скроллинга */
      .content-wrapper:not(.page-mode) .chapter:not(.first-chapter) {
        border-top: 1px solid var(--border-color);
      }

      .chapter-title {
        font-size: 1.5em;
        font-weight: bold;
        margin-bottom: 1em;
        color: var(--text-primary);
      }

      p {
        margin: 1em 0;
        color: var(--text-primary);
      }

      img {
        max-width: 100%;
        height: auto;
        display: block;
        margin: 1em auto;
        border-radius: var(--border-radius);
        min-height: 200px;
        background-color: var(--bg-tertiary);
        aspect-ratio: auto;
      }

      /* Картинки с data-zip-path - для lazy loading */
      img[data-zip-path] {
        opacity: 0;
        transition: opacity 1.2s ease-in-out;
      }

      img[data-zip-path].loaded {
        opacity: 1;
      }

      .image-placeholder {
        color: var(--text-secondary);
        font-style: italic;
      }

      .metadata-table {
        margin: 2em 0;
      }

      .metadata-row {
        display: flex;
        margin-bottom: 0.5em;
        padding: 0.5em;
        border-bottom: 1px solid var(--border-color);
      }

      .metadata-label {
        min-width: 200px;
        font-weight: bold;
        color: var(--text-primary);
      }

      .metadata-value {
        flex: 1;
        color: var(--text-primary);
      }

      .covers-gallery {
        display: flex;
        gap: var(--spacing-md);
        flex-wrap: wrap;
        justify-content: center;
        margin: 2em 0;
      }

      .covers-gallery img {
        max-width: 200px;
        height: auto;
        border-radius: var(--border-radius);
        cursor: pointer;
        transition: transform 0.2s ease;
      }

      .covers-gallery img:hover {
        transform: scale(1.05);
      }

      .modal {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 2000;
        display: none;
      }

      .modal.open {
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: rgba(0, 0, 0, 0.8);
        z-index: 2001;
      }

      .modal-content {
        background-color: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: var(--border-radius);
        max-width: 800px;
        max-height: 80vh;
        width: 90%;
        overflow-y: auto;
        z-index: 2002;
        position: relative;
      }

      .modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: var(--spacing-md) var(--spacing-lg);
        border-bottom: 1px solid var(--border-color);
      }

      .modal-header h3 {
        margin: 0;
        font-size: var(--font-size-lg);
        color: var(--text-primary);
      }

      .btn-close-modal {
        background: none;
        border: none;
        color: var(--text-secondary);
        cursor: pointer;
        padding: 4px;
        border-radius: var(--border-radius);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
      }

      .btn-close-modal:hover {
        background-color: var(--bg-tertiary);
        color: var(--text-primary);
      }

      .modal-body {
        padding: var(--spacing-lg);
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.8; }
      }
    `;
  }

  generateJavaScript(chapters, imagesZipBase64, metadata, siteType) {
    const metadataJSON = JSON.stringify(metadata || {});
    const siteTypeSafe = siteType || 'ranobe';

    return `
      (function() {
        const chapters = document.querySelectorAll('.chapter');
        const totalChapters = chapters.length;
        let currentChapterIndex = 0;
        let readingMode = 'scroll';
        let zip = null;
        let isNavigating = false; // Флаг для блокировки обновления счётчика при скролле
        const imageUrls = new Map();
        const unloadTimers = new Map();
        const imageAspectRatios = new Map();
        let panelInactivityTimer = null; // Таймер для прозрачности панели

        // Инициализация siteType
        const siteType = '${siteTypeSafe}';
        document.documentElement.setAttribute('data-site', siteType);

        // Загрузка images.zip из Base64
        async function loadImagesZip() {
          try {
            const zipData = atob('${imagesZipBase64}');
            const zipUint8Array = new Uint8Array(zipData.length);
            for (let i = 0; i < zipData.length; i++) {
              zipUint8Array[i] = zipData.charCodeAt(i);
            }
            zip = await JSZip.loadAsync(zipUint8Array);
            loadImagesFromZip();
          } catch (error) {
            console.error('Ошибка загрузки images.zip:', error);
          }
        }

        // Lazy Loading картинок из ZIP с очисткой памяти
        function loadImagesFromZip() {
          const images = document.querySelectorAll('img[data-zip-path]');

          const observer = new IntersectionObserver(function(entries) {
            entries.forEach(function(entry) {
              const img = entry.target;
              const zipPath = img.getAttribute('data-zip-path');

              if (entry.isIntersecting) {
                if (unloadTimers.has(zipPath)) {
                  clearTimeout(unloadTimers.get(zipPath));
                  unloadTimers.delete(zipPath);
                }
                loadSingleImage(img, zipPath);
              } else {
                if (unloadTimers.has(zipPath)) {
                  clearTimeout(unloadTimers.get(zipPath));
                }
                const timer = setTimeout(function() {
                  if (img.src && imageUrls.has(zipPath)) {
                    URL.revokeObjectURL(imageUrls.get(zipPath));
                    imageUrls.delete(zipPath);
                    img.src = '';
                    img.classList.remove('loaded');
                  }
                  unloadTimers.delete(zipPath);
                }, 5000);
                unloadTimers.set(zipPath, timer);
              }
            });
          }, { rootMargin: '3000px' });

          images.forEach(function(img) {
            observer.observe(img);
          });
        }

        // Загрузка одной картинки из ZIP
        async function loadSingleImage(img, zipPath) {
          try {
            if (!zip) return;

            if (imageAspectRatios.has(zipPath)) {
              img.style.aspectRatio = imageAspectRatios.get(zipPath);
            }

            if (imageUrls.has(zipPath)) {
              URL.revokeObjectURL(imageUrls.get(zipPath));
            }

            const file = await zip.file(zipPath).async('blob');
            const url = URL.createObjectURL(file);
            imageUrls.set(zipPath, url);
            img.src = url;

            img.onload = function() {
              img.classList.add('loaded');
              const aspectRatio = img.naturalWidth / img.naturalHeight;
              imageAspectRatios.set(zipPath, aspectRatio);
              img.style.aspectRatio = aspectRatio;
            };
          } catch (error) {
            console.error('Ошибка загрузки картинки ' + zipPath + ':', error);
            img.outerHTML = '<span class="image-placeholder">[Не удалось загрузить картинку]</span>';
          }
        }

        // Загрузка настроек из localStorage
        function loadSettings() {
          const fontFamily = localStorage.getItem('html-font-family') || 'system-ui';
          const fontSize = localStorage.getItem('html-font-size') || '16';
          const containerWidth = localStorage.getItem('html-container-width') || '80';
          const theme = localStorage.getItem('html-theme') || 'dark';
          const lastChapter = localStorage.getItem('html-last-chapter') || '0';
          readingMode = localStorage.getItem('html-reading-mode') || 'scroll';
          const textAlign = localStorage.getItem('html-text-align') || 'justify';
          const panelPosition = localStorage.getItem('html-panel-position') || 'top-left';

          document.getElementById('font-family').value = fontFamily;
          document.getElementById('font-size').value = fontSize;
          document.getElementById('font-size-value').textContent = fontSize + 'px';
          document.getElementById('container-width').value = containerWidth;
          document.getElementById('container-width-value').textContent = containerWidth + '%';
          document.getElementById('theme').value = theme;
          document.getElementById('reading-mode').value = readingMode;
          document.getElementById('text-align').value = textAlign;
          document.getElementById('panel-position').value = panelPosition;

          applySettings();
          currentChapterIndex = parseInt(lastChapter);

          if (readingMode === 'page') {
            showChapter(currentChapterIndex);
          } else {
            scrollToChapter(currentChapterIndex);
          }
        }

        // Применение настроек
        function applySettings() {
          const oldReadingMode = readingMode;
          const fontFamily = document.getElementById('font-family').value;
          const fontSize = document.getElementById('font-size').value;
          const containerWidth = document.getElementById('container-width').value;
          const theme = document.getElementById('theme').value;
          readingMode = document.getElementById('reading-mode').value;
          const textAlign = document.getElementById('text-align').value;
          const panelPosition = document.getElementById('panel-position').value;

          // Применяем шрифт только к контенту и заголовку
          const contentWrapper = document.querySelector('.content-wrapper');
          const bookHeader = document.querySelector('.book-header');
          const floatingControls = document.getElementById('floating-controls');
          contentWrapper.style.fontFamily = fontFamily;
          contentWrapper.style.fontSize = fontSize + 'px';
          contentWrapper.style.textAlign = textAlign;
          if (bookHeader) {
            bookHeader.style.fontFamily = fontFamily;
            bookHeader.style.fontSize = fontSize + 'px';
          }
          contentWrapper.style.maxWidth = containerWidth + '%';

          // Применяем положение панели
          if (floatingControls) {
            floatingControls.setAttribute('data-position', panelPosition);
          }

          // Моментальная смена темы без анимации
          if (theme === 'dark') {
            document.body.classList.remove('light-theme');
          } else {
            document.body.classList.add('light-theme');
          }

          if (readingMode === 'page') {
            document.querySelector('.content-wrapper').classList.add('page-mode');
            if (oldReadingMode !== 'page') {
              showChapter(currentChapterIndex);
            }
          } else {
            document.querySelector('.content-wrapper').classList.remove('page-mode');
            if (oldReadingMode === 'page') {
              scrollToChapter(currentChapterIndex);
            }
          }

          localStorage.setItem('html-font-family', fontFamily);
          localStorage.setItem('html-font-size', fontSize);
          localStorage.setItem('html-container-width', containerWidth);
          localStorage.setItem('html-theme', theme);
          localStorage.setItem('html-reading-mode', readingMode);
          localStorage.setItem('html-text-align', textAlign);
          localStorage.setItem('html-panel-position', panelPosition);
        }

        // Скролл к главе
        function scrollToChapter(index) {
          if (index >= 0 && index < totalChapters) {
            chapters[index].scrollIntoView({ behavior: 'smooth' });
            updateProgress();
            localStorage.setItem('html-last-chapter', index);
          }
        }

        // Показать главу (режим листания)
        function showChapter(index) {
          if (index >= 0 && index < totalChapters) {
            chapters.forEach(function(ch) {
              ch.classList.remove('active');
            });
            chapters[index].classList.add('active');
            currentChapterIndex = index;
            updateProgress();
            localStorage.setItem('html-last-chapter', index);
            window.scrollTo(0, 0);

            // Показываем/скрываем заголовок в зависимости от текущей главы
            const bookHeader = document.getElementById('book-header');
            if (bookHeader) {
              if (index === 0) {
                bookHeader.style.display = 'block';
              } else {
                bookHeader.style.display = 'none';
              }
            }

            const chaptersToLoad = [];
            chaptersToLoad.push(index);
            if (index > 0) chaptersToLoad.push(index - 1);
            if (index < totalChapters - 1) chaptersToLoad.push(index + 1);

            chaptersToLoad.forEach(function(chapterIndex) {
              const chapter = chapters[chapterIndex];
              const images = chapter.querySelectorAll('img[data-zip-path]');
              images.forEach(function(img) {
                const zipPath = img.getAttribute('data-zip-path');
                loadSingleImage(img, zipPath);
              });
            });
          }
        }

        // Обновление прогресса
        function updateProgress() {
          document.getElementById('chapter-progress').textContent = (currentChapterIndex + 1) + '/' + totalChapters;
        }

        // Предыдущая глава
        function prevChapter() {
          if (currentChapterIndex > 0) {
            currentChapterIndex--;
            isNavigating = true;
            updateProgress();
            setTimeout(function() { isNavigating = false; }, 500);
            if (readingMode === 'page') {
              showChapter(currentChapterIndex);
            } else {
              scrollToChapter(currentChapterIndex);
            }
          }
        }

        // Следующая глава
        function nextChapter() {
          if (currentChapterIndex < totalChapters - 1) {
            currentChapterIndex++;
            isNavigating = true;
            updateProgress();
            setTimeout(function() { isNavigating = false; }, 500);
            if (readingMode === 'page') {
              showChapter(currentChapterIndex);
            } else {
              scrollToChapter(currentChapterIndex);
            }
          }
        }

        // Отслеживание скролла для текущей главы (режим скроллинга)
        function handleScroll() {
          if (readingMode === 'scroll' && !isNavigating) {
            const chapterElements = document.querySelectorAll('.chapter');
            chapterElements.forEach(function(chapter, index) {
              const rect = chapter.getBoundingClientRect();
              if (rect.top <= 100 && rect.bottom >= 100) {
                if (currentChapterIndex !== index) {
                  currentChapterIndex = index;
                  updateProgress();
                  localStorage.setItem('html-last-chapter', index);
                }
              }
            });
          }
        }

        // Открытие галереи обложек
        function openCoversModal() {
          const modal = document.getElementById('covers-modal');
          const gallery = document.getElementById('covers-gallery');
          modal.classList.add('open');

          // Инициализируем tippy для каждой обложки
          gallery.querySelectorAll('img').forEach(function(img) {
            tippy(img, {
              content: img.alt || 'Обложка',
              theme: document.body.classList.contains('light-theme') ? 'light' : 'dark',
              placement: 'bottom'
            });
          });
        }

        // Открытие информации о произведении
        function openInfoModal() {
          document.getElementById('info-modal').classList.add('open');
        }

        // Кнопки навигации
        document.getElementById('btn-prev').addEventListener('click', prevChapter);
        document.getElementById('btn-next').addEventListener('click', nextChapter);

        // Открытие оглавления
        document.getElementById('btn-toc').addEventListener('click', function() {
          document.getElementById('toc-modal').classList.add('open');
        });

        // Закрытие оглавления
        document.getElementById('btn-close-toc').addEventListener('click', function() {
          document.getElementById('toc-modal').classList.remove('open');
        });

        document.getElementById('toc-modal-overlay').addEventListener('click', function() {
          document.getElementById('toc-modal').classList.remove('open');
        });

        // Открытие галереи обложек
        document.getElementById('btn-covers').addEventListener('click', openCoversModal);

        // Закрытие галереи обложек
        document.getElementById('btn-close-covers').addEventListener('click', function() {
          document.getElementById('covers-modal').classList.remove('open');
        });

        document.getElementById('covers-modal-overlay').addEventListener('click', function() {
          document.getElementById('covers-modal').classList.remove('open');
        });

        // Открытие информации о произведении
        document.getElementById('btn-info').addEventListener('click', openInfoModal);

        // Закрытие информации о произведении
        document.getElementById('btn-close-info').addEventListener('click', function() {
          document.getElementById('info-modal').classList.remove('open');
        });

        document.getElementById('info-modal-overlay').addEventListener('click', function() {
          document.getElementById('info-modal').classList.remove('open');
        });

        // Открытие настроек
        document.getElementById('btn-settings').addEventListener('click', function() {
          document.getElementById('settings-modal').classList.add('open');
        });

        // Закрытие настроек
        document.getElementById('btn-close-settings').addEventListener('click', function() {
          document.getElementById('settings-modal').classList.remove('open');
        });

        document.getElementById('settings-modal-overlay').addEventListener('click', function() {
          document.getElementById('settings-modal').classList.remove('open');
        });

        // Клик по оглавлению
        document.querySelectorAll('#toc-content a').forEach(function(link) {
          link.addEventListener('click', function(e) {
            e.preventDefault();
            const chapterId = this.getAttribute('href').substring(1);
            const chapterElement = document.getElementById(chapterId);
            if (chapterElement) {
              const index = parseInt(chapterElement.getAttribute('data-chapter-index'));
              currentChapterIndex = index;
              if (readingMode === 'page') {
                showChapter(index);
              } else {
                scrollToChapter(index);
              }
              document.getElementById('toc-modal').classList.remove('open');
            }
          });
        });

        // Изменение настроек
        document.getElementById('font-family').addEventListener('change', applySettings);
        document.getElementById('font-size').addEventListener('input', function() {
          document.getElementById('font-size-value').textContent = this.value + 'px';
          applySettings();
        });
        document.getElementById('container-width').addEventListener('input', function() {
          document.getElementById('container-width-value').textContent = this.value + '%';
          applySettings();
        });
        document.getElementById('theme').addEventListener('change', applySettings);
        document.getElementById('reading-mode').addEventListener('change', applySettings);
        document.getElementById('panel-position').addEventListener('change', applySettings);
        document.getElementById('text-align').addEventListener('change', applySettings);

        // Скролл
        window.addEventListener('scroll', handleScroll);

        // Логика прозрачности панели
        function resetPanelInactivity() {
          const panel = document.getElementById('floating-controls');
          if (panel) {
            panel.classList.remove('inactive');
            if (panelInactivityTimer) {
              clearTimeout(panelInactivityTimer);
            }
            panelInactivityTimer = setTimeout(function() {
              panel.classList.add('inactive');
            }, 10000); // 10 секунд неактивности
          }
        }

        // Инициализация отслеживания активности панели
        document.getElementById('floating-controls').addEventListener('mouseenter', resetPanelInactivity);
        document.getElementById('floating-controls').addEventListener('mouseleave', resetPanelInactivity);
        resetPanelInactivity();

        // Инициализация
        loadImagesZip();
        loadSettings();
      })();
    `;
  }
}
