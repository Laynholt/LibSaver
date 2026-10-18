// formats.js - форматы файла по типу сайта ('manga' | 'ranobe' | 'anime') и ключ storage, где запоминается выбор.
// Одно место для окна поверх сайта, быстрого окошка «Скачать» и кнопок на сайте (подпись формата).

const FORMAT_OPTIONS = {
  ranobe: [
    { value: 'epub', label: 'EPUB' },
    { value: 'fb2', label: 'FB2' },
    { value: 'pdf', label: 'PDF' },
    { value: 'txt', label: 'TXT' },
    { value: 'html', label: 'HTML' }
  ],
  manga: [
    { value: 'cbz', label: 'CBZ' },
    { value: 'zip', label: 'ZIP' },
    { value: 'pdf', label: 'PDF' },
    { value: 'epub', label: 'EPUB' },
    { value: 'html', label: 'HTML' }
  ],
  anime: [
    { value: 'mkv', label: 'MKV' }
  ]
};

// Неизвестный тип - как ранобе (так было всегда)
function formatOptionsFor(siteType) {
  return FORMAT_OPTIONS[siteType] || FORMAT_OPTIONS.ranobe;
}

function defaultFormatFor(siteType) {
  return siteType === 'manga' ? 'cbz' : (siteType === 'anime' ? 'mkv' : 'epub');
}

function formatKeyFor(siteType) {
  return siteType === 'manga' ? 'selectedFormat_manga' : 'selectedFormat_ranobe';
}
