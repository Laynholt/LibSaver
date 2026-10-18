// toast.js - Модуль для toast уведомлений

let toastQueue = [];
const MAX_TOASTS = 2;
const toastTimers = new Map(); // Храним ссылки на таймеры
const toastSlots = new Map(); // Храним занятые слоты (0, 1)
const TOAST_HEIGHT = 24; // Высота одного toast + отступ
const TOAST_GAP = 8; // Отступ между toast

// Показать toast уведомление
function showToast(message, type = 'success', duration = 1200, onClick = null) {
  const toast = {
    message,
    type,
    id: Date.now(),
    duration,
    onClick
  };

  // Ограничиваем количество toast в очереди
  if (toastQueue.length >= MAX_TOASTS) {
    return; // Не удаляем старый, просто игнорируем новый
  }

  toastQueue.push(toast);
  processToastQueue();
}

// Обработка очереди toast
function processToastQueue() {
  if (toastQueue.length === 0) return;

  // Проверяем количество видимых toast
  const visibleToasts = document.querySelectorAll('.toast.show');
  if (visibleToasts.length >= MAX_TOASTS) {
    return; // Ждём пока освободится место
  }

  const toastData = toastQueue.shift();
  createToastElement(toastData);
}

// Создание элемента toast
function createToastElement(toastData) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${toastData.type}`;
  toast.id = `toast-${toastData.id}`;

  let icon = 'fa-check';
  if (toastData.type === 'error') icon = 'fa-xmark';
  if (toastData.type === 'update') icon = 'fa-download';

  // Текст - через textContent: в сообщении бывает текст ошибки
  const iconEl = document.createElement('i');
  iconEl.className = `fa-solid ${icon}`;
  const text = document.createElement('span');
  text.textContent = toastData.message;
  toast.append(iconEl, text);

  // Если есть onClick, делаем кликабельным
  if (toastData.onClick) {
    toast.style.cursor = 'pointer';
    toast.addEventListener('click', () => {
      toastData.onClick();
      hideToast(toast);
    });
  }

  container.appendChild(toast);

  // Находим свободный слот
  let slot = 0;
  while (toastSlots.has(slot)) {
    slot++;
  }

  // Занимаем слот
  toastSlots.set(slot, toastData.id);
  toast.dataset.slot = slot;

  // Вычисляем позицию в зависимости от слота
  const position = slot * (TOAST_HEIGHT + TOAST_GAP);
  toast.style.top = `${position}px`;

  // Force reflow
  toast.offsetHeight;

  // Показываем toast
  toast.classList.add('show');

  // Автоматически скрываем через duration или 2 секунды по умолчанию
  const duration = toastData.duration || 1200;
  const timer = setTimeout(() => {
    hideToast(toast);
  }, duration);
  toastTimers.set(toast.id, timer);
}

// Скрытие toast
function hideToast(toast) {
  // Очищаем таймер если есть
  if (toastTimers.has(toast.id)) {
    clearTimeout(toastTimers.get(toast.id));
    toastTimers.delete(toast.id);
  }

  // Освобождаем слот
  const slot = toast.dataset.slot;
  if (slot !== undefined) {
    toastSlots.delete(parseInt(slot));
  }

  toast.classList.remove('show');
  toast.classList.add('hide');

  setTimeout(() => {
    toast.remove();
    processToastQueue();
  }, 200);
}
