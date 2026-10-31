// Выгрузка в CSV, совместимая с русской локалью Excel: UTF-8 с BOM и разделитель «;».
export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    // защита от CSV-инъекций формул в Excel
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = "'" + s;
    return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [columns.map((c) => esc(c.label)).join(';')];
  for (const row of rows) lines.push(columns.map((c) => esc(c.value ? c.value(row) : row[c.key])).join(';'));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
