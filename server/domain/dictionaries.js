// Справочники предметной области: коды значений и их подписи для интерфейса.
// Единый источник правды — фронтенд получает их через GET /api/meta.

export const SPACECRAFT_TYPES = {
  station: 'Орбитальная станция',
  earth_observation: 'Дистанционное зондирование',
  communication: 'Связь и ретрансляция',
  navigation: 'Навигация',
  science: 'Научный',
  cargo: 'Грузовой корабль',
  technology: 'Технологический',
};

export const SPACECRAFT_STATUSES = {
  planned: 'Готовится к запуску',
  active: 'Работает штатно',
  standby: 'Резерв',
  safe_mode: 'Безопасный режим',
  decommissioned: 'Выведен из эксплуатации',
  lost: 'Утрачен',
};

export const STATION_STATUSES = {
  online: 'На связи',
  maintenance: 'Обслуживание',
  offline: 'Отключена',
};

export const MISSION_STATUSES = {
  planning: 'Планирование',
  preparation: 'Подготовка',
  active: 'Выполняется',
  completed: 'Завершена',
  aborted: 'Прервана',
};

export const PRIORITIES = {
  low: 'Низкий',
  medium: 'Средний',
  high: 'Высокий',
  critical: 'Критический',
};

export const CREW_POSITIONS = {
  commander: 'Командир',
  flight_engineer: 'Бортинженер',
  mission_specialist: 'Специалист полёта',
  payload_specialist: 'Специалист по полезной нагрузке',
};

export const CREW_ROLES = { ...CREW_POSITIONS, backup: 'Дублёр' };

export const CREW_STATUSES = {
  active: 'В отряде',
  training: 'Подготовка',
  in_flight: 'В полёте',
  reserve: 'Резерв',
  retired: 'Завершил карьеру',
};

export const LAUNCH_STATUSES = {
  scheduled: 'Запланирован',
  go: 'Готовность',
  hold: 'Задержка',
  success: 'Успешно',
  failure: 'Авария',
  scrubbed: 'Отменён',
};

export const INCIDENT_SEVERITIES = {
  info: 'Информация',
  warning: 'Предупреждение',
  critical: 'Авария',
};

export const INCIDENT_STATUSES = {
  open: 'Открыт',
  acknowledged: 'Принят в работу',
  resolved: 'Закрыт',
};

export const COMMAND_STATUSES = {
  queued: 'В очереди',
  uplinked: 'Передана на борт',
  executed: 'Выполнена',
  failed: 'Ошибка',
  cancelled: 'Отменена',
  expired: 'Истёк срок',
};

export const ROLES = {
  admin: 'Администратор',
  operator: 'Оператор ЦУП',
  observer: 'Наблюдатель',
};

// Типы команд: подпись, описание, параметры и неисправность, которую команда устраняет.
export const COMMAND_TYPES = {
  PING: {
    label: 'Тестовый сеанс связи',
    description: 'Запрос квитанции от бортового комплекса управления.',
  },
  SUN_POINTING: {
    label: 'Ориентация на Солнце',
    description: 'Разворот панелей солнечных батарей на Солнце: максимальная генерация, целевая аппаратура не работает.',
    fixes: ['attitude'],
  },
  NADIR_POINTING: {
    label: 'Ориентация в надир',
    description: 'Штатная ориентация для съёмки и связи с Землёй.',
  },
  PAYLOAD_ON: {
    label: 'Включить целевую аппаратуру',
    description: 'Включение полезной нагрузки: растёт энергопотребление и нагрев.',
  },
  PAYLOAD_OFF: {
    label: 'Выключить целевую аппаратуру',
    description: 'Отключение полезной нагрузки для экономии энергии и охлаждения.',
    fixes: ['thermal'],
  },
  REBOOT_OBC: {
    label: 'Перезагрузка БКУ',
    description: 'Перезапуск бортового комплекса управления. Устраняет сбои памяти.',
    fixes: ['seu'],
  },
  ORBIT_CORRECTION: {
    label: 'Коррекция орбиты',
    description: 'Включение двигательной установки: изменение высоты орбиты на заданную величину.',
    params: { delta_km: { label: 'Изменение высоты, км', type: 'number', min: -100, max: 100, default: 5 } },
  },
  SAFE_MODE: {
    label: 'Перевод в безопасный режим',
    description: 'Минимальное энергопотребление, полезная нагрузка отключена.',
  },
  NOMINAL_MODE: {
    label: 'Возврат в штатный режим',
    description: 'Выход из безопасного режима после устранения неисправностей.',
  },
};

// Виды автоматически обнаруживаемых неисправностей
export const FAULTS = {
  battery_low: { title: 'Низкий заряд аккумуляторной батареи', short: 'Низкий заряд АКБ', severity: 'warning', fix: 'SUN_POINTING' },
  battery_critical: { title: 'Критический разряд АКБ — автоматический переход в безопасный режим', short: 'Критический разряд АКБ', severity: 'critical', fix: 'SUN_POINTING' },
  overheat: { title: 'Перегрев приборного отсека', short: 'Перегрев', severity: 'critical', fix: 'PAYLOAD_OFF' },
  seu: { title: 'Одиночный сбой (SEU) в памяти БКУ', short: 'Сбой памяти БКУ', severity: 'warning', fix: 'REBOOT_OBC' },
  attitude: { title: 'Потеря ориентации: рост угловых скоростей', short: 'Потеря ориентации', severity: 'critical', fix: 'SUN_POINTING' },
  thermal: { title: 'Рост температуры целевой аппаратуры', short: 'Нагрев ЦА', severity: 'warning', fix: 'PAYLOAD_OFF' },
};

export const LAUNCH_SITES = ['Байконур', 'Восточный', 'Плесецк', 'Куру', 'Мыс Канаверал', 'Цзюцюань', 'Танэгасима', 'Шрихарикота'];

export function allDictionaries() {
  return {
    spacecraftTypes: SPACECRAFT_TYPES,
    spacecraftStatuses: SPACECRAFT_STATUSES,
    stationStatuses: STATION_STATUSES,
    missionStatuses: MISSION_STATUSES,
    priorities: PRIORITIES,
    crewPositions: CREW_POSITIONS,
    crewRoles: CREW_ROLES,
    crewStatuses: CREW_STATUSES,
    launchStatuses: LAUNCH_STATUSES,
    incidentSeverities: INCIDENT_SEVERITIES,
    incidentStatuses: INCIDENT_STATUSES,
    commandStatuses: COMMAND_STATUSES,
    commandTypes: COMMAND_TYPES,
    faults: FAULTS,
    roles: ROLES,
    launchSites: LAUNCH_SITES,
  };
}
