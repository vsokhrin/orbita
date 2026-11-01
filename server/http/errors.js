// Ошибки HTTP. Модуль без зависимостей от Node.js — используется и сервером, и демо-версией в браузере.
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const notFound = (msg = 'Запись не найдена') => new HttpError(404, msg);
export const forbidden = (msg = 'Недостаточно прав') => new HttpError(403, msg);
