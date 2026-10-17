const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

const toRegExp = pattern => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

// page-call.js in a vm with a fake chrome over the `tabs` array.
// onNoTab(tabs) runs when pageCall asks the user to open the site; onExec(tabId, tabs, n) may throw or change tabs.
function pageCallContext(tabs, { onNoTab = () => {}, onExec = () => {}, noTabApi = false, sendMessage } = {}) {
  const ctx = { tabs, handlerCalls: [], execTabs: [] };
  const chrome = { runtime: { sendMessage } };
  if (!noTabApi) {
    chrome.tabs = {
      get: async id => tabs.find(tab => tab.id === id) || Promise.reject(new Error(`No tab with id: ${id}`)),
      query: async ({ url }) => tabs.filter(tab => url.some(pattern => toRegExp(pattern).test(tab.url)))
    };
    chrome.scripting = {
      executeScript: async ({ target, func, args }) => {
        ctx.execTabs.push(target.tabId);
        const custom = onExec(target.tabId, tabs, ctx.execTabs.length);
        return [{ result: custom === undefined ? 'ok' : custom }];
      }
    };
  }
  Object.assign(ctx, { chrome, URL, console });
  vm.createContext(ctx);
  vm.runInContext(source('src/core/page-calls.js') + source('src/utils/page-call.js'), ctx);
  ctx.setNoTabHandler(async siteKey => { ctx.handlerCalls.push(siteKey); onNoTab(tabs); });
  return ctx;
}

test('findSiteTab keeps the preferred tab while it stays on the same site', async () => {
  const tabs = [{ id: 7, url: 'https://mangalib.me/ru/manga/x' }, { id: 9, url: 'https://mangalib.org/ru/catalog' }];
  const ctx = pageCallContext(tabs);
  assert.equal(await ctx.findSiteTab('mangalib', 7), 7);
});

test('findSiteTab falls back to another tab of the same site and never to another site', async () => {
  const tabs = [{ id: 7, url: 'https://hentailib.me/ru/manga/x' }, { id: 9, url: 'https://mangalib.org/ru/catalog' }];
  const ctx = pageCallContext(tabs);
  assert.equal(await ctx.findSiteTab('mangalib', 7), 9);
  assert.equal(await ctx.findSiteTab('ranobelib', 7), null);
});

test('findSiteTab skips discarded tabs', async () => {
  const tabs = [{ id: 1, url: 'https://mangalib.me/a', discarded: true }, { id: 2, url: 'https://mangalib.me/b', status: 'unloaded' }, { id: 3, url: 'https://mangalib.me/c' }];
  assert.equal(await pageCallContext(tabs).findSiteTab('mangalib'), 3);
});

test('pageCall waits through the no-tab handler and retries when the tab disappears', async () => {
  const tabs = [];
  const ctx = pageCallContext(tabs, {
    onNoTab: list => list.push({ id: 3, url: 'https://mangalib.me/ru/manga/x' }),
    onExec: (tabId, list, n) => {
      if (n === 1) {
        list.splice(0, list.length, { id: 4, url: 'https://mangalib.me/ru/manga/x' });
        throw new Error('No tab with id: 3.');
      }
    }
  });
  assert.equal(await ctx.pageCall('mangalib', 'chapterPages', [1, 's', 'normal']), 'ok');
  assert.deepEqual(ctx.handlerCalls, ['mangalib']);
  assert.deepEqual(ctx.execTabs, [3, 4]);
});

test('pageCall passes other injection errors through', async () => {
  const ctx = pageCallContext([{ id: 3, url: 'https://mangalib.me/x' }], { onExec: () => { throw new Error('boom'); } });
  await assert.rejects(ctx.pageCall('mangalib', 'chapters', []), { message: 'boom' });
});

test('default no-tab handler asks to open the site', async () => {
  const ctx = pageCallContext([]);
  vm.runInContext('setNoTabHandler()', ctx); // back to default
  await assert.rejects(ctx.pageCall('mangalib', 'chapters', []), { message: 'Откройте страницу сайта' });
});

test('without chrome.tabs/scripting the lookup goes through the service worker', async () => {
  const sent = [];
  const ctx = pageCallContext([], { noTabApi: true, sendMessage: async msg => { sent.push(msg.action); return { ok: true, result: msg.action === 'pageCall:findTab' ? 5 : 'done' }; } });
  assert.equal(await ctx.pageCall('mangalib', 'chapters', []), 'done');
  assert.deepEqual(sent, ['pageCall:findTab', 'pageCall:exec']);
});

test('siteKeyOf and siteLinks follow the site groups', () => {
  const ctx = pageCallContext([]);
  assert.equal(ctx.siteKeyOf('https://novelslib.me/ru/book/1'), 'ranobelib');
  assert.equal(ctx.siteKeyOf('https://example.com/'), null);
  assert.deepEqual(Array.from(ctx.siteLinks('mangalib')), ['https://mangalib.me', 'https://mangalib.org']);
});

test('SITE_TAB_PATTERNS covers exactly the manifest content_scripts matches', () => {
  const ctx = pageCallContext([]);
  const patterns = Object.values(vm.runInContext('SITE_TAB_PATTERNS', ctx)).flat();
  const manifest = JSON.parse(source('src/manifest.json')).content_scripts[0].matches;
  assert.deepEqual([...patterns].sort(), [...manifest].sort());
});

test('every former executeScript func now lives in PAGE_CALLS and api/base use pageCall', () => {
  assert.doesNotMatch(source('src/core/api.js') + source('src/formatters/base.js'), /chrome\.scripting\.executeScript/);
  const ctx = vm.createContext({});
  vm.runInContext(source('src/core/page-calls.js'), ctx);
  assert.deepEqual(Object.keys(vm.runInContext('PAGE_CALLS', ctx)).sort(), ['chapterPages', 'chapters', 'covers', 'mangaChapterPages', 'metadata', 'metadataExtra']);
});
