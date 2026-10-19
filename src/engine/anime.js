// anime.js - загрузка серий AnimeLIB: плеер Kodik серии -> прямая ссылка на MP4 -> файл качается частями -> описание в MP4 -> загрузчик браузера (engine.js, runTitle).
// Рядом с сериями - «Описание.txt» и обложка тайтла (по галочкам раздела «Видео»).
// Цепочка Kodik проверена 2026-10-19: HTML плеера (urlParams, vInfo) -> POST на адрес из JS плеера -> ссылки в ROT18 + base64,
// ссылка вида .../720.mp4:hls:manifest.m3u8 без суффикса - цельный MP4 (H.264 + AAC, moov в начале). Referer Kodik не проверяет.
// Собственный плеер AnimeLIB (без Kodik) не поддерживается: серии без Kodik пропускаются с записью в журнал.

const KODIK_ENDPOINT_FALLBACK = '/ftor';
const ANIME_EPISODE_PAUSE_MS = 300;
// CDN Kodik отдаёт ~0.3 МБ/с на соединение, 8 соединений - ~2.3 МБ/с (замер 2026-10-19): серия качается частями по 4 МБ в 8 потоков
const VIDEO_CONNECTIONS = 8;
const VIDEO_CHUNK = 4 << 20;
const VIDEO_CHUNK_TRIES = 3;

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

// Расширению открыты все сайты (<all_urls>), а адрес плеера приходит из API AnimeLIB: запросы - только по https к хостам Kodik, без cookie
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
  // Видео качает само расширение, а CDN у Kodik меняются (solodcdn и др.): вместо списка хостов - только имена, не IP и не локальные.
  // URL приводит любую запись IP к виду 1.2.3.4 или [::1]. shortcut: имя, которое резолвится в адрес своей сети, не ловится
  if (url.hostname.startsWith('[') || /\.\d+$|^\d+$/.test(url.hostname) || /(^|\.)(localhost|local|internal|lan|home|arpa)$|^[^.]+$/i.test(url.hostname)) {
    throw new Error(`Kodik: ссылка на видео ведёт в локальную сеть (${url.host})`);
  }
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
      const encoded = (await (await fetch(scriptUrl, { credentials: 'omit' })).text()).match(/type:\s*"POST",\s*url:\s*atob\("([A-Za-z0-9+/=]+)"\)/)?.[1];
      if (encoded && /^\/[\w-]/.test(atob(encoded))) path = atob(encoded);
    } catch (e) { /* остаётся известный путь */ }
    kodikEndpoints.set(scriptUrl, path);
  }
  return kodikEndpoints.get(scriptUrl);
}

// Плеер Kodik (src без схемы: //kodikplayer.com/seria/...) -> { url, quality }
async function resolveKodik(src, qualityLimit) {
  const page = kodikUrl(src, 'https://kodikplayer.com/');
  const html = await (await fetch(page, { credentials: 'omit' })).text();
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
  const response = await fetch(endpoint, { method: 'POST', body, credentials: 'omit' });
  if (!response.ok) throw new Error(`Kodik: HTTP ${response.status}`);
  const { links } = await response.json();
  const quality = pickKodikQuality(links, qualityLimit);
  if (!quality) throw new Error('Kodik: нет ссылок на видео');
  return { url: kodikMp4Url(decodeKodikLink(links[quality][0].src)), quality };
}

const pad2 = value => String(value).padStart(2, '0');

