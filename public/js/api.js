// HTTP-клиент API: JSON, единая обработка ошибок, индикатор загрузки.
export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
    this.fields = details?.fields || null;
  }
}

let inflight = 0;
let bar;
function progress(delta) {
  inflight += delta;
  bar ||= document.body.appendChild(Object.assign(document.createElement('div'), { className: 'loading-bar' }));
  if (inflight > 0) {
    bar.style.opacity = '1';
    bar.style.width = '70%';
  } else {
    bar.style.width = '100%';
    setTimeout(() => {
      if (inflight === 0) {
        bar.style.opacity = '0';
        bar.style.width = '0';
      }
    }, 200);
  }
}

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

function buildUrl(path, query) {
  if (!query) return path;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') sp.set(k, v);
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}

async function request(method, path, { query, body, silent } = {}) {
  if (!silent) progress(1);
  try {
    const res = await fetch(buildUrl(path, query), {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && onUnauthorized && !path.startsWith('/api/auth/login')) onUnauthorized();
      throw new ApiError(res.status, data.error || `Ошибка ${res.status}`, data.details);
    }
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(0, 'Нет связи с сервером ЦУП. Проверьте подключение и повторите.');
  } finally {
    if (!silent) progress(-1);
  }
}

export const api = {
  get: (path, query, opts) => request('GET', path, { query, ...opts }),
  post: (path, body = {}) => request('POST', path, { body }),
  put: (path, body) => request('PUT', path, { body }),
  del: (path) => request('DELETE', path),
  url: buildUrl,
};
