// chapter-range.js - работа со списком глав тайтла: переводчики, уникальные главы, подписи и диапазон.
// Только данные, без DOM: нужен popup, кнопкам на сайте и панели на странице.

function getTranslatorKey(branch) {
  const branchId = branch.branch_id === null ? 'null' : branch.branch_id;
  let teamId = 'unknown';
  if (branch.teams && branch.teams[0]) {
    teamId = branch.teams[0].id;
  } else if (branch.team) {
    teamId = branch.team.id;
  }
  return `${branchId}_${teamId}`;
}

function getTranslatorName(branch) {
  if (branch.teams && branch.teams[0]) {
    const teamName = branch.teams[0].name;
    // Если команда "Неизвестный", но есть пользователь, добавляем никнейм в скобках
    if (teamName === 'Неизвестный' && branch.user?.username) {
      return `${teamName} (${branch.user.username})`;
    }
    return teamName;
  } else if (branch.team) {
    const teamName = branch.team.name;
    if (teamName === 'Неизвестный' && branch.user?.username) {
      return `${teamName} (${branch.user.username})`;
    }
    return teamName;
  }
  return branch.user?.username || 'Основной перевод';
}

function getChapterVariants(chapters, chapterId) {
  const variants = new Map();
  chapters.forEach(ch => {
    if (ch.id === chapterId && ch.branches && Array.isArray(ch.branches)) {
      ch.branches.forEach(branch => {
        const key = getTranslatorKey(branch);
        const name = getTranslatorName(branch);
        variants.set(key, name);
      });
    }
  });
  return variants;
}

function getUniqueChapters(chapters) {
  const uniqueChapterIds = new Set();
  const uniqueChapters = [];

  chapters.forEach(ch => {
    if (!uniqueChapterIds.has(ch.id)) {
      uniqueChapterIds.add(ch.id);
      uniqueChapters.push(ch);
    }
  });

  return uniqueChapters;
}

// Выбирает перевод для каждой главы: меняет chapters и chapterBranchOverrides на месте.
// Пустой translatorPriority строится по числу глав у переводчика; возвращает применённый приоритет.
function applyTranslatorPriority(chapters, translatorPriority, chapterBranchOverrides) {
  if (translatorPriority.length === 0) {
    const translatorCounts = {};
    chapters.forEach(ch => {
      if (ch.branches && Array.isArray(ch.branches)) {
        ch.branches.forEach(branch => {
          const key = getTranslatorKey(branch);
          if (!translatorCounts[key]) {
            translatorCounts[key] = 0;
          }
          translatorCounts[key]++;
        });
      }
    });

    translatorPriority = Object.keys(translatorCounts).sort((a, b) => translatorCounts[b] - translatorCounts[a]);
  }

  const uniqueChapters = getUniqueChapters(chapters);

  uniqueChapters.forEach(ch => {
    const variants = getChapterVariants(chapters, ch.id);
    if (variants.size > 1) {
      for (const translatorKey of translatorPriority) {
        if (variants.has(translatorKey)) {
          chapterBranchOverrides[ch.id] = translatorKey;
          break;
        }
      }
    }
  });

  chapters.forEach(ch => {
    if (chapterBranchOverrides[ch.id]) {
      const targetKey = chapterBranchOverrides[ch.id];
      if (ch.branches && Array.isArray(ch.branches)) {
        const targetBranch = ch.branches.find(branch => getTranslatorKey(branch) === targetKey);
        if (targetBranch) {
          if (targetBranch.teams && targetBranch.teams.length > 0) {
            ch.branchTeamName = targetBranch.teams.map(t => t.name).join(' & ');
          } else if (targetBranch.user?.username) {
            ch.branchTeamName = targetBranch.user.username;
          }
          ch.branchId = targetBranch.branch_id !== null ? String(targetBranch.branch_id) : null;
        }
      }
    }
  });

  return translatorPriority;
}

// «Том X. Глава Y. Название»; без названия - «Том X. Глава Y»
function chapterLabel(ch) {
  const label = `Том ${ch.volume}. Глава ${ch.number}`;
  return ch.name ? `${label}. ${ch.name}` : label;
}

// id глав между двумя индексами включительно; порядок индексов не важен
function rangeChapterIds(chapters, fromIdx, toIdx) {
  return chapters.slice(Math.min(fromIdx, toIdx), Math.max(fromIdx, toIdx) + 1).map(ch => ch.id);
}

// «До» не меньше «От» (как в popup): подтягиваем второй край, когда двигают первый
function syncRange(fromIdx, toIdx, changed) {
  if (changed === 'from' && toIdx < fromIdx) return [fromIdx, fromIdx];
  if (changed === 'to' && fromIdx > toIdx) return [toIdx, toIdx];
  return [fromIdx, toIdx];
}

// Записывает выбор глав в тайтл: снимок берёт главы из filteredChapters (по всем веткам перевода), а панель и «Подготовка» читают selectedChapterIds.
// Один набор id в обоих полях: устаревший selectedChapterIds не должен перебить новый диапазон
function applySelectionToTitle(title, allChapters, selectedIds) {
  const chosen = new Set(selectedIds);
  title.selectedChapterIds = Array.from(chosen);
  title.filteredChapters = allChapters.filter(chapter => chosen.has(chapter.id));
}