// MP4 частями по VIDEO_CHUNK в VIDEO_CONNECTIONS потоков -> Blob. Размер узнаётся запросом первого байта; сервер без Range отдаёт файл целиком.
// onPart(доля) - ход серии, stop() бросает отмену. Части - Blob: большие браузер держит на диске, а не в памяти страницы
async function fetchVideo(url, onPart, stop) {
  const abort = new AbortController();
  const get = async (from, to) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(url, { headers: { Range: `bytes=${from}-${to}` }, signal: abort.signal, credentials: 'omit' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response;
      } catch (e) {
        if (abort.signal.aborted || attempt >= VIDEO_CHUNK_TRIES) throw e;
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  };
  const probe = await get(0, 0);
  const total = probe.status === 206 ? Number(probe.headers.get('content-range')?.match(/\/(\d+)$/)?.[1]) : 0;
  if (!total) return probe.blob();
  probe.body?.cancel();
  const count = Math.ceil(total / VIDEO_CHUNK);
  const parts = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < count) {
      stop();
      const index = next++;
      const from = index * VIDEO_CHUNK;
      const to = Math.min(from + VIDEO_CHUNK, total) - 1;
      const response = await get(from, to);
      parts[index] = await response.blob();
      if (response.status !== 206 || parts[index].size !== to - from + 1) throw new Error('сервер прислал не ту часть файла');
      onPart(++done / count);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(VIDEO_CONNECTIONS, count) }, worker));
  } catch (e) {
    abort.abort(); // остальные потоки не докачивают серию, которая уже не сохранится
    throw e;
  }
  return new Blob(parts, { type: 'video/mp4' });
}

// Блоки MP4: [размер 4 байта][тип 4 байта][содержимое]
function mp4Box(type, ...parts) {
  const size = 8 + parts.reduce((sum, part) => sum + part.length, 0);
  const box = new Uint8Array(size);
  new DataView(box.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) box[4 + i] = type.charCodeAt(i); // «©» тегов iTunes - один байт 0xA9
  let offset = 8;
  for (const part of parts) {
    box.set(part, offset);
    offset += part.length;
  }
  return box;
}

function u32(...values) {
  const bytes = new Uint8Array(values.length * 4);
  values.forEach((value, i) => new DataView(bytes.buffer).setUint32(i * 4, value));
  return bytes;
}

function* mp4Children(view, start, end) {
  for (let offset = start; offset + 8 <= end;) {
    const size = view.getUint32(offset);
    if (size < 8 || offset + size > end) throw new Error('MP4: неожиданное устройство файла');
    yield { type: String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset + 4, 4)), start: offset, end: offset + size };
    offset += size;
  }
}

// Таблицы stco/co64 хранят смещения кусков видео от начала файла: moov перед mdat вырос на delta - куски за ним сдвигаются
function shiftChunkOffsets(view, start, end, from, delta) {
  for (const box of mp4Children(view, start, end)) {
    if (['trak', 'mdia', 'minf', 'stbl'].includes(box.type)) shiftChunkOffsets(view, box.start + 8, box.end, from, delta);
    if (box.type !== 'stco' && box.type !== 'co64') continue;
    const wide = box.type === 'co64';
    const count = view.getUint32(box.start + 12);
    for (let i = 0; i < count; i++) {
      const at = box.start + 16 + i * (wide ? 8 : 4);
      if (wide) {
        const value = view.getBigUint64(at);
        if (value >= BigInt(from)) view.setBigUint64(at, value + BigInt(delta));
      } else {
        const value = view.getUint32(at);
        if (value < from) continue;
        if (value + delta > 0xFFFFFFFF) throw new Error('MP4: файл слишком большой для описания');
        view.setUint32(at, value + delta);
      }
    }
  }
}

