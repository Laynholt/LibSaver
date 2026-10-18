// engine-client.js - клиент очереди фонового движка: ставит снимок загрузки в очередь.
// Нужен окну «Подготовка» и быстрому окошку «Скачать»; остальные команды (пауза, отмена…) - в downloads-view.js.

// ensureEngine -> порт -> enqueue; движок отвечает { type: 'enqueueResult', ok, reason? }
async function enqueueSnapshot(snapshot) {
  await chrome.runtime.sendMessage({ action: 'ensureEngine' });
  const port = chrome.runtime.connect({ name: 'libsaver-engine' });
  try {
    return await new Promise((resolve, reject) => {
      port.onMessage.addListener(message => {
        if (message.type === 'enqueueResult') resolve(message);
      });
      port.onDisconnect.addListener(() => reject(new Error('Движок загрузки недоступен')));
      port.postMessage({ cmd: 'enqueue', snapshot });
    });
  } finally {
    port.disconnect();
  }
}
