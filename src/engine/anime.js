// anime.js - загрузка серий AnimeLIB: плеер Kodik серии -> прямая ссылка на MP4 -> загрузчик браузера (engine.js, runTitle).
// Видео качает сам браузер (chrome.downloads): движок по очереди отдаёт ему ссылки, ход тайтла - сколько серий передано.
// Цепочка Kodik проверена 2026-10-19: HTML плеера (urlParams, vInfo) -> POST на адрес из JS плеера -> ссылки в ROT18 + base64,
// ссылка вида .../720.mp4:hls:manifest.m3u8 без суффикса - цельный MP4 (H.264 + AAC). Referer Kodik не проверяет.
// Собственный плеер AnimeLIB (без Kodik) не поддерживается: серии без Kodik пропускаются с записью в журнал.

const KODIK_ENDPOINT_FALLBACK = '/ftor';
const ANIME_EPISODE_PAUSE_MS = 300;

// Kodik кодирует ссылки так же, как раскодирует их его плеер: сдвиг букв на 18, затем base64
function decodeKodikLink(encoded) {
  return atob(encoded.replace(/[a-zA-Z]/g, char => {
    const last = char <= 'Z' ? 90 : 122;
    const code = char.charCodeAt(0) + 18;
    return String.fromCharCode(last >= code ? code : code - 26);
  }));
}

// Наибольшее качество не выше limit ('max' - любое); если все выше - наименьшее из имеющихся
function pickKodikQuality(links, limit) {
  const qualities = Object.keys(links || {}).map(Number).filter(q => q > 0 && links[q]?.[0]?.src).sort((a, b) => b - a);
  if (!qualities.length) return null;
  const max = Number(limit) || Infinity;
  return qualities.find(q => q <= max) ?? qualities[qualities.length - 1];
}

// Kodik выбранной команды, иначе первый Kodik серии
function pickAnimePlayer(players, teamId) {
  const kodik = (players || []).filter(player => player.player === 'Kodik' && player.src);
  return kodik.find(player => String(player.team?.id) === String(teamId)) || kodik[0] || null;
}

// Расширению открыты все сайты (<all_urls>), а адрес плеера приходит из API AnimeLIB: запросы - только по https к хостам Kodik
const KODIK_HOST = /(^|\.)kodikplayer\.com$/;
function kodikUrl(href, base) {
  const url = new URL(href, base);
  if (url.protocol !== 'https:' || !KODIK_HOST.test(url.hostname)) throw new Error(`Kodik: адрес не на kodikplayer.com (${url.host || url.protocol})`);
  return url.href;
}

// Прямая ссылка на MP4 из ссылки Kodik: HLS-суффикс отрезается, схема - только https (ссылку получает загрузчик браузера)
function kodikMp4Url(link) {
  const url = new URL(link.replace(/:hls:manifest\.m3u8$/, ''), 'https://kodikplayer.com/');
  if (url.protocol !== 'https:') throw new Error('Kodik: ссылка на видео не https');
  return url.href;
}

// Адрес запроса ссылок плеер хранит как atob("...") в своём JS; путь меняется - берём из JS, не вышло - известный.
// Годится только путь на том же хосте: «//хост/...» увёл бы запрос на чужой сайт
const kodikEndpoints = new Map(); // адрес JS плеера -> путь
async function kodikEndpoint(html, page) {
  const script = html.match(/<script[^>]+src=["']([^"']*app\.player[^"']*\.js)["']/)?.[1];
  if (!script) return KODIK_ENDPOINT_FALLBACK;
  let scriptUrl;
  try {
    scriptUrl = kodikUrl(script, page);
  } catch (e) {
    return KODIK_ENDPOINT_FALLBACK;
  }
  if (!kodikEndpoints.has(scriptUrl)) {
    let path = KODIK_ENDPOINT_FALLBACK;
    try {
      const encoded = (await (await fetch(scriptUrl)).text()).match(/type:\s*"POST",\s*url:\s*atob\("([A-Za-z0-9+/=]+)"\)/)?.[1];
      if (encoded && /^\/[\w-]/.test(atob(encoded))) path = atob(encoded);
    } catch (e) { /* остаётся известный путь */ }
    kodikEndpoints.set(scriptUrl, path);
  }
  return kodikEndpoints.get(scriptUrl);
}

// Плеер Kodik (src без схемы: //kodikplayer.com/seria/...) -> { url, quality }
async function resolveKodik(src, qualityLimit) {
  const page = kodikUrl(src, 'https://kodikplayer.com/');
  const html = await (await fetch(page)).text();
  const params = html.match(/urlParams\s*=\s*'([^']+)'/)?.[1];
  const info = key => html.match(new RegExp(`vInfo\\.${key}\\s*=\\s*'([^']*)'`))?.[1];
  if (!params || !info('hash') || !info('id')) throw new Error('Kodik: не удалось разобрать страницу плеера');
  const { d, d_sign, pd, pd_sign, ref, ref_sign } = JSON.parse(params);
  const body = new URLSearchParams({
    d, d_sign, pd, pd_sign, ref: decodeURIComponent(ref || ''), ref_sign,
    bad_user: 'false', cdn_is_working: 'true', type: info('type') || 'seria', hash: info('hash'), id: info('id'), info: '{}'
  });
  const endpoint = new URL(await kodikEndpoint(html, page), page);
  if (endpoint.origin !== new URL(page).origin) throw new Error('Kodik: запрос ссылок ушёл бы на другой сайт');
  const response = await fetch(endpoint, { method: 'POST', body });
  if (!response.ok) throw new Error(`Kodik: HTTP ${response.status}`);
  const { links } = await response.json();
  const quality = pickKodikQuality(links, qualityLimit);
  if (!quality) throw new Error('Kodik: нет ссылок на видео');
  return { url: kodikMp4Url(decodeKodikLink(links[quality][0].src)), quality };
}

