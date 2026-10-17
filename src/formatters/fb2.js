class Fb2Formatter extends BaseFormatter {
  constructor(options) {
    super(options);
    this.images = []; // Храним Base64 картинки
    this.imageCounter = 0;
  }

  getExtension() {
    return 'fb2';
  }

  getMimeType() {
    return 'application/fb2+zip';
  }

  htmlToFb2(node) {
    if (!node) return '';
    
    // Text node
    if (node.nodeType === Node.TEXT_NODE) {
      return this.escapeXml(node.textContent || '');
    }
    
    // Element node
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tagName = node.tagName.toLowerCase();
      let result = '';
      
      // Handle different HTML elements
      switch (tagName) {
        case 'p':
        case 'div':
          // Обёртка с абзацами внутри (глава старого формата целиком в <div>): FB2 не допускает <p> в <p>,
          // поэтому блоки выводим как есть, а голый текст между ними собираем в отдельные <p>
          if ([...node.children].some(child => ['P', 'DIV'].includes(child.tagName.toUpperCase()))) {
            let inline = '';
            const flush = () => {
              if (inline.trim()) result += `<p>${inline}</p>`;
              inline = '';
            };
            for (const child of node.childNodes) {
              if (child.nodeType === Node.ELEMENT_NODE && ['P', 'DIV'].includes(child.tagName.toUpperCase())) {
                flush();
                result += this.htmlToFb2(child);
              } else {
                inline += this.htmlToFb2(child);
              }
            }
            flush();
            break;
          }
          const align =node.getAttribute('text-align') || node.getAttribute('align') || node.style?.textAlign || '';
          const alignAttr = align ? ` text-align="${align}"` : '';
          let content = '';
          for (const child of node.childNodes) {
            content += this.htmlToFb2(child);
          }
          result = `<p${alignAttr}>${content}</p>`;
          break;
          
        case 'strong':
        case 'b':
          let strongContent = '';
          for (const child of node.childNodes) {
            strongContent += this.htmlToFb2(child);
          }
          result = `<strong>${strongContent}</strong>`;
          break;
          
        case 'em':
        case 'i':
          let emContent = '';
          for (const child of node.childNodes) {
            emContent += this.htmlToFb2(child);
          }
          result = `<emphasis>${emContent}</emphasis>`;
          break;
          
        case 'u':
          let uContent = '';
          for (const child of node.childNodes) {
            uContent += this.htmlToFb2(child);
          }
          result = `<emphasis>${uContent}</emphasis>`;
          break;
          
        case 's':
        case 'strike':
        case 'del':
          let strikeContent = '';
          for (const child of node.childNodes) {
            strikeContent += this.htmlToFb2(child);
          }
          result = `<strikethrough>${strikeContent}</strikethrough>`;
          break;
          
        case 'br':
          result = '<empty-line/>';
          break;
          
        case 'hr':
          result = '<empty-line/>';
          break;
          
        case 'img':
          // Images are handled separately, but if we encounter one here, skip it
          result = '';
          break;

        case 'span':
          // Handle temporary span with fb2 image reference
          const imageRef = node.getAttribute('data-fb2-image-ref');
          if (imageRef) {
            result = `<image l:href="${imageRef}"/>`;
          } else {
            // Regular span, process children
            for (const child of node.childNodes) {
              result += this.htmlToFb2(child);
            }
          }
          break;
          
        default:
          // For unknown elements, just process children
          for (const child of node.childNodes) {
            result += this.htmlToFb2(child);
          }
          break;
      }
      
      return result;
    }
    
    return '';
  }

  async format(chapters, metadata) {
    const filteredChapters = this.filterChapters(chapters);

    if (!filteredChapters || filteredChapters.length === 0) {
      throw new Error('Нет глав для генерации FB2');
    }

    if (!metadata || !metadata.titleRu) {
      console.warn('Предупреждение: отсутствует название произведения в метаданных');
    }

    // Для обнаружения глав старого формата (только ранобэ)
    const siteType = this.options.siteType || 'ranobe';
    this.isRanobe = siteType === 'ranobe' || siteType === 'ranobelib';
    const addLog = this.options.addLog || (() => {});

    // Обрабатываем обложки
    const coverQuality = this.options.coverQuality || 'ORIGINAL';
    let coverImageId = null;
    
    if (coverQuality !== 'NONE') {
      const allCovers = this.options.allCovers || [metadata.cover || this.options.originalCover || ''];
      const firstCover = allCovers[0];

      if (firstCover) {
        // Если это объект с dataUrl (локальный файл), используем dataUrl
        const coverUrl = typeof firstCover === 'object' && firstCover.dataUrl
          ? firstCover.dataUrl
          : firstCover;

        const actualUrl = this.extractCoverUrl(coverUrl);
        if (actualUrl) {
          try {
            const blob = await this.downloadCoverWithFallback(actualUrl, coverQuality);
            const base64 = await this.blobToBase64(blob);
            coverImageId = `cover`;
            this.images.push({ id: coverImageId, data: base64, type: 'image/jpeg' });
            if (window.incrementTotalCovers) {
              window.incrementTotalCovers();
            }
          } catch (e) {
            if (this.options.addLog) {
              this.options.addLog(`Ошибка загрузки обложки: ${e.message}`, true);
            }
          }
        }
      }
    }

    let fb2Content = this.generateFb2Header(metadata, coverImageId);
    
    // Добавляем страницу с информацией
    fb2Content += this.generateInfoPage(metadata);
    
    // Добавляем страницу оглавления если не отключено
    const disableToc = this.options.disableToc || false;
    if (!disableToc) {
      fb2Content += this.generateTocPage(filteredChapters);
    }
    
    let totalImagesDownloaded = 0;
    let totalImagesFailed = 0;

    for (let i = 0; i < filteredChapters.length; i++) {
      const ch = filteredChapters[i];
      const chapterId = `chapter_${i}`;

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

      const attachmentMap = this.buildAttachmentMap(attachments);
      let mangaId = this.extractMangaId(attachments);

      const chapterXml = await this.convertJsonToFb2Xml(chapterContent, {
        mangaId: mangaId,
        chapterId: ch.id || '',
        attachmentMap: attachmentMap,
        attachments: attachments,
        onImageDownloaded: () => {
          totalImagesDownloaded++;
          if (window.incrementTotalImages) {
            window.incrementTotalImages();
          }
        },
        onImageFailed: () => { totalImagesFailed++; }
      });

      // Проверяем, что контент не пустой
      const noHeaders = this.options.settings?.tocFormat === 'no_headers';
      if (!chapterXml || chapterXml.trim() === '') {
        if (this.options.addLog) {
          this.options.addLog(`Предупреждение: Глава "${ch.displayTitle}" имеет пустой контент`, true);
        }
        // Добавляем пустую секцию с пометкой
        fb2Content += `<section id="${chapterId}"><title><p>${this.escapeXml(ch.displayTitle)}</p></title><p>[Контент главы отсутствует]</p></section>`;
      } else {
        // Если включен "Без заголовков" - убираем заголовок из <title>
        if (noHeaders) {
          fb2Content += `<section id="${chapterId}">${chapterXml}</section>`;
        } else {
          fb2Content += `<section id="${chapterId}"><title><p>${this.escapeXml(ch.displayTitle)}</p></title>${chapterXml}</section>`;
        }
      }

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
        this.options.addFileSize(fb2Content.length);
      }
    }

    // Добавляем картинки в конце
    fb2Content += this.generateBinarySection();

    fb2Content += `</body></FictionBook>`;

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
    if (window.setTotalCovers && coverImageId) {
      window.setTotalCovers(1);
    }
    if (window.setTotalImages) {
      window.setTotalImages(totalImagesDownloaded);
    }

    const blob = new Blob([fb2Content], { type: 'application/fb2+zip' });
    const fileName = this.generateFileName(metadata) + '.fb2';

    return { blob: blob, filename: fileName };
  }

  generateFb2Header(metadata, coverImageId) {
    const originalMetadata = this.options.originalMetadata || {};
    const titleRu = metadata.titleRu || originalMetadata.titleRu || originalMetadata.titleEn || originalMetadata.titleOriginal || 'Без названия';
    const author = metadata.author || '';
    const year = metadata.year || '';


    return `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
  <description>
    <title-info>
      <genre>fiction</genre>
      <author>
        <first-name>${this.escapeXml(author.split(' ')[0] || '')}</first-name>
        <last-name>${this.escapeXml(author.split(' ').slice(1).join(' ') || author)}</last-name>
      </author>
      <book-title>${this.escapeXml(titleRu)}</book-title>
      <lang>ru</lang>
      ${year ? `<date>${this.escapeXml(year)}</date>` : ''}
      ${coverImageId ? `<coverpage><image l:href="#${coverImageId}"/></coverpage>` : ''}
    </title-info>
  </description>
  <body>
`;
  }

  generateTocPage(chapters) {
    if (!chapters || chapters.length === 0) {
      return '';
    }

    const noHeaders = this.options.settings?.tocFormat === 'no_headers';
    // Если включен "Без заголовков" - не создаём оглавление
    if (noHeaders) {
      return '';
    }

    let tocContent = '<section><title><p>Оглавление</p></title>';

    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      const chapterId = `chapter_${i}`;
      tocContent += `<p><a l:href="#${chapterId}">${this.escapeXml(ch.displayTitle)}</a></p>`;
    }

    tocContent += '</section>';
    return tocContent;
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
    
    let infoContent = `<section><title><p>Информация о произведении</p></title>`;
    
    for (const fieldId of fieldOrder) {
      const field = fieldMapping[fieldId];
      if (field && field.value) {
        const formattedValue = field.format ? field.format(field.value) : field.value;
        infoContent += `<p><strong>${this.escapeXml(field.label)}:</strong> ${this.escapeXml(formattedValue)}</p>`;
      }
    }

    infoContent += '</section>';
    
    return infoContent;
  }

  generateBinarySection() {
    let binarySection = '';
    for (const img of this.images) {
      binarySection += `<binary id="${img.id}" content-type="${img.type}">${img.data}</binary>\n`;
    }
    return binarySection;
  }

  async convertJsonToFb2Xml(node, context = {}) {
    if (!node) return "";

    const imageQuality = this.options.quality || 'ORIGINAL';
    const disableImages = imageQuality === 'NONE';
    const onImageDownloaded = context.onImageDownloaded || (() => {});
    const onImageFailed = context.onImageFailed || (() => {});

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
      // Без картинок разметку всё равно переводим в FB2 ниже, а не экранируем: иначе в книге видны теги
      if (disableImages) this.replaceImagesWithPlaceholders(doc, false);

      // Convert HTML headings to paragraphs with strong formatting
      const headings = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');
      for (const h of headings) {
        const p = document.createElement('p');
        p.innerHTML = `<strong>${h.innerHTML}</strong>`;
        // Preserve alignment if present
        const align = h.getAttribute('align') || h.style?.textAlign || '';
        if (align) {
          p.setAttribute('text-align', align);
        }
        h.parentNode.replaceChild(p, h);
      }

      // Convert HTML elements to FB2 format
      const paragraphs = doc.querySelectorAll('p, div');
      for (const p of paragraphs) {
        const align = p.getAttribute('align') || p.style?.textAlign || '';
        if (align) {
          p.setAttribute('text-align', align);
        }
        // Remove data-* attributes
        Array.from(p.attributes).forEach(attr => {
          if (attr.name.startsWith('data-')) {
            p.removeAttribute(attr.name);
          }
        });
      }
      
      const images = doc.querySelectorAll('img');
      for (const img of images) {
        const src = img.getAttribute('src');
        if (src) {
          try {
            const imageResult = await this.downloadAndResizeImage(src, this.options.quality, this.options.imageFormat, 'картинка');
            const blob = imageResult.blob;
            const base64 = await this.blobToBase64(blob);
            const imgId = `img_${this.imageCounter++}`;
            // Определяем content-type из URL или blob
            let contentType = blob.type || 'image/jpeg';
            if (src.endsWith('.png')) contentType = 'image/png';
            else if (src.endsWith('.jpg') || src.endsWith('.jpeg')) contentType = 'image/jpeg';
            else if (src.endsWith('.gif')) contentType = 'image/gif';
            else if (src.endsWith('.webp')) contentType = 'image/webp';
            this.images.push({ id: imgId, data: base64, type: contentType });
            // Используем временный span с data-атрибутом, DOMParser его распознаёт
            img.outerHTML = `<span data-fb2-image-ref="#${imgId}"></span>`;
            onImageDownloaded();
          } catch (e) {
            if (this.options.addLog) {
              this.options.addLog(`Error loading image ${src}: ${e.message}`, true);
            }
            if (this.options.incrementErrorCount) {
              this.options.incrementErrorCount();
            }
            onImageFailed();
            img.outerHTML = '[Не удалось загрузить картинку]';
          }
        }
      }
      
      // Convert HTML to FB2 format manually
      let fb2Html = '';
      for (const child of doc.body.childNodes) {
        fb2Html += this.htmlToFb2(child);
      }
      return fb2Html;
    }

    if (Array.isArray(node)) {
      let xml = "";
      for (const item of node) xml += await this.convertJsonToFb2Xml(item, context);
      return xml;
    }

    if (node.type === 'doc') return await this.convertJsonToFb2Xml(node.content, context);
    
    if (node.type === 'heading') {
      const align = node.attrs?.textAlign || '';
      const alignAttr = align ? ` text-align="${align}"` : '';
      const content = await this.convertJsonToFb2Xml(node.content, context) || '';
      // Use <strong> for headings instead of <title> to avoid TOC entries
      return `<p${alignAttr}><strong>${content}</strong></p>`;
    }
    
    if (node.type === 'paragraph') {
      const align = node.attrs?.textAlign || '';
      const alignAttr = align ? ` text-align="${align}"` : '';
      const content = await this.convertJsonToFb2Xml(node.content, context) || '';
      return `<p${alignAttr}>${content}</p>`;
    }
    
    if (node.type === 'horizontalRule') return '<empty-line/>';
    
    if (node.type === 'hardBreak') return '<empty-line/>';
    
    if (node.type === 'text') {
      let text = node.text || "";
      text = this.escapeXml(text);
      if (node.marks) {
        node.marks.forEach(mark => {
          if (mark.type === 'italic') text = `<emphasis>${text}</emphasis>`;
          else if (mark.type === 'bold') text = `<strong>${text}</strong>`;
          else if (mark.type === 'underline') text = `<emphasis>${text}</emphasis>`;
          else if (mark.type === 'strike') text = `<strikethrough>${text}</strikethrough>`;
        });
      }
      return text;
    }

    if (node.type === 'image') {
      const caption = node.attrs?.description || '';

      if (this.options.quality === 'NONE') {
        return caption ? `<p>${this.escapeXml(caption)}</p>[Картинка пропущена]` : '[Картинка пропущена]';
      }

      const imagesData = node.attrs?.images;
      
      if (Array.isArray(imagesData) && imagesData.length > 0) {
        const attachmentMap = context.attachmentMap || {};
        
        let imagesXml = '';
        
        for (const img of imagesData) {
          const imgUrl = img?.image || img?.src || img?.url;
          
          if (!imgUrl) continue;

          if (!imgUrl.startsWith('http') && !imgUrl.startsWith('/') && !imgUrl.includes('.')) {
            // Это UUID, обрабатываем через attachmentMap
            const attachmentInfo = attachmentMap[imgUrl];
            if (attachmentInfo && attachmentInfo.url) {
              try {
                const imageResult = await this.downloadAndResizeImage(attachmentInfo.url, this.options.quality, this.options.imageFormat, 'картинка');
                const blob = imageResult.blob;
                const base64 = await this.blobToBase64(blob);
                const imgId = `img_${this.imageCounter++}`;
                // Определяем content-type из URL или blob
                let contentType = blob.type || 'image/jpeg';
                if (attachmentInfo.url.endsWith('.png')) contentType = 'image/png';
                else if (attachmentInfo.url.endsWith('.jpg') || attachmentInfo.url.endsWith('.jpeg')) contentType = 'image/jpeg';
                else if (attachmentInfo.url.endsWith('.gif')) contentType = 'image/gif';
                else if (attachmentInfo.url.endsWith('.webp')) contentType = 'image/webp';
                this.images.push({ id: imgId, data: base64, type: contentType });
                imagesXml += `<image l:href="#${imgId}"/>`;
                onImageDownloaded();
              } catch (e) {
                if (this.options.addLog) {
                  this.options.addLog(`Error loading UUID image ${attachmentInfo.url}: ${e.message}`, true);
                }
                if (this.options.incrementErrorCount) {
                  this.options.incrementErrorCount();
                }
                onImageFailed();
                imagesXml += '[Не удалось загрузить картинку]';
              }
            } else {
              imagesXml += '[Не удалось загрузить картинку]';
            }
          } else if (imgUrl.startsWith('http') || imgUrl.startsWith('/')) {
            // Это обычный URL, скачиваем напрямую
            try {
              const imageResult = await this.downloadAndResizeImage(imgUrl, this.options.quality, this.options.imageFormat, 'картинка');
              const blob = imageResult.blob;
              const base64 = await this.blobToBase64(blob);
              const imgId = `img_${this.imageCounter++}`;
              // Определяем content-type из URL или blob
              let contentType = blob.type || 'image/jpeg';
              if (imgUrl.endsWith('.png')) contentType = 'image/png';
              else if (imgUrl.endsWith('.jpg') || imgUrl.endsWith('.jpeg')) contentType = 'image/jpeg';
              else if (imgUrl.endsWith('.gif')) contentType = 'image/gif';
              else if (imgUrl.endsWith('.webp')) contentType = 'image/webp';
              this.images.push({ id: imgId, data: base64, type: contentType });
              imagesXml += `<image l:href="#${imgId}"/>`;
              onImageDownloaded();
            } catch (e) {
              if (this.options.addLog) {
                this.options.addLog(`Error loading URL image ${imgUrl}: ${e.message}`, true);
              }
              if (this.options.incrementErrorCount) {
                this.options.incrementErrorCount();
              }
              onImageFailed();
              imagesXml += '[Не удалось загрузить картинку]';
            }
          } else {
            try {
              const imageResult = await this.downloadAndResizeImage(imgUrl, this.options.quality, this.options.imageFormat, 'картинка');
              const blob = imageResult.blob;
              const base64 = await this.blobToBase64(blob);
              const imgId = `img_${this.imageCounter++}`;
              this.images.push({ id: imgId, data: base64, type: 'image/jpeg' });
              imagesXml += `<image l:href="#${imgId}"/>`;
              onImageDownloaded();
            } catch (e) {
              if (this.options.addLog) {
                this.options.addLog(`Error loading image ${imgUrl}: ${e.message}`, true);
              }
              if (this.options.incrementErrorCount) {
                this.options.incrementErrorCount();
              }
              onImageFailed();
              imagesXml += '[Не удалось загрузить картинку]';
            }
          }
        }
        
        return caption ? `<p>${this.escapeXml(caption)}</p>${imagesXml}` : imagesXml;
      }
      
      const imgData = node.attrs?.images?.[0] || node.attrs;
      let imgUrl = imgData?.src || imgData?.url || imgData?.image;
      
      if (imgUrl && !imgUrl.startsWith('http') && !imgUrl.startsWith('/') && !imgUrl.includes('.')) {
        // Это UUID, обрабатываем через attachmentMap
        const attachmentMap = context.attachmentMap || {};
        const attachmentInfo = attachmentMap[imgUrl];

        if (attachmentInfo && attachmentInfo.url) {
          try {
            const imageResult = await this.downloadAndResizeImage(attachmentInfo.url, this.options.quality, this.options.imageFormat, 'картинка');
            const blob = imageResult.blob;
            const base64 = await this.blobToBase64(blob);
            const imgId = `img_${this.imageCounter++}`;
            // Определяем content-type из URL или blob
            let contentType = blob.type || 'image/jpeg';
            if (attachmentInfo.url.endsWith('.png')) contentType = 'image/png';
            else if (attachmentInfo.url.endsWith('.jpg') || attachmentInfo.url.endsWith('.jpeg')) contentType = 'image/jpeg';
            else if (attachmentInfo.url.endsWith('.gif')) contentType = 'image/gif';
            else if (attachmentInfo.url.endsWith('.webp')) contentType = 'image/webp';
            this.images.push({ id: imgId, data: base64, type: contentType });
            onImageDownloaded();
            return caption ? `<p>${this.escapeXml(caption)}</p><image l:href="#${imgId}"/>` : `<image l:href="#${imgId}"/>`;
          } catch (e) {
            if (this.options.addLog) {
              this.options.addLog(`Error loading UUID image ${attachmentInfo.url}: ${e.message}`, true);
            }
            if (this.options.incrementErrorCount) {
              this.options.incrementErrorCount();
            }
            onImageFailed();
            return '[Не удалось загрузить картинку]';
          }
        } else {
          return '[Не удалось загрузить картинку]';
        }
      } else if (imgUrl && (imgUrl.startsWith('http') || imgUrl.startsWith('/'))) {
        // Это обычный URL, скачиваем напрямую
        try {
          const imageResult = await this.downloadAndResizeImage(imgUrl, this.options.quality, this.options.imageFormat, 'картинка');
          const blob = imageResult.blob;
          const base64 = await this.blobToBase64(blob);
          const imgId = `img_${this.imageCounter++}`;
          // Определяем content-type из URL или blob
          let contentType = blob.type || 'image/jpeg';
          if (imgUrl.endsWith('.png')) contentType = 'image/png';
          else if (imgUrl.endsWith('.jpg') || imgUrl.endsWith('.jpeg')) contentType = 'image/jpeg';
          else if (imgUrl.endsWith('.gif')) contentType = 'image/gif';
          else if (imgUrl.endsWith('.webp')) contentType = 'image/webp';
          this.images.push({ id: imgId, data: base64, type: contentType });
          onImageDownloaded();
          return caption ? `<p>${this.escapeXml(caption)}</p><image l:href="#${imgId}"/>` : `<image l:href="#${imgId}"/>`;
        } catch (e) {
          if (this.options.addLog) {
            this.options.addLog(`Error loading URL image ${imgUrl}: ${e.message}`, true);
          }
          if (this.options.incrementErrorCount) {
            this.options.incrementErrorCount();
          }
          onImageFailed();
          return '[Не удалось загрузить картинку]';
        }
      }
      
      if (imgUrl) {
        try {
          const imageResult = await this.downloadAndResizeImage(imgUrl, this.options.quality, null, 'картинка');
          const blob = imageResult.blob;
          const base64 = await this.blobToBase64(blob);
          const imgId = `img_${this.imageCounter++}`;
          this.images.push({ id: imgId, data: base64, type: 'image/jpeg' });
          onImageDownloaded();
          return caption ? `<p>${this.escapeXml(caption)}</p><image l:href="#${imgId}"/>` : `<image l:href="#${imgId}"/>`;
        } catch (e) {
          if (this.options.addLog) {
            this.options.addLog(`Error loading image ${imgUrl}: ${e.message}`, true);
          }
          if (this.options.incrementErrorCount) {
            this.options.incrementErrorCount();
          }
          onImageFailed();
          return '[Не удалось загрузить картинку]';
        }
      } else {
        return '[Не удалось загрузить картинку]';
      }
    }

    if (node.content) return await this.convertJsonToFb2Xml(node.content, context);
    return "";
  }

  async blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}