// Теги iTunes (moov/udta/meta/ilst) - их читают ffmpeg, Jellyfin, Plex, Kodi, VLC, проводник Windows
function animeTags(metadata, episode) {
  const show = metadata.titleRu || metadata.titleOriginal || metadata.titleEn || '';
  const whole = value => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
  const comment = [
    metadata.titleOriginal && `Оригинальное название: ${metadata.titleOriginal}`,
    metadata.publisher && `Студия: ${metadata.publisher}`,
    metadata.author && `Автор: ${metadata.author}`,
    metadata.status && `Статус: ${metadata.status}`,
    metadata.ageRestriction && `Возраст: ${metadata.ageRestriction}`,
    metadata.tags && `Метки: ${metadata.tags}`,
    metadata.rating && `Оценка Shikimori: ${metadata.rating}`,
    metadata.shikimori
  ].filter(Boolean).join('\n');
  return [
    ['©nam', episode.name || `Серия ${episode.number}`],
    ['tvsh', show],
    ['©alb', show],
    ['tvsn', whole(episode.volume)],
    ['tves', whole(episode.number)],
    ['©day', String(metadata.year || '').match(/\d{4}/)?.[0]],
    ['©gen', metadata.genres],
    ['desc', metadata.description],
    ['ldes', metadata.description],
    ['©cmt', comment],
    ['stik', 10] // вид ролика: сериал
  ].filter(([, value]) => value || value === 0);
}

function ilstItem(type, value) {
  const number = typeof value === 'number';
  const data = number ? (type === 'stik' ? Uint8Array.of(value) : u32(value)) : new TextEncoder().encode(value);
  return mp4Box(type, mp4Box('data', u32(number ? 21 : 1, 0), data)); // 1 - текст UTF-8, 21 - целое
}

// Новый moov: старые блоки без udta + udta с тегами. Остальной файл не читается в память - Blob ссылается на исходный
async function tagMp4(blob, tags) {
  let moov = null;
  for (let offset = 0; offset + 8 <= blob.size && !moov;) {
    const head = new DataView(await blob.slice(offset, offset + 16).arrayBuffer());
    const short = head.getUint32(0);
    const size = short === 1 ? Number(head.getBigUint64(8)) : short || blob.size - offset;
    if (size < 8) throw new Error('MP4: неожиданное устройство файла');
    if (String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7)) === 'moov') {
      if (short === 1) throw new Error('MP4: moov больше 4 ГБ');
      moov = { start: offset, end: offset + size };
    }
    offset += size;
  }
  if (!moov) throw new Error('MP4: нет блока moov');
  const bytes = new Uint8Array(await blob.slice(moov.start, moov.end).arrayBuffer());
  const kept = [...mp4Children(new DataView(bytes.buffer), 8, bytes.length)].filter(box => box.type !== 'udta').map(box => bytes.subarray(box.start, box.end));
  const hdlr = mp4Box('hdlr', u32(0, 0), new TextEncoder().encode('mdirappl'), u32(0, 0), Uint8Array.of(0));
  const meta = mp4Box('meta', u32(0), hdlr, mp4Box('ilst', ...tags.map(([type, value]) => ilstItem(type, value))));
  const tagged = mp4Box('moov', ...kept, mp4Box('udta', meta));
  shiftChunkOffsets(new DataView(tagged.buffer), 8, tagged.length, moov.start, tagged.length - bytes.length);
  return new Blob([blob.slice(0, moov.start), tagged, blob.slice(moov.end)], { type: 'video/mp4' });
}

// «Описание.txt»: всё о тайтле обычным текстом, открывается в Блокноте
function buildAnimeInfoText(metadata) {
  const title = metadata.titleRu || metadata.titleOriginal || metadata.titleEn || '';
  const lines = [
    ['Оригинальное название', metadata.titleOriginal],
    ['Английское название', metadata.titleEn],
    ['Другие названия', String(metadata.titleAlt || '').split('\n').map(name => name.trim()).filter(Boolean).join(', ')],
    ['Формат', metadata.releaseFormat],
    ['Год', metadata.year],
    ['Статус', metadata.status],
    ['Возраст', metadata.ageRestriction],
    ['Студия', metadata.publisher],
    ['Автор', metadata.author],
    ['Длительность', metadata.duration],
    ['Жанры', metadata.genres],
    ['Метки', metadata.tags],
    ['Оценка Shikimori', metadata.rating],
    ['Shikimori', metadata.shikimori]
  ].filter(([, value]) => value).map(([name, value]) => `${name}: ${value}`);
  return [title, '', ...lines, ...(metadata.description ? ['', 'Описание:', metadata.description] : [])].join('\r\n') + '\r\n';
}

