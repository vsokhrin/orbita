// Server-Sent Events: живой поток телеметрии и событий ЦУП для всех подключённых операторов.
export class SseHub {
  constructor() {
    this.clients = new Set();
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) c.res.write(': ping\n\n');
    }, 25_000);
    this.heartbeat.unref();
  }

  handler() {
    return (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      const client = { res, user: req.user, since: Date.now() };
      this.clients.add(client);
      const drop = () => this.clients.delete(client);
      req.on('close', drop);
      res.on('error', drop);
      if (this.onConnect) this.onConnect(client);
    };
  }

  send(client, event, data) {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  broadcast(event, data) {
    if (!this.clients.size) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.res.write(frame);
  }

  /** Принудительно отключить клиентов пользователя (например, после блокировки). */
  disconnectUser(userId) {
    for (const c of this.clients) {
      if (c.user?.id === userId) {
        c.res.end();
        this.clients.delete(c);
      }
    }
  }

  get size() {
    return this.clients.size;
  }

  close() {
    clearInterval(this.heartbeat);
    for (const c of this.clients) c.res.end();
    this.clients.clear();
  }
}
