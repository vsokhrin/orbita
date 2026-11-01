// Демо-версия ОРБИТЫ для GitHub Pages: сервер ЦУП работает прямо в браузере.
// Клиент (public/js/app.js) подключает этот модуль, если в странице есть <meta name="orbita-demo">,
// и направляет в него запросы API и поток событий вместо сети.
import { createBackend } from './backend.js';

export async function startDemo() {
  const version = document.querySelector('meta[name="orbita-demo"]')?.content || 'demo';
  const backend = await createBackend({ version });
  const flush = () => backend.store.flush();
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  return {
    request: backend.request,
    openStream: backend.openStream,
    reset: backend.reset,
    /** Выгрузка CSV: файл формирует демо-сервер, браузер сохраняет его как обычную загрузку. */
    async download(url) {
      const reply = await backend.api.handle('GET', url);
      if (reply.status !== 200) throw new Error(reply.data?.error || `Ошибка ${reply.status}`);
      const name = /filename="([^"]+)"/.exec(reply.headers['Content-Disposition'] || '')?.[1] || 'orbita.csv';
      const href = URL.createObjectURL(new Blob([reply.data], { type: reply.headers['Content-Type'] || 'text/csv' }));
      const a = Object.assign(document.createElement('a'), { href, download: name, hidden: true });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 30_000);
    },
  };
}