// Описание (Описание.txt) и обложка в папку серий - каждое по своей галочке «Видео». Обложка тайтла с cover.hentaicdn.org отдаётся без Referer
async function saveTitleExtras(snapshot, folder, hooks) {
  const data = snapshot.downloadData;
  const metadata = data.metadata || {};
  const firstCover = data.allCovers?.[0];
  const cover = metadata.cover || (firstCover?.url ?? firstCover) || '';
  if (snapshot.stored?.animeSaveText !== false) {
    const text = URL.createObjectURL(new Blob([buildAnimeInfoText(metadata)], { type: 'text/plain;charset=utf-8' }));
    try {
      await hooks.save(text, 'Описание.txt', folder);
    } catch (e) {
      hooks.log(`Не удалось сохранить описание (Описание.txt): ${e.message}`, true);
    } finally {
      setTimeout(() => URL.revokeObjectURL(text), 60000); // загрузчик браузера читает blob уже после download()
    }
  }
  if (snapshot.stored?.animeSavePoster !== false && cover) {
    try {
      await hooks.save(cover, `poster.${cover.match(/\.(jpe?g|png|webp)(?=$|\?)/i)?.[1] || 'jpg'}`, folder);
    } catch (e) {
      hooks.log(`Не удалось сохранить обложку: ${e.message}`, true);
    }
  }
}

// Серии снимка по очереди. hooks: { log(line, isError), progress(done, total, part), isCanceled(), save(url, name, folder) }
async function downloadAnime(snapshot, hooks) {
  const data = snapshot.downloadData;
  const metadata = data.metadata || {};
  const ids = Array.isArray(data.selectedChapterIds) ? new Set(data.selectedChapterIds) : null;
  const seen = new Set();
  const episodes = (data.chapters || []).filter(ch => (!ids || ids.has(ch.id)) && !seen.has(ch.id) && seen.add(ch.id));
  if (!episodes.length) throw new Error('Не выбрано ни одной серии');
  const folder = snapshot.title || data.slug;
  const quality = snapshot.stored?.animeQuality || 'max';
  const withInfo = snapshot.stored?.animeSaveInfo !== false;
  const stop = () => { if (hooks.isCanceled()) throw canceledError(); };

  await saveTitleExtras(snapshot, folder, hooks);
  let saved = 0;
  hooks.progress(0, episodes.length, 0);
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
      let file = await fetchVideo(video.url, part => hooks.progress(index, episodes.length, part), stop);
      stop();
      if (withInfo) {
        try {
          file = await tagMp4(file, animeTags(metadata, episode));
        } catch (e) {
          hooks.log(`${label}: описание в файл не записано (${e.message}), серия сохранена без него`, true);
        }
      }
      const url = URL.createObjectURL(file);
      try {
        await hooks.save(url, `${folder} - S${pad2(episode.volume)}E${pad2(episode.number)}.mp4`, folder);
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60000); // загрузчик браузера читает blob уже после download()
      }
      saved++;
      hooks.log(`${label} - ${player.team?.name || 'без команды'}, ${video.quality}p, ${(file.size / 1048576).toFixed(0)} МБ: сохранена`);
    } catch (e) {
      if (e.canceled) throw e;
      hooks.log(`${label}: пропущена (${e.message})`, true);
    }
    hooks.progress(index + 1, episodes.length, 0);
    if (index < episodes.length - 1) await new Promise(resolve => setTimeout(resolve, ANIME_EPISODE_PAUSE_MS));
  }
  if (!saved) throw new Error('Ни одна серия не скачана: подробности в журнале');
  hooks.progress(saved, episodes.length, 0); // меньше выбранного - «Готово с пропусками» в списке загрузок
  hooks.log(`Готово: ${saved} из ${episodes.length} серий`);
  return { filename: folder };
}
