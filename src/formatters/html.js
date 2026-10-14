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
    console.log('Images ZIP blob сгенерирован, размер:', imagesZipBlob.size);

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
            const getNextImageNumber = context.getNextImageNumber || (() => `img_${Math.random().toString(36).substr(2, 9)}`);
            const imageResult = await this.downloadAndResizeImage(src, this.options.quality, imageFormat, 'картинка');
            if (imagesFolder && imageResult && imageResult.blob) {
              const blob = imageResult.blob;
              const imageFormat = this.options.imageFormat || 'original';
              const imgExtension = this.getImageExtension(blob, imageFormat, src);
              const imgId = `${getNextImageNumber()}${imgExtension}`;
              imagesFolder.file(imgId, blob);
              img.setAttribute('src', `images/${imgId}`);
            } else if (context.addToZip && imageResult && imageResult.blob) {
              const blob = imageResult.blob;
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
                } else if (context.addToZip) {
                  const zipPath = context.addToZip(blob, imgExtension);
                  imagesHtml += `<img data-zip-path="${zipPath}" alt="${captionEscaped || 'Иллюстрация'}" />`;
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
    const jsCode = this.generateJavaScript(chapters, imagesZipBase64);
    const cssCode = this.generateCSS();

    return '<!DOCTYPE html>\n<html lang="ru">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>' + (metadata.titleRu || 'Книга') + '</title>\n  <script src="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"></script>\n  <style>\n' + cssCode + '\n  </style>\n</head>\n<body>\n' + content + '\n  <script>\n' + jsCode + '\n  </script>\n</body>\n</html>';
  }

  generateToc(chapters) {
    let toc = '<ul class="toc-chapters">';
    toc += '<li><a href="#info-page" data-chapter="info">Информация о произведении</a></li>';
    toc += '</ul>';

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
        const title = ch.displayTitle || 'Глава ' + ch.number;
        toc += '<li><a href="#ch-' + ch.volume + '-' + ch.number + '" data-chapter="' + ch.volume + '-' + ch.number + '">' + title + '</a></li>';
      });
      toc += '</ul></div>';
    });

    return toc;
  }

  async generateContent(chapters, metadata, coversStats) {
    let content = '<div class="book-container">';

    // Панель инструментов
    content += '<div class="toolbar" id="toolbar">';
    content += '<button class="btn-toc" id="btn-toc" title="Оглавление"><i class="icon-toc">☰</i></button>';
    content += '<div class="nav-buttons" id="nav-buttons-top">';
    content += '<button class="btn-nav" id="btn-prev" title="Предыдущая глава">←</button>';
    content += '<span class="chapter-progress" id="chapter-progress">1/' + (chapters.length + 1) + '</span>';
    content += '<button class="btn-nav" id="btn-next" title="Следующая глава">→</button>';
    content += '</div>';
    content += '<button class="btn-settings" id="btn-settings" title="Настройки">⚙</button>';
    content += '</div>';

    // Нижняя панель навигации (только для режима листания)
    content += '<div class="bottom-nav" id="bottom-nav" style="display: none;">';
    content += '<div class="nav-buttons">';
    content += '<button class="btn-nav" id="btn-prev-bottom" title="Предыдущая глава">←</button>';
    content += '<span class="chapter-progress" id="chapter-progress-bottom">1/' + (chapters.length + 1) + '</span>';
    content += '<button class="btn-nav" id="btn-next-bottom" title="Следующая глава">→</button>';
    content += '</div>';
    content += '</div>';

    // Боковая панель оглавления
    content += '<div class="sidebar" id="sidebar">';
    content += '<div class="sidebar-header"><h3>Оглавление</h3><button class="btn-close-sidebar" id="btn-close-sidebar">×</button></div>';
    content += '<div class="sidebar-content" id="sidebar-content">' + this.generateToc(chapters) + '</div>';
    content += '</div>';

    // Панель настроек
    content += '<div class="settings-panel" id="settings-panel">';
    content += '<div class="settings-header"><h3>Настройки</h3><button class="btn-close-settings" id="btn-close-settings">×</button></div>';
    content += '<div class="settings-content">';
    content += '<div class="setting-group"><label>Шрифт:</label><select id="font-family">';
    content += '<option value="system-ui">System UI</option>';
    content += '<option value="Arial">Arial</option>';
    content += '<option value="Georgia">Georgia</option>';
    content += '<option value="Times New Roman">Times New Roman</option>';
    content += '<option value="Courier New">Courier New</option>';
    content += '</select></div>';
    content += '<div class="setting-group"><label>Размер шрифта:</label><input type="range" id="font-size" min="8" max="32" value="16"><span id="font-size-value">16px</span></div>';
    content += '<div class="setting-group"><label>Ширина контейнера:</label><input type="range" id="container-width" min="10" max="100" value="80"><span id="container-width-value">80%</span></div>';
    content += '<div class="setting-group"><label>Тема:</label><select id="theme">';
    content += '<option value="dark">Тёмная</option>';
    content += '<option value="light">Светлая</option>';
    content += '</select></div>';
    content += '<div class="setting-group"><label>Режим чтения:</label><select id="reading-mode">';
    content += '<option value="scroll">Скроллинг</option>';
    content += '<option value="page">Листание</option>';
    content += '</select></div>';
    content += '</div>';
    content += '</div>';

    // Контент книги
    content += '<div class="content-wrapper">';

    // Страница с информацией о произведении (первая "глава")
    content += '<div class="chapter info-page" id="info-page" data-chapter-index="0">';
    content += '<h3 class="chapter-title">Информация о произведении</h3>';
    content += this.generateMetadataHTML(metadata, coversStats);
    content += '</div>';

    // Главы
    for (const chapter of chapters) {
      const title = chapter.displayTitle || 'Глава ' + chapter.number;
      const index = chapters.indexOf(chapter) + 1; // +1 потому что info-page это индекс 0
      content += '<div class="chapter" id="ch-' + chapter.volume + '-' + chapter.number + '" data-chapter-index="' + index + '">';
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
    fieldOrder.forEach(function(fieldId) {
      const field = fieldMapping[fieldId];
      if (field && field.value) {
        const formattedValue = field.format ? field.format(field.value) : field.value;
        html += '<div class="metadata-row"><span class="metadata-label"><strong>' + field.label + ':</strong> </span><span class="metadata-value">' + formattedValue + '</span></div>';
      }
    });
    html += '</div>';

    return html;
  }

  generateCSS() {
    return `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: system-ui, -apple-system, sans-serif;
        line-height: 1.6;
        background-color: #fff;
        color: #333;
        transition: background-color 0.3s, color 0.3s;
      }
      body.dark-theme {
        background-color: #1a1a1a;
        color: #e0e0e0;
      }
      .book-container {
        position: relative;
        min-height: 100vh;
      }
      .toolbar {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: 50px;
        background-color: #f5f5f5;
        border-bottom: 1px solid #ddd;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 20px;
        z-index: 1000;
        transition: transform 0.3s;
      }
      .toolbar.hidden {
        transform: translateY(-100%);
      }
      body.dark-theme .toolbar {
        background-color: #2a2a2a;
        border-bottom-color: #444;
      }
      .btn-toc, .btn-settings {
        width: 40px;
        height: 40px;
        border: none;
        background-color: #fff;
        border-radius: 4px;
        cursor: pointer;
        font-size: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      body.dark-theme .btn-toc, body.dark-theme .btn-settings {
        background-color: #3a3a3a;
        color: #e0e0e0;
      }
      .nav-buttons {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .bottom-nav {
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        height: 50px;
        background-color: #f5f5f5;
        border-top: 1px solid #ddd;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }
      body.dark-theme .bottom-nav {
        background-color: #2a2a2a;
        border-top-color: #444;
      }
      .content-wrapper.page-mode {
        padding: 70px 20px 70px;
      }
      .content-wrapper.page-mode .chapter {
        display: none;
      }
      .content-wrapper.page-mode .chapter.active {
        display: block;
      }
      .btn-nav {
        width: 40px;
        height: 40px;
        border: none;
        background-color: #fff;
        border-radius: 4px;
        cursor: pointer;
        font-size: 18px;
      }
      body.dark-theme .btn-nav {
        background-color: #3a3a3a;
        color: #e0e0e0;
      }
      .chapter-progress {
        font-size: 14px;
        font-weight: bold;
      }
      .sidebar {
        position: fixed;
        top: 50px;
        left: -300px;
        width: 300px;
        height: calc(100vh - 50px);
        background-color: #f5f5f5;
        border-right: 1px solid #ddd;
        transition: left 0.3s;
        z-index: 999;
        overflow-y: auto;
      }
      body.dark-theme .sidebar {
        background-color: #2a2a2a;
        border-right-color: #444;
      }
      .sidebar.open {
        left: 0;
      }
      .sidebar-header {
        padding: 15px;
        border-bottom: 1px solid #ddd;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      body.dark-theme .sidebar-header {
        border-bottom-color: #444;
      }
      .btn-close-sidebar {
        width: 30px;
        height: 30px;
        border: none;
        background-color: transparent;
        font-size: 20px;
        cursor: pointer;
      }
      .sidebar-content {
        padding: 15px;
      }
      .toc-volume-title {
        font-weight: bold;
        margin-bottom: 10px;
      }
      .toc-chapters {
        list-style-type: none;
        padding-left: 20px;
      }
      .toc-chapters li {
        margin: 5px 0;
      }
      .toc-chapters a {
        text-decoration: none;
        color: #333;
      }
      body.dark-theme .toc-chapters a {
        color: #e0e0e0;
      }
      .toc-chapters a:hover {
        text-decoration: underline;
      }
      .cover-gallery {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 20px;
        margin: 2em 0;
      }
      .cover-gallery img {
        max-width: 60%;
        height: auto;
        border-radius: 8px;
        box-shadow: 0 4px 8px rgba(0,0,0,0.1);
      }
      .metadata-table {
        margin: 2em 0;
      }
      .metadata-row {
        display: flex;
        margin-bottom: 0.5em;
        padding: 0.5em;
        border-bottom: 1px solid #eee;
      }
      body.dark-theme .metadata-row {
        border-bottom-color: #333;
      }
      .metadata-label {
        min-width: 200px;
        font-weight: bold;
      }
      .metadata-value {
        flex: 1;
      }
      .settings-panel {
        position: fixed;
        top: 50px;
        right: -300px;
        width: 300px;
        height: calc(100vh - 50px);
        background-color: #f5f5f5;
        border-left: 1px solid #ddd;
        transition: right 0.3s;
        z-index: 999;
        overflow-y: auto;
      }
      body.dark-theme .settings-panel {
        background-color: #2a2a2a;
        border-left-color: #444;
      }
      .settings-panel.open {
        right: 0;
      }
      .settings-header {
        padding: 15px;
        border-bottom: 1px solid #ddd;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      body.dark-theme .settings-header {
        border-bottom-color: #444;
      }
      .btn-close-settings {
        width: 30px;
        height: 30px;
        border: none;
        background-color: transparent;
        font-size: 20px;
        cursor: pointer;
      }
      .settings-content {
        padding: 15px;
      }
      .setting-group {
        margin-bottom: 20px;
      }
      .setting-group label {
        display: block;
        margin-bottom: 5px;
        font-weight: bold;
      }
      .setting-group select,
      .setting-group input[type="range"] {
        width: 100%;
        padding: 5px;
      }
      .content-wrapper {
        padding: 70px 20px 20px;
        max-width: 80%;
        margin: 0 auto;
      }
      .book-header {
        text-align: center;
        margin-bottom: 30px;
      }
      .book-header h1 {
        font-size: 2.2em;
        margin-bottom: 10px;
      }
      .book-header h2 {
        font-size: 1.5em;
        color: #666;
      }
      body.dark-theme .book-header h2 {
        color: #aaa;
      }
      .cover img {
        max-width: 60%;
        height: auto;
        display: block;
        margin: 20px auto;
        border-radius: 8px;
        box-shadow: 0 4px 8px rgba(0,0,0,0.1);
      }
      .summary {
        background-color: #f9f9f9;
        border-left: 4px solid #ccc;
        padding: 1em;
        margin: 2em 0;
        white-space: pre-wrap;
      }
      body.dark-theme .summary {
        background-color: #2a2a2a;
        border-left-color: #666;
      }
      .chapter {
        margin-top: 2em;
        padding-top: 1em;
        border-top: 1px solid #ddd;
      }
      body.dark-theme .chapter {
        border-top-color: #444;
      }
      .chapter-title {
        font-size: 1.5em;
        font-weight: bold;
        margin-bottom: 1em;
      }
      p {
        margin: 1em 0;
      }
      img {
        max-width: 100%;
        height: auto;
        display: block;
        margin: 1em auto;
        border-radius: 4px;
      }
      .image-placeholder {
        color: #666;
        font-style: italic;
      }
      body.dark-theme .image-placeholder {
        color: #999;
      }
    `;
  }

  generateJavaScript(chapters, imagesZipBase64) {
    return `
      (function() {
        const chapters = document.querySelectorAll('.chapter');
        const totalChapters = chapters.length;
        let currentChapterIndex = 0;
        let readingMode = 'scroll';
        let lastScrollY = 0;
        let zip = null;

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

        // Lazy Loading картинок из ZIP
        function loadImagesFromZip() {
          const images = document.querySelectorAll('img[data-zip-path]');
          const observer = new IntersectionObserver(function(entries) {
            entries.forEach(function(entry) {
              if (entry.isIntersecting) {
                const img = entry.target;
                const zipPath = img.getAttribute('data-zip-path');
                loadSingleImage(img, zipPath);
                observer.unobserve(img);
              }
            });
          }, { rootMargin: '100px' });

          images.forEach(function(img) {
            observer.observe(img);
          });
        }

        // Загрузка одной картинки из ZIP
        async function loadSingleImage(img, zipPath) {
          try {
            if (!zip) return;
            const file = await zip.file(zipPath).async('blob');
            const url = URL.createObjectURL(file);
            img.src = url;
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

          document.getElementById('font-family').value = fontFamily;
          document.getElementById('font-size').value = fontSize;
          document.getElementById('font-size-value').textContent = fontSize + 'px';
          document.getElementById('container-width').value = containerWidth;
          document.getElementById('container-width-value').textContent = containerWidth + '%';
          document.getElementById('theme').value = theme;
          document.getElementById('reading-mode').value = readingMode;

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
          const fontFamily = document.getElementById('font-family').value;
          const fontSize = document.getElementById('font-size').value;
          const containerWidth = document.getElementById('container-width').value;
          const theme = document.getElementById('theme').value;
          readingMode = document.getElementById('reading-mode').value;

          document.body.style.fontFamily = fontFamily;
          document.body.style.fontSize = fontSize + 'px';
          document.querySelector('.content-wrapper').style.maxWidth = containerWidth + '%';

          if (theme === 'dark') {
            document.body.classList.add('dark-theme');
          } else {
            document.body.classList.remove('dark-theme');
          }

          // Режим чтения
          if (readingMode === 'page') {
            document.querySelector('.content-wrapper').classList.add('page-mode');
            document.getElementById('bottom-nav').style.display = 'flex';
            document.getElementById('nav-buttons-top').style.display = 'flex';
          } else {
            document.querySelector('.content-wrapper').classList.remove('page-mode');
            document.getElementById('bottom-nav').style.display = 'none';
            document.getElementById('nav-buttons-top').style.display = 'flex';
          }

          // Сохранение в localStorage
          localStorage.setItem('html-font-family', fontFamily);
          localStorage.setItem('html-font-size', fontSize);
          localStorage.setItem('html-container-width', containerWidth);
          localStorage.setItem('html-theme', theme);
          localStorage.setItem('html-reading-mode', readingMode);
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
          }
        }

        // Обновление прогресса
        function updateProgress() {
          document.getElementById('chapter-progress').textContent = (currentChapterIndex + 1) + '/' + totalChapters;
          document.getElementById('chapter-progress-bottom').textContent = (currentChapterIndex + 1) + '/' + totalChapters;
        }

        // Предыдущая глава
        function prevChapter() {
          if (currentChapterIndex > 0) {
            currentChapterIndex--;
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
            if (readingMode === 'page') {
              showChapter(currentChapterIndex);
            } else {
              scrollToChapter(currentChapterIndex);
            }
          }
        }

        // Отслеживание скролла для текущей главы (режим скроллинга)
        function handleScroll() {
          if (readingMode === 'scroll') {
            const scrollY = window.scrollY;

            // Показать/скрыть панель инструментов
            if (scrollY > lastScrollY && scrollY > 100) {
              document.getElementById('toolbar').classList.add('hidden');
            } else {
              document.getElementById('toolbar').classList.remove('hidden');
            }
            lastScrollY = scrollY;

            // Определить текущую главу
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

        // Кнопки навигации (верх)
        document.getElementById('btn-prev').addEventListener('click', prevChapter);
        document.getElementById('btn-next').addEventListener('click', nextChapter);

        // Кнопки навигации (низ)
        document.getElementById('btn-prev-bottom').addEventListener('click', prevChapter);
        document.getElementById('btn-next-bottom').addEventListener('click', nextChapter);

        // Открытие оглавления
        document.getElementById('btn-toc').addEventListener('click', function() {
          document.getElementById('sidebar').classList.toggle('open');
        });

        // Закрытие оглавления
        document.getElementById('btn-close-sidebar').addEventListener('click', function() {
          document.getElementById('sidebar').classList.remove('open');
        });

        // Открытие настроек
        document.getElementById('btn-settings').addEventListener('click', function() {
          document.getElementById('settings-panel').classList.toggle('open');
        });

        // Закрытие настроек
        document.getElementById('btn-close-settings').addEventListener('click', function() {
          document.getElementById('settings-panel').classList.remove('open');
        });

        // Клик по оглавлению (включая info-page)
        document.querySelectorAll('.sidebar-content a').forEach(function(link) {
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
              document.getElementById('sidebar').classList.remove('open');
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

        // Скролл
        window.addEventListener('scroll', handleScroll);

        // Инициализация
        loadImagesZip();
        loadSettings();
      })();
    `;
  }
}
