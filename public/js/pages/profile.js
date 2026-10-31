// Профиль: сведения о пользователе и смена пароля.
import { h } from '../dom.js';
import { api } from '../api.js';
import { state, dict } from '../state.js';
import { pageHead, panel, kv, button, toast } from '../ui/components.js';
import { buildForm, collect, showErrors } from '../ui/form.js';

export default async function profile() {
  const u = state.user;
  const error = h('div', { class: 'form-error hidden', role: 'alert' });
  const form = buildForm(
    [
      { name: 'current', label: 'Текущий пароль', type: 'password', required: true, span: 2, autocomplete: 'current-password' },
      { name: 'next', label: 'Новый пароль', type: 'password', required: true, help: 'Не короче 8 символов, буквы и цифры' },
      { name: 'repeat', label: 'Повторите новый пароль', type: 'password', required: true },
    ],
    {},
    {
      onSubmit: async () => {
        const d = collect(form);
        error.classList.add('hidden');
        if (d.next !== d.repeat) return showErrors(form, { repeat: 'Пароли не совпадают' });
        try {
          await api.post('/api/auth/password', { current: d.current, next: d.next });
          showErrors(form, {});
          form.reset();
          toast({ title: 'Пароль изменён', body: 'Остальные сессии завершены.', tone: 'green' });
        } catch (err) {
          showErrors(form, err.fields || {});
          if (!err.fields) {
            error.textContent = err.message;
            error.classList.remove('hidden');
          }
        }
      },
    },
  );
  return h(
    'div',
    { class: 'page' },
    pageHead({ title: 'Профиль' }),
    h(
      'div',
      { class: 'grid two' },
      panel({ title: 'Учётная запись', body: kv([['Имя', u.fullName], ['Логин', u.username], ['Роль', dict('roles', u.role)]]) }),
      panel({ title: 'Смена пароля', body: [error, form, h('div', { style: { marginTop: '14px' } }, button('Сменить пароль', { kind: 'primary', onClick: () => form.requestSubmit() }))] }),
    ),
  );
}
