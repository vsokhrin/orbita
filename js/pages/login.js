// Экран входа: слева живая Земля с терминатором (реальное положение Солнца), справа форма.
import { h } from '../dom.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { WorldMap } from '../map/worldmap.js';
import { subsolarPoint } from '../../shared/orbit.js';
import { fmt } from '../format.js';
import { DEMO } from '../base.js';

export function renderLogin({ onSuccess, message }) {
  const mapBox = h('div', { class: 'login-map' });
  const utc = h('b');
  const sun = h('b');
  const tick = () => {
    const now = Date.now();
    utc.textContent = fmt.utc(now);
    const p = subsolarPoint(now);
    sun.textContent = fmt.coord(p.lat, p.lon);
  };
  tick();
  const clock = setInterval(tick, 1000);

  const error = h('div', { class: 'form-error' + (message ? '' : ' hidden'), role: 'alert' }, message || '');
  const user = h('input', { type: 'text', id: 'login-user', name: 'username', autocomplete: 'username', required: true, autofocus: true });
  const pass = h('input', { type: 'password', id: 'login-pass', name: 'password', autocomplete: 'current-password', required: true });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Войти');

  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        error.classList.add('hidden');
        submit.disabled = true;
        try {
          const r = await api.post('/api/auth/login', { username: user.value, password: pass.value });
          clearInterval(clock);
          map.destroy();
          onSuccess(r.user);
        } catch (err) {
          error.textContent = err.message;
          error.classList.remove('hidden');
          pass.select();
        } finally {
          submit.disabled = false;
        }
      },
    },
    h('h2', null, 'Вход в систему'),
    h('p', { class: 'muted', style: { margin: 0 } }, 'Доступ только для персонала центра управления полётами.'),
    error,
    h('div', { class: 'field' }, h('label', { for: 'login-user' }, 'Логин'), user),
    h('div', { class: 'field' }, h('label', { for: 'login-pass' }, 'Пароль'), pass),
    submit,
    state.meta?.demo ? demoAccounts(user, pass) : null,
    DEMO
      ? h(
          'p',
          { class: 'muted small', style: { margin: 0 } },
          'Это демо-версия: сервер ЦУП работает прямо в вашем браузере, данные хранятся только в нём. Полная версия — Node.js и PostgreSQL в Docker, ',
          h('a', { href: 'https://github.com/vsokhrin/orbita', target: '_blank', rel: 'noopener' }, 'исходный код на GitHub'),
          '.',
        )
      : null,
  );

  const el = h(
    'div',
    { class: 'login' },
    h(
      'section',
      { class: 'login-screen', 'aria-label': 'Земля сейчас' },
      h('div', { class: 'caption' }, h('h1', null, 'ОРБИТА'), h('p', null, 'Информационная система центра управления полётами: флот, миссии, сеансы связи и телеметрия в реальном времени.')),
      mapBox,
      h('div', { class: 'readline' }, h('span', null, 'UTC ', utc), h('span', null, 'Подсолнечная точка ', sun)),
    ),
    h('section', { class: 'login-form' }, form),
  );
  const map = new WorldMap(mapBox, { labels: false, stations: false, links: false, footprint: false, tracks: 'none' });
  return el;
}

function demoAccounts(user, pass) {
  const rows = [
    ['admin', 'admin2026', 'Администратор'],
    ['operator', 'operator2026', 'Оператор ЦУП'],
    ['observer', 'observer2026', 'Наблюдатель'],
  ];
  return h(
    'div',
    { class: 'demo' },
    'Демонстрационные учётные записи — нажмите, чтобы подставить:',
    h(
      'table',
      null,
      h(
        'tbody',
        null,
        rows.map(([u, p, role]) =>
          h(
            'tr',
            null,
            h('td', null, h('button', { type: 'button', onclick: () => ((user.value = u), (pass.value = p), pass.focus()) }, u)),
            h('td', { class: 'muted' }, p),
            h('td', { class: 'muted' }, role),
          ),
        ),
      ),
    ),
  );
}
