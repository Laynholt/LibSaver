const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

// engine/anime.js in a vm: fetch, pageCall and saving are fakes
function animeContext({ fetch, pageCall } = {}) {
  const ctx = vm.createContext({
    console, URL, URLSearchParams, Blob, atob, btoa, setTimeout: fn => fn(),
    fetch, pageCall,
    canceledError: () => Object.assign(new Error('Загрузка отменена'), { canceled: true })
  });
  ctx.URL.createObjectURL = () => 'blob:nfo';
  ctx.URL.revokeObjectURL = () => {};
  vm.runInContext(source('src/engine/anime.js'), ctx);
  return ctx;
}

// Обратное к decodeKodikLink: base64, затем сдвиг букв на 8 (= -18 по кругу из 26)
const encodeKodik = text => btoa(text).replace(/[a-zA-Z]/g, char => {
  const first = char <= 'Z' ? 65 : 97;
  return String.fromCharCode((char.charCodeAt(0) - first + 8) % 26 + first);
});

test('Kodik links decode back to the URL, and the HLS suffix gives the direct MP4', () => {
  const ctx = animeContext();
  const link = '//cloud.solodcdn.com/useruploads/abc/def:2026101911/720.mp4:hls:manifest.m3u8';
  assert.equal(ctx.decodeKodikLink(encodeKodik(link)), link);
  // реальная строка из ответа /ftor 2026-10-19 (360p серии 1 Umayuru)
  assert.match(ctx.decodeKodikLink('Tg9rjO91HK5hj2fdHOVsjq5rj20dlFVtkvDejO9pHPUdGEU2VuY2HOUbUBluGq00VEVtTEQ1UhCbUBYfG2RtVOQ5VhCeThZpUhs2HuQ2V2HqHLkgVLC5UuU0HrRpU2GeGBUeVLCgWrQeUrGfULM5UBIdUhGeTu1eVLxwjPU6jENciEHtk3YcjBV1WI'), /^\/\/cloud\.solodcdn\.com\/useruploads\/.+\/360\.mp4:hls:manifest\.m3u8$/);
  assert.equal(ctx.kodikMp4Url(link), 'https://cloud.solodcdn.com/useruploads/abc/def:2026101911/720.mp4');
});

test('quality: the best not above the limit, otherwise the lowest there is', () => {
  const ctx = animeContext();
  const links = { 360: [{ src: 'a' }], 480: [{ src: 'b' }], 720: [{ src: 'c' }] };
  assert.deepEqual(['max', '1080', '720', '480', '360', undefined].map(limit => ctx.pickKodikQuality(links, limit)), [720, 720, 720, 480, 360, 720]);
  assert.equal(ctx.pickKodikQuality({ 720: [{ src: 'c' }] }, '480'), 720);
  assert.equal(ctx.pickKodikQuality({}, 'max'), null);
});

test('player: Kodik of the chosen team, otherwise the first Kodik; other players are ignored', () => {
  const ctx = animeContext();
  const players = [
    { player: 'Animelib', src: 'x', team: { id: 1 } },
    { player: 'Kodik', src: 'k2', team: { id: 2 } },
    { player: 'Kodik', src: 'k3', team: { id: 3 } }
  ];
  assert.equal(ctx.pickAnimePlayer(players, '3').src, 'k3');
  assert.equal(ctx.pickAnimePlayer(players, '1').src, 'k2');
  assert.equal(ctx.pickAnimePlayer([players[0]], '1'), null);
});

