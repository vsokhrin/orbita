// Страница «не найдено».
import { h } from '../dom.js';

export default async function notFound() {
  return h(
    'div',
    { class: 'page not-found' },
    h('h1', null, 'Такой страницы нет'),
    h('p', { class: 'muted' }, 'Адрес набран с ошибкой или раздел был перемещён.'),
    h('a', { class: 'btn primary', href: '/' }, 'Перейти к обзору'),
  );
}
