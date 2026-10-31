// Таблица с серверной пагинацией, поиском, фильтрами и сортировкой. Состояние хранится в адресной строке.
import { h, debounce, replace } from '../dom.js';
import { api } from '../api.js';
import { setQuery, getQuery, navigate } from '../router.js';
import { empty, button } from './components.js';
import { fmt, plural } from '../format.js';

/**
 * dataTable({ endpoint, columns, filters, rowHref, onRowClick, actions, csv, pageSize, emptyText, defaultSort, extraQuery, syncUrl })
 */
export function dataTable(opts) {
  const { endpoint, columns, filters = [], rowHref, onRowClick, actions = [], csv = true, pageSize = 25, emptyText = 'Записей нет', syncUrl = true } = opts;
  const initial = syncUrl ? getQuery() : {};
  const q = {
    q: initial.q || '',
    page: Number(initial.page) || 1,
    sort: initial.sort || opts.defaultSort?.sort || '',
    dir: initial.dir || opts.defaultSort?.dir || 'asc',
    limit: pageSize,
  };
  for (const f of filters) q[f.name] = initial[f.name] ?? f.default ?? '';

  const tbody = h('tbody');
  const thead = h('thead');
  const table = h('table', { class: ['data', opts.compact && 'compact'] }, thead, tbody);
  const wrap = h('div', { class: 'table-wrap' }, table);
  const pager = h('div', { class: 'pager' });
  const csvLink = csv ? button('CSV', { iconName: 'download', small: true, href: '#', download: true, title: 'Выгрузить в CSV с текущими фильтрами' }) : null;
  const searchInput = h('input', {
    type: 'search',
    placeholder: opts.searchPlaceholder || 'Поиск',
    value: q.q,
    'aria-label': 'Поиск по таблице',
    oninput: debounce((e) => {
      q.q = e.target.value;
      q.page = 1;
      load();
    }, 300),
  });
  const filterEls = filters.map((f) =>
    h(
      'select',
      {
        'aria-label': f.label,
        onchange: (e) => {
          q[f.name] = e.target.value;
          q.page = 1;
          load();
        },
      },
      h('option', { value: '' }, f.label + ': все'),
      f.options.map((o) => h('option', { value: o.value, selected: String(q[f.name]) === String(o.value) }, o.label)),
    ),
  );
  const toolbar = h('div', { class: 'toolbar' }, opts.search === false ? null : searchInput, filterEls, h('div', { class: 'grow' }), actions, csvLink);

  function renderHead() {
    replace(thead, 
      h(
        'tr',
        null,
        columns.map((c) => {
          const sortKey = c.sort === true ? c.key : c.sort;
          const active = sortKey && q.sort === sortKey;
          const ariaSort = active ? (q.dir === 'desc' ? 'descending' : 'ascending') : null;
          return h(
            'th',
            { class: c.num && 'num', style: c.width ? { width: c.width } : null, 'aria-sort': ariaSort, scope: 'col' },
            sortKey
              ? h(
                  'button',
                  {
                    type: 'button',
                    onclick: () => {
                      if (q.sort === sortKey) q.dir = q.dir === 'asc' ? 'desc' : 'asc';
                      else {
                        q.sort = sortKey;
                        q.dir = c.defaultDir || 'asc';
                      }
                      load();
                    },
                  },
                  c.label,
                  active ? (q.dir === 'asc' ? ' ▲' : ' ▼') : '',
                )
              : c.label,
          );
        }),
      ),
    );
  }

  let lastData = null;
  let seq = 0;
  async function load() {
    const id = ++seq;
    const query = { ...q, ...(opts.extraQuery || {}) };
    if (syncUrl) setQuery({ q: q.q, page: q.page > 1 ? q.page : '', sort: q.sort, dir: q.sort ? q.dir : '', ...Object.fromEntries(filters.map((f) => [f.name, q[f.name]])) });
    if (csvLink) csvLink.href = api.url(endpoint + '.csv', { ...query, page: undefined, limit: undefined });
    renderHead();
    table.classList.add('table-loading');
    try {
      const data = await api.get(endpoint, query, { silent: !!lastData });
      if (id !== seq) return;
      lastData = data;
      renderBody(data);
    } catch (err) {
      if (id !== seq) return;
      replace(tbody, h('tr', null, h('td', { colspan: columns.length }, empty('Не удалось загрузить данные', err.message))));
    } finally {
      if (id === seq) table.classList.remove('table-loading');
    }
  }

  function renderBody(data) {
    if (!data.items.length) {
      replace(tbody, h('tr', null, h('td', { colspan: columns.length }, empty(q.q || filters.some((f) => q[f.name]) ? 'Ничего не найдено' : emptyText, q.q ? 'Измените запрос или сбросьте фильтры.' : opts.emptyHint))));
    } else {
      replace(tbody, 
        ...data.items.map((row) => {
          const href = rowHref?.(row);
          const tr = h(
            'tr',
            {
              class: (href || onRowClick) && 'clickable',
              tabindex: href || onRowClick ? 0 : null,
              onclick: (e) => {
                if (e.target.closest('a, button, input, select')) return;
                if (href) navigate(href);
                else onRowClick?.(row);
              },
              onkeydown: (e) => {
                if (e.key === 'Enter' && e.target === tr) href ? navigate(href) : onRowClick?.(row);
              },
            },
            columns.map((c) => h('td', { class: c.num && 'num' }, c.render ? c.render(row) : row[c.key] ?? '—')),
          );
          return tr;
        }),
      );
    }
    const from = data.total ? (data.page - 1) * data.limit + 1 : 0;
    const to = Math.min(data.total, data.page * data.limit);
    replace(pager, 
      h('span', null, data.total ? `${fmt.int(from)}–${fmt.int(to)} из ${fmt.int(data.total)} ${plural(data.total, 'записи', 'записей', 'записей')}` : ''),
      h('span', { class: 'spacer' }),
      data.pages > 1
        ? [
            button('Назад', { small: true, disabled: data.page <= 1, onClick: () => ((q.page = data.page - 1), load()) }),
            h('span', { class: 'tabular' }, `${data.page} / ${data.pages}`),
            button('Далее', { small: true, disabled: data.page >= data.pages, onClick: () => ((q.page = data.page + 1), load()) }),
          ]
        : null,
    );
    opts.onData?.(data);
  }

  load();
  const el = h('div', { class: 'datatable' }, toolbar, h('div', { class: 'panel' }, wrap, pager));
  return { el, reload: load, query: q };
}