const pad2 = value => String(value).padStart(2, '0');

function escapeXml(text) {
  return String(text).replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]));
}

const splitList = text => String(text || '').split(',').map(item => item.trim()).filter(Boolean);

// tvshow.nfo (Kodi, Jellyfin, Plex с плагином): название, описание, жанры, теги, студия, год, статус, возраст, постер
function buildTvshowNfo(metadata, poster) {
  const tag = (name, value) => value ? `  <${name}>${escapeXml(value)}</${name}>\n` : '';
  const year = String(metadata.year || '').match(/\d{4}/)?.[0];
  const shikimoriId = String(metadata.shikimori || '').match(/\d+$/)?.[0];
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<tvshow>\n'
    + tag('title', metadata.titleRu || metadata.titleOriginal || metadata.titleEn)
    + tag('originaltitle', metadata.titleOriginal || metadata.titleEn)
    + tag('plot', metadata.description)
    + tag('year', year)
    + tag('premiered', /^\d{4}-\d{2}-\d{2}/.test(metadata.year || '') ? metadata.year.slice(0, 10) : '')
    + tag('status', metadata.status)
    + tag('mpaa', metadata.ageRestriction)
    + splitList(metadata.publisher).map(studio => tag('studio', studio)).join('')
    + splitList(metadata.genres).map(genre => tag('genre', genre)).join('')
    + splitList(metadata.tags).map(name => tag('tag', name)).join('')
    + (metadata.rating ? `  <ratings><rating name="shikimori" max="10" default="true"><value>${escapeXml(metadata.rating)}</value></rating></ratings>\n` : '')
    + (poster ? `  <thumb aspect="poster">${escapeXml(poster)}</thumb>\n` : '')
    + (shikimoriId ? `  <uniqueid type="shikimori">${shikimoriId}</uniqueid>\n` : '')
    + '</tvshow>\n';
}

// Серии снимка по очереди. hooks: { log(line, isError), progress(current, total), isCanceled(), save(url, name, folder) }
async function downloadAnime(snapshot, hooks) {
  const data = snapshot.downloadData;
  const metadata = data.metadata || {};
  const ids = Array.isArray(data.selectedChapterIds) ? new Set(data.selectedChapterIds) : null;
  const seen = new Set();
  const episodes = (data.chapters || []).filter(ch => (!ids || ids.has(ch.id)) && !seen.has(ch.id) && seen.add(ch.id));
  if (!episodes.length) throw new Error('Не выбрано ни одной серии');
  const folder = snapshot.title || data.slug;
  const quality = snapshot.stored?.animeQuality || 'max';
  const stop = () => { if (hooks.isCanceled()) throw canceledError(); };

  if (snapshot.stored?.animeSaveInfo !== false) {
    const firstCover = data.allCovers?.[0]; // обложки из редактора, первая - главная
    const cover = (firstCover?.url ?? firstCover) || metadata.cover || '';
    const nfo = URL.createObjectURL(new Blob([buildTvshowNfo(metadata, cover)], { type: 'text/xml' }));
    try {
      await hooks.save(nfo, 'tvshow.nfo', folder);
      if (cover) await hooks.save(cover, `poster.${cover.match(/\.(jpe?g|png|webp)(?=$|\?)/i)?.[1] || 'jpg'}`, folder);
    } catch (e) {
      hooks.log(`Не удалось сохранить описание или постер: ${e.message}`, true);
    }
    setTimeout(() => URL.revokeObjectURL(nfo), 60000); // загрузчик браузера читает blob уже после download()
  }

  let saved = 0;
  hooks.progress(0, episodes.length);
  for (const [index, episode] of episodes.entries()) {
    stop();
    const label = `Сезон ${episode.volume}. Серия ${episode.number}${episode.name ? '. ' + episode.name : ''}`;
    try {
      const details = await pageCall('animelib', 'animeApi', [`/api/episodes/${encodeURIComponent(episode.id)}`], data.tabId);
      if (!details?.success) throw new Error(details?.error || 'нет ответа API');
      stop();
      const player = pickAnimePlayer(details.data.players, episode.branchId);
      if (!player) throw new Error('нет плеера Kodik');
      const video = await resolveKodik(player.src, quality);
      stop();
      await hooks.save(video.url, `${folder} - S${pad2(episode.volume)}E${pad2(episode.number)}.mp4`, folder);
      saved++;
      hooks.log(`${label} - ${player.team?.name || 'без команды'}, ${video.quality}p: передана загрузчику браузера`);
    } catch (e) {
      if (e.canceled) throw e;
      hooks.log(`${label}: пропущена (${e.message})`, true);
    }
    hooks.progress(index + 1, episodes.length);
    if (index < episodes.length - 1) await new Promise(resolve => setTimeout(resolve, ANIME_EPISODE_PAUSE_MS));
  }
  if (!saved) throw new Error('Ни одна серия не скачана: подробности в журнале');
  hooks.progress(saved, episodes.length); // меньше выбранного - «Готово с пропусками» в списке загрузок
  hooks.log(`Готово: ${saved} из ${episodes.length} серий. Файлы докачивает браузер (список загрузок)`);
  return { filename: folder };
}