test('tvshow.nfo carries titles, plot, genres, tags, studio, year and escapes text', () => {
  const ctx = animeContext();
  const nfo = ctx.buildTvshowNfo({
    titleRu: 'Пони <&>', titleOriginal: 'Umayuru', description: 'Описание', year: '2026-09-27', status: 'Онгоинг', ageRestriction: 'PG-13',
    publisher: 'Atorie A.B.C.', genres: 'Комедия, Повседневность', tags: 'Еда, Чиби', rating: '6.3', shikimori: 'https://shikimori.io/animes/64867'
  }, 'https://cover/x.jpg');
  for (const line of ['<title>Пони &lt;&amp;&gt;</title>', '<originaltitle>Umayuru</originaltitle>', '<plot>Описание</plot>', '<year>2026</year>',
    '<premiered>2026-09-27</premiered>', '<studio>Atorie A.B.C.</studio>', '<genre>Комедия</genre>', '<genre>Повседневность</genre>', '<tag>Чиби</tag>',
    '<mpaa>PG-13</mpaa>', '<uniqueid type="shikimori">64867</uniqueid>', '<thumb aspect="poster">https://cover/x.jpg</thumb>']) {
    assert.ok(nfo.includes(line), line);
  }
  assert.doesNotMatch(ctx.buildTvshowNfo({ titleRu: 'X' }, ''), /<plot>|<thumb|<uniqueid/);
});

test('downloadAnime resolves each selected episode through Kodik and hands the MP4 to the browser, skipping episodes without Kodik', async () => {
  const html = `<script src="/assets/js/app.player_single.abc.js"></script>
    var urlParams = '{"d":"kodikplayer.com","d_sign":"s1","pd":"kodikplayer.com","pd_sign":"s2","ref":"","ref_sign":"s3","advert_debug":true}';
    vInfo.type = 'seria'; vInfo.hash = 'h1'; vInfo.id = '42';`;
  const posts = [];
  const fetch = async (url, options) => {
    url = String(url);
    if (url.endsWith('.js')) return { ok: true, text: async () => 'x({type:"POST",url:atob("L2Z0b3Iy"),cache:!1})' }; // /ftor2
    if (options?.method === 'POST') {
      posts.push([url, Object.fromEntries(options.body)]);
      return { ok: true, json: async () => ({ links: { 360: [{ src: encodeKodik('//cdn/360.mp4:hls:manifest.m3u8') }], 720: [{ src: encodeKodik('//cdn/720.mp4:hls:manifest.m3u8') }] } }) };
    }
    return { ok: true, text: async () => html };
  };
  const players = { 11: [{ player: 'Kodik', src: '//kodikplayer.com/seria/42/h1/720p', team: { id: 7, name: 'SHIZA' } }], 12: [] };
  const pageCall = async (siteKey, name, [apiPath]) => {
    assert.deepEqual([siteKey, name], ['animelib', 'animeApi']);
    return { success: true, data: { players: players[apiPath.split('/').pop()] } };
  };
  const ctx = animeContext({ fetch, pageCall });
  const saved = [];
  const logs = [];
  const progress = [];
  const snapshot = {
    title: 'Пони', stored: { animeQuality: '480' },
    downloadData: {
      slug: 'x', tabId: 5, metadata: { titleRu: 'Пони', cover: 'https://cover/p.png' }, allCovers: [],
      chapters: [{ id: 11, volume: '1', number: '1', branchId: '7' }, { id: 12, volume: '1', number: '2' }, { id: 13, volume: '1', number: '3' }],
      selectedChapterIds: [11, 12]
    }
  };
  const result = await ctx.downloadAnime(snapshot, {
    log: (line, isError) => logs.push([line, !!isError]),
    progress: (done, total) => progress.push([done, total]),
    isCanceled: () => false,
    save: async (url, name, folder) => saved.push([url, name, folder])
  });
  assert.equal(result.filename, 'Пони');
  assert.deepEqual(saved, [['blob:nfo', 'tvshow.nfo', 'Пони'], ['https://cover/p.png', 'poster.png', 'Пони'], ['https://cdn/360.mp4', 'Пони - S01E01.mp4', 'Пони']]);
  assert.equal(posts[0][0], 'https://kodikplayer.com/ftor2');
  assert.deepEqual([posts[0][1].hash, posts[0][1].id, posts[0][1].type, posts[0][1].d_sign, 'advert_debug' in posts[0][1]], ['h1', '42', 'seria', 's1', false]);
  assert.ok(logs.some(([line, isError]) => isError && line.includes('Серия 2') && line.includes('нет плеера Kodik')));
  assert.deepEqual(progress.at(-1), [1, 2]);
});

