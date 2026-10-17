// Данные тайтлов хранятся по ключу на тайтл ("titleData:<slug>", "originalTitleData:<slug>"):
// popup и редакторы читают только свой тайтл, а не все сохранённые тайтлы вместе с base64-обложками.
// Для вызывающего кода форма прежняя: { titleData: { [slug]: ... }, originalTitleData: { [slug]: ... } }.
const TITLE_STORE_KINDS = ['titleData', 'originalTitleData'];

function titleStoreKey(kind, slug) {
  return `${kind}:${slug}`;
}

// Разносит объект { titleData: { slug: data } } по отдельным ключам; остальные ключи пишутся как есть
function splitTitleStore(items) {
  const out = {};
  for (const [key, value] of Object.entries(items)) {
    if (TITLE_STORE_KINDS.includes(key)) {
      for (const [slug, data] of Object.entries(value || {})) {
        out[titleStoreKey(key, slug)] = data;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

// Старые версии держали все тайтлы в одном объекте: переносим их по ключам один раз
async function migrateTitleStore(legacy) {
  const kinds = TITLE_STORE_KINDS.filter(kind => legacy[kind]);
  if (kinds.length === 0) return;
  const migrated = splitTitleStore(Object.fromEntries(kinds.map(kind => [kind, legacy[kind]])));
  // Ключи, уже записанные новой версией, свежее legacy-копии
  const existing = await chrome.storage.local.get(Object.keys(migrated));
  for (const key of Object.keys(existing)) delete migrated[key];
  await chrome.storage.local.set(migrated);
  await chrome.storage.local.remove(kinds);
}

// Аналог chrome.storage.local.get(keys): titleData/originalTitleData возвращаются только для slug
// (по умолчанию — currentSlug из ?slug= адреса страницы, если он есть, иначе сохранённый currentSlug)
async function getTitleStore(keys, slug) {
  const plainKeys = keys.filter(key => !TITLE_STORE_KINDS.includes(key));
  const kinds = keys.filter(key => TITLE_STORE_KINDS.includes(key));
  const base = await chrome.storage.local.get([...new Set([...plainKeys, 'currentSlug', ...TITLE_STORE_KINDS])]);
  await migrateTitleStore(base);
  const urlSlug = typeof location === 'undefined' ? null : /[?&]slug=([^&#]+)/.exec(location.search || '')?.[1];
  if (urlSlug) base.currentSlug = decodeURIComponent(urlSlug);

  const result = {};
  for (const key of plainKeys) {
    if (key in base) result[key] = base[key];
  }
  const titleSlug = slug ?? base.currentSlug;
  if (kinds.length > 0) {
    const stored = titleSlug ? await chrome.storage.local.get(kinds.map(kind => titleStoreKey(kind, titleSlug))) : {};
    for (const kind of kinds) {
      const data = stored[titleStoreKey(kind, titleSlug)];
      result[kind] = data ? { [titleSlug]: data } : {};
    }
  }
  return result;
}

// Аналог chrome.storage.local.set(items) с раскладкой тайтлов по ключам
function setTitleStore(items) {
  return chrome.storage.local.set(splitTitleStore(items));
}

// Все сохранённые тайтлы (нужно только для массовых правок, например сброса displayTitle)
async function getAllTitleData() {
  const all = await chrome.storage.local.get(null);
  await migrateTitleStore(all);
  const migrated = all.titleData ? await chrome.storage.local.get(null) : all;
  const prefix = titleStoreKey('titleData', '');
  const titleData = {};
  for (const [key, value] of Object.entries(migrated)) {
    if (key.startsWith(prefix)) titleData[key.slice(prefix.length)] = value;
  }
  return titleData;
}

// Изменение данных тайтла из события chrome.storage.onChanged
function getTitleChange(changes, kind, slug) {
  return slug ? changes[titleStoreKey(kind, slug)] : undefined;
}
