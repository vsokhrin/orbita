// Пароли и токены в демо-версии: WebCrypto (PBKDF2-SHA-256) вместо scrypt из Node.js.
// В localStorage хранится только хэш пароля и SHA-256 от токена сессии — как на сервере.
const ITERATIONS = 120_000;
const enc = new TextEncoder();

function subtle() {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('Демо-версии нужен защищённый контекст браузера (https:// или localhost)');
  return s;
}

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password, salt, iterations) {
  const key = await subtle().importKey('raw', enc.encode(String(password).normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  return subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(await derive(password, salt, ITERATIONS))}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const expected = unb64(parts[3]);
  const actual = new Uint8Array(await derive(password, unb64(parts[2]), Number(parts[1])));
  let diff = expected.length ^ actual.length;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
  return diff === 0;
}

export function randomToken() {
  return b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);
}

export async function sha256(text) {
  const digest = await subtle().digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
