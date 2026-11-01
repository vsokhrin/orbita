// Поток событий демо-версии: вместо Server-Sent Events — источник внутри страницы
// с тем же интерфейсом, что у EventSource (onopen, onerror, readyState, addEventListener, close).
// Данные проходят через JSON, как по сети: страница получает копии, а не объекты движка.

export class DemoHub {
  constructor() {
    this.clients = new Set();
  }

  get size() {
    return this.clients.size;
  }

  broadcast(type, data) {
    if (!this.clients.size) return;
    const payload = JSON.stringify(data);
    for (const c of this.clients) c.deliver(type, payload);
  }

  /** На сервере закрывает потоки пользователя; в демо пользователь в вкладке один — делать нечего. */
  disconnectUser() {}

  open() {
    return new DemoEventSource(this);
  }
}

class DemoEventSource extends EventTarget {
  constructor(hub) {
    super();
    this.hub = hub;
    this.readyState = 0;
    this.onopen = null;
    this.onerror = null;
    hub.clients.add(this);
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    }, 0);
  }

  deliver(type, payload) {
    setTimeout(() => {
      if (this.readyState === 1) this.dispatchEvent(new MessageEvent(type, { data: payload }));
    }, 0);
  }

  close() {
    this.readyState = 2;
    this.hub.clients.delete(this);
  }
}
