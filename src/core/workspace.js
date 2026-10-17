// Окно с вкладками: редакторы и настройки открываются внутри одного окна (каждая вкладка — свой iframe)

const frames = document.getElementById('frames');

// Без загруженного тайтла редакторам нечего показывать — оставляем только настройки
if (new URLSearchParams(location.search).get('title') === '0') {
  document.querySelectorAll('.ws-tab:not([data-tab="settings"])').forEach(tab => tab.remove());
}
const tabs = [...document.querySelectorAll('.ws-tab')];

function openTab(name) {
  if (!tabs.some(tab => tab.dataset.tab === name)) name = tabs[0].dataset.tab;
  for (const tab of tabs) {
    tab.classList.toggle('active', tab.dataset.tab === name);
    tab.setAttribute('aria-selected', tab.dataset.tab === name);
  }
  // iframe создаётся при первом открытии и живёт до закрытия окна, чтобы не терять несохранённые правки
  let frame = document.getElementById(`frame-${name}`);
  if (!frame) {
    frame = document.createElement('iframe');
    frame.id = `frame-${name}`;
    frame.src = `${name}.html`;
    frames.append(frame);
  }
  for (const other of frames.children) other.classList.toggle('active', other === frame);
  history.replaceState(null, '', `${location.search}#${name}`);
}

tabs.forEach(tab => tab.addEventListener('click', () => openTab(tab.dataset.tab)));
openTab(location.hash.slice(1));

document.addEventListener('DOMContentLoaded', async () => {
  // Встроенные страницы не регистрируют себя сами, окно регистрируется целиком
  await chrome.storage.local.set({ currentOpenWindow: 'workspace' });
  window.addEventListener('beforeunload', async () => {
    await chrome.storage.local.remove('currentOpenWindow');
  });

  await loadAndApplyTheme();
  const { sourceUrl } = await chrome.storage.local.get(['sourceUrl']);
  if (sourceUrl) window.applySiteAccent(sourceUrl);
});

setupThemeMessageListener();

// Редакторы после сохранения шлют toast — показываем его здесь
chrome.runtime.onMessage.addListener(message => {
  if (message.action === 'showToast') showToast(message.message, message.type);
});
