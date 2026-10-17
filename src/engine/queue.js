// queue.js - очередь загрузок фонового движка: один тайтл за раз, без chrome API

// Статусы, при которых тайтл ещё в работе (повторное «Скачать» отклоняется)
const ACTIVE_STATUSES = ['queued', 'running', 'paused', 'waiting-tab', 'waiting-decision'];

// run(item, snapshot) -> Promise<{ filename }>: скачивает тайтл; onChange(items) - после каждого изменения
function createQueue({ run, onChange }) {
  const records = []; // { item: QueueItem, snapshot }
  let inFlight = null; // запись, чей run ещё не завершился (даже если её уже отменили)

  const find = id => records.find(record => record.item.id === id);
  const items = () => records.map(({ item }) => ({ ...item, progress: { ...item.progress } }));
  const changed = () => onChange(items());

  function finish(record, update) {
    if (record.item.status !== 'canceled') Object.assign(record.item, update);
    record.snapshot = null; // снимок прочитан и изменён загрузкой - больше не нужен
    inFlight = null;
    changed();
    pump();
  }

  function pump() {
    if (inFlight) return;
    const record = records.find(({ item }) => item.status === 'queued');
    if (!record) return;
    inFlight = record;
    record.item.status = 'running';
    changed();
    Promise.resolve()
      .then(() => run({ ...record.item }, record.snapshot))
      .then(
        result => finish(record, { status: 'done', filename: result?.filename }),
        error => finish(record, { status: 'error', error: error?.message || String(error) })
      );
  }

  function enqueue(snapshot) {
    if (records.some(({ item }) => item.slug === snapshot.slug && ACTIVE_STATUSES.includes(item.status))) {
      return { ok: false, reason: 'already-queued' };
    }
    const copy = structuredClone(snapshot); // своя копия: startDownload меняет главы снимка
    records.push({
      snapshot: copy,
      item: {
        id: copy.id,
        slug: copy.slug,
        siteKey: copy.siteKey,
        title: copy.title,
        format: copy.downloadData?.selectedFormat,
        status: 'queued',
        progress: { current: 0, total: 0 }
      }
    });
    changed();
    pump();
    return { ok: true };
  }

  // Ожидающий отменяется сразу; идущий помечается, а следующий начнётся, когда его run завершится
  function cancel(id) {
    const record = find(id);
    if (!record || !ACTIVE_STATUSES.includes(record.item.status)) return;
    record.item.status = 'canceled';
    if (record !== inFlight) record.snapshot = null;
    changed();
  }

  function remove(id) {
    const record = find(id);
    if (!record || (record === inFlight && record.item.status !== 'canceled')) return false;
    records.splice(records.indexOf(record), 1);
    changed();
    return true;
  }

  // extra: поля QueueItem (progress, decision, error, filename); undefined убирает поле
  function setStatus(id, status, extra = {}) {
    const record = find(id);
    if (!record) return;
    Object.assign(record.item, { status }, extra);
    for (const key of Object.keys(extra)) if (extra[key] === undefined) delete record.item[key];
    changed();
  }

  return { enqueue, cancel, remove, setStatus, items };
}
