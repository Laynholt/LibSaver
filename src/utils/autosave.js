// autosave.js - автосохранение вместо кнопки «Сохранить»: правка поля (input/change) или событие libsaver:changed -> пауза -> save().
// Подключается на страницах настроек и редакторов перед их скриптом.

const AUTOSAVE_TOAST_GAP = 5000; // «Сохранено!» не на каждую правку

// Для правок, после которых поле не меняется само (перетаскивание, загрузка файла, кнопки сброса)
function notifyChanged(root = document) {
  root.dispatchEvent(new CustomEvent('libsaver:changed'));
}

function enableAutosave({ save, root = document, delay = 400 }) {
  let timer = null;
  let queue = Promise.resolve(); // сохранения идут по очереди: save() читает старое значение и пишет новое
  let lastToast = -Infinity;

  const toast = (message, type, duration) => {
    chrome.runtime.sendMessage({ action: 'showToast', message, type, duration }).catch(() => { /* нет окна, которое покажет toast */ });
  };

  const run = () => {
    timer = null;
    queue = queue.then(async () => {
      try {
        await save();
        if (Date.now() - lastToast >= AUTOSAVE_TOAST_GAP) {
          lastToast = Date.now();
          toast('Сохранено!', 'success');
        }
      } catch (error) {
        console.error('[LibSaver] autosave', error);
        toast(`Не удалось сохранить: ${error?.message ?? error}`, 'error', 4000);
      }
    });
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  };

  for (const type of ['input', 'change', 'libsaver:changed']) root.addEventListener(type, schedule);
  // Окно закрыли раньше, чем истекла пауза: правка не должна пропасть
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      if (timer === null) return;
      clearTimeout(timer);
      run();
    });
  }
}
