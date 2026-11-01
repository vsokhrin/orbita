// Живой поток ЦУП (Server-Sent Events): телеметрия, инциденты, команды, запуски, изменения флота.
// Источник событий можно подменить: демо-версия отдаёт поток из «сервера» внутри браузера.
let streamFactory = () => new EventSource('/api/stream');
export function setStreamFactory(fn) {
  streamFactory = fn;
}

class LiveStream extends EventTarget {
  constructor() {
    super();
    this.source = null;
    this.state = 'idle';
    this.telemetry = new Map();
    this.lastTs = 0;
  }

  connect() {
    if (this.source) return;
    this.setState('connecting');
    const es = streamFactory();
    this.source = es;
    es.onopen = () => this.setState('online');
    es.onerror = () => this.setState(es.readyState === EventSource.CLOSED ? 'offline' : 'connecting');
    for (const type of ['telemetry', 'incident', 'command', 'launch', 'fleet']) {
      es.addEventListener(type, (e) => {
        let data;
        try {
          data = JSON.parse(e.data);
        } catch {
          return;
        }
        if (type === 'telemetry') {
          this.lastTs = data.ts;
          this.telemetry = new Map(data.items.map((i) => [i.id, i]));
        }
        this.dispatchEvent(new CustomEvent(type, { detail: data }));
      });
    }
  }

  disconnect() {
    this.source?.close();
    this.source = null;
    this.setState('idle');
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.dispatchEvent(new CustomEvent('state', { detail: s }));
  }

  /** Подписка с автоматической отпиской через Scope страницы */
  on(type, fn, scope) {
    const handler = (e) => fn(e.detail);
    this.addEventListener(type, handler);
    const off = () => this.removeEventListener(type, handler);
    scope?.add(off);
    return off;
  }
}

export const live = new LiveStream();