test('only https Kodik hosts are requested: a foreign player, a //host endpoint and a non-https video link are refused', async () => {
  const requested = [];
  const fetch = async (url, options) => {
    requested.push([String(url), options?.method || 'GET']);
    if (String(url).endsWith('.js')) return { ok: true, text: async () => 'x({type:"POST",url:atob("' + btoa('//evil.test/steal') + '")})' };
    if (options?.method === 'POST') return { ok: true, json: async () => ({ links: { 720: [{ src: encodeKodik('//cdn/720.mp4') }] } }) };
    return { ok: true, text: async () => `<script src="/assets/js/app.player_single.x.js"></script> var urlParams = '{"d":"a","ref":""}'; vInfo.hash = 'h'; vInfo.id = '1';` };
  };
  const ctx = animeContext({ fetch });
  for (const src of ['//127.0.0.1:8080/admin', 'http://kodikplayer.com/seria/1', 'https://kodikplayer.com.evil.test/x', 'javascript:alert(1)']) {
    await assert.rejects(ctx.resolveKodik(src, 'max'), /Kodik: адрес не на kodikplayer\.com/, src);
  }
  assert.deepEqual(requested, []);
  const video = await ctx.resolveKodik('//kodikplayer.com/seria/1/h/720p', 'max');
  assert.equal(video.url, 'https://cdn/720.mp4');
  assert.deepEqual(requested.map(([url, method]) => `${method} ${url}`), [
    'GET https://kodikplayer.com/seria/1/h/720p', 'GET https://kodikplayer.com/assets/js/app.player_single.x.js', 'POST https://kodikplayer.com/ftor'
  ]);
  assert.throws(() => ctx.kodikMp4Url('http://cdn/720.mp4'), /не https/);
});

test('downloadAnime stops on cancel and fails when nothing was saved', async () => {
  const ctx = animeContext({ fetch: async () => { throw new Error('offline'); }, pageCall: async () => ({ success: true, data: { players: [{ player: 'Kodik', src: '//k/x' }] } }) });
  const snapshot = { title: 'T', stored: { animeSaveInfo: false }, downloadData: { chapters: [{ id: 1, volume: '1', number: '1' }] } };
  const hooks = { log: () => {}, progress: () => {}, save: async () => {} };
  await assert.rejects(ctx.downloadAnime(snapshot, { ...hooks, isCanceled: () => false }), /Ни одна серия не скачана/);
  await assert.rejects(ctx.downloadAnime(snapshot, { ...hooks, isCanceled: () => true }), error => error.canceled === true);
});

test('AnimeLIB is wired in: title page, buttons under «Начать смотреть», engine page scripts, settings group', () => {
  const ctx = vm.createContext({ console, URL });
  vm.runInContext(source('src/utils/page-call.js'), ctx);
  assert.equal(ctx.isTitlePage('https://animelib.org/ru/anime/27380--umayuru-full-gate-anime'), true);
  assert.equal(ctx.isTitlePage('https://animelib.org/ru/anime/27380--umayuru-full-gate-anime/watch'), false);
  assert.deepEqual([ctx.siteTypeOf('animelib'), ctx.siteTypeOf('mangalib'), ctx.siteTypeOf('ranobelib')], ['anime', 'manga', 'ranobe']);
  assert.match(source('src/content/site-ui.js'), /animelib: \['a\.btn\.variant-primary\[href\*="\/watch"\]'\]/);
  for (const page of ['src/engine/engine.html', 'src/engine/background-firefox.html']) {
    assert.match(source(page), /engine\/anime\.js"><\/script>\s*<script src="\.\.\/engine\/engine\.js"/, page);
  }
  assert.match(source('src/html/settings.html'), /data-group="video" data-site-type="anime"/);
  assert.match(source('src/core/snapshot.js'), /'animeQuality', 'animeSaveInfo'/);
});
