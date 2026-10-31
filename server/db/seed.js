// Начальное наполнение БД: вымышленный флот агентства, наземные станции, экипаж, миссии,
// расписание запусков, история инцидентов и команд, а также сутки телеметрии «задним числом».
import * as O from '../../shared/orbit.js';
import { hashPassword } from '../auth/passwords.js';
import { initialState, stationsForModel, step, SIMULATED_STATUSES } from '../sim/model.js';
import { insertTelemetry } from '../sim/engine.js';
import { FAULTS, COMMAND_TYPES } from '../domain/dictionaries.js';
import { logger } from '../lib/logger.js';

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATIONS = [
  ['MOW', 'Медвежьи Озёра', 'Россия', 55.868, 37.952, 160, 64, 'S,X,Ka', 5, 'online', 'Головной пункт дальней космической связи под Москвой.'],
  ['USS', 'Уссурийск', 'Россия', 44.016, 131.757, 120, 70, 'S,X', 5, 'online', 'Восточный пункт: ведёт КА над Тихим океаном.'],
  ['NSK', 'Новосибирск', 'Россия', 55.03, 82.92, 150, 12, 'S', 7, 'online', null],
  ['KGD', 'Калининград', 'Россия', 54.71, 20.51, 20, 12, 'S', 5, 'maintenance', 'Замена облучателя и юстировка антенны.'],
  ['PKC', 'Петропавловск-Камчатский', 'Россия', 53.04, 158.65, 80, 12, 'S,X', 5, 'online', null],
  ['SVB', 'Шпицберген', 'Норвегия', 78.23, 15.39, 450, 13, 'S,X', 5, 'online', 'Высокоширотная станция: видит каждый виток полярных орбит.'],
  ['CAN', 'Канберра', 'Австралия', -35.4, 148.98, 680, 34, 'S,X', 8, 'online', null],
  ['SCL', 'Сантьяго', 'Чили', -33.15, -70.67, 720, 12, 'S', 5, 'online', null],
  ['KOU', 'Куру', 'Французская Гвиана', 5.25, -52.8, 15, 15, 'S', 5, 'online', 'Станция поддержки запусков с экваториального космодрома.'],
  ['HBK', 'Хартебестхук', 'ЮАР', -25.89, 27.69, 1415, 15, 'S,X', 5, 'online', null],
  ['MKE', 'Мауна-Кеа', 'США', 19.82, -155.47, 3900, 12, 'S', 10, 'maintenance', 'Плановое обслуживание приводов.'],
  ['FBK', 'Фэрбанкс', 'США', 64.86, -147.85, 140, 11, 'S,X', 5, 'offline', 'Аренда канала приостановлена.'],
];

const AGENCY = 'Агентство «Орбита»';

function spacecraftList(now) {
  const geo = (lon) => O.meanAnomalyForLongitude(lon, 0, 0, now).toFixed(3);
  // [code, name, type, status, operator, launch(days ago), mass, power, fuel, perigee, apogee, inc, raan, argp, M0, color, description]
  return [
    ['KV-1', 'Ковчег', 'station', 'active', AGENCY, 2210, 418000, 84000, 3600, 412, 421, 51.64, 210, 35, 0, '#2a78d6', 'Пилотируемая орбитальная станция. Постоянный экипаж — четыре человека.'],
    ['PL-7', 'Пеликан-7', 'cargo', 'active', AGENCY, 26, 7200, 1200, 610, 410, 418, 51.64, 210, 35, 352, '#6250d6', 'Грузовой корабль снабжения, пристыкован к станции «Ковчег».'],
    ['SK-1', 'Сокол-1', 'earth_observation', 'active', 'НИИ дистанционного зондирования', 1450, 1250, 2400, 86, 698, 703, 98.2, 45, 90, 0, '#1baf7a', 'Оптико-электронная съёмка поверхности с разрешением 0,7 м.'],
    ['SK-2', 'Сокол-2', 'earth_observation', 'active', 'НИИ дистанционного зондирования', 920, 1270, 2400, 102, 699, 704, 98.2, 45, 90, 180, '#199e70', 'Радиолокационная съёмка всепогодная, мониторинг ледовой обстановки.'],
    ['SK-3', 'Сокол-3', 'earth_observation', 'planned', 'НИИ дистанционного зондирования', null, 1310, 2600, 140, 698, 704, 98.2, 45, 90, 90, '#008300', 'Третий аппарат группировки. Готовится к запуску с космодрома Восточный.'],
    ['VG-1', 'Вега-Н1', 'navigation', 'active', 'НПО «Навигатор»', 1820, 1450, 1600, 40, 19100, 19140, 64.8, 15, 0, 0, '#eb6834', 'Навигационный КА, плоскость 1.'],
    ['VG-2', 'Вега-Н2', 'navigation', 'active', 'НПО «Навигатор»', 1460, 1450, 1600, 52, 19100, 19140, 64.8, 135, 0, 40, '#d95926', 'Навигационный КА, плоскость 2.'],
    ['VG-3', 'Вега-Н3', 'navigation', 'standby', 'НПО «Навигатор»', 600, 1460, 1650, 61, 19100, 19140, 64.8, 255, 0, 80, '#c98500', 'Навигационный КА, плоскость 3. Орбитальный резерв.'],
    ['LG-5', 'Луч-5Г', 'communication', 'active', 'АО «Ретранслятор»', 3100, 3200, 6000, 210, 35786, 35786, 0.05, 0, 0, geo(95), '#e34948', 'Геостационарный ретранслятор, точка стояния 95° в. д. Обеспечивает связь со станцией «Ковчег».'],
    ['BV-M', 'Буревестник-М', 'communication', 'active', 'Служба космической метеорологии', 2400, 2900, 4200, 160, 35786, 35786, 0.05, 0, 0, geo(-14.5), '#e87ba4', 'Геостационарный метеоспутник, точка стояния 14,5° з. д.'],
    ['PN-1', 'Полярник', 'communication', 'active', AGENCY, 1300, 1800, 3000, 75, 650, 39500, 63.4, 80, 270, 20, '#eda100', 'Высокоэллиптическая орбита типа «Молния»: связь в Арктике.'],
    ['AT-1', 'Астра-Т', 'science', 'active', 'Институт космических наблюдений', 1970, 11200, 2800, 0, 535, 545, 28.5, 300, 0, 120, '#3987e5', 'Орбитальный телескоп рентгеновского и ультрафиолетового диапазона.'],
    ['IK-1', 'Искра-Куб', 'technology', 'safe_mode', 'Университет «Звезда»', 210, 4, 30, 0, 480, 505, 97.4, 330, 0, 200, '#9085e9', 'Студенческий наноспутник формата 3U: отработка солнечного паруса.'],
    ['ZN-2', 'Зонд-2', 'science', 'decommissioned', 'Институт космических наблюдений', 5300, 900, 800, 0, 600, 620, 81.0, 120, 0, 60, '#898781', 'Исследование ионосферы. Программа завершена, КА пассивен.'],
    ['PI-L', 'Пионер-Л', 'science', 'planned', AGENCY, null, 1800, 1900, 950, 200, 200, 51.6, 0, 0, 0, '#86b6ef', 'Автоматическая станция для полёта к Луне. Опорная орбита перед разгоном.'],
  ];
}

const CREW = [
  ['Андрей Воронцов', 'Альтаир', 'commander', 'in_flight', '1984-03-12', 'Россия', 3, 8760, 6, 'Лётчик-испытатель. Командир экспедиции-14 на станции «Ковчег».'],
  ['Марина Ковалёва', 'Вега', 'flight_engineer', 'in_flight', '1989-07-02', 'Россия', 2, 4300, 2, 'Инженер-механик, специалист по системам жизнеобеспечения.'],
  ['Тимур Сафин', 'Ригель', 'flight_engineer', 'in_flight', '1991-11-23', 'Россия', 1, 2100, 1, 'Инженер по бортовой электронике и связи.'],
  ['Луис Ортега', 'Кондор', 'payload_specialist', 'in_flight', '1987-05-30', 'Испания', 1, 2050, 0, 'Астрофизик партнёрского агентства, ведёт эксперименты с биоматериалами.'],
  ['Елена Громова', 'Лира', 'commander', 'active', '1982-09-18', 'Россия', 2, 5200, 3, 'Дублёр командира текущей экспедиции.'],
  ['Дмитрий Орлов', 'Сириус', 'mission_specialist', 'training', '1993-01-07', 'Россия', 0, 0, 0, 'Кандидат в космонавты, проходит общекосмическую подготовку.'],
  ['Анна Белова', 'Капелла', 'payload_specialist', 'training', '1995-04-14', 'Россия', 0, 0, 0, 'Биолог, готовит эксперименты для лунной программы.'],
  ['Игорь Лебедев', 'Антарес', 'flight_engineer', 'reserve', '1980-12-01', 'Россия', 1, 1450, 1, null],
  ['Ксения Морозова', 'Денеб', 'mission_specialist', 'active', '1988-08-25', 'Россия', 1, 3000, 1, 'Специалист по робототехническим манипуляторам.'],
  ['Павел Зуев', 'Арктур', 'commander', 'retired', '1968-02-19', 'Россия', 4, 12500, 9, 'Ветеран отряда, сейчас — руководитель полётов.'],
];

export async function seed(db, { adminPassword, demoUsers = true } = {}) {
  const exists = await db.one('SELECT count(*)::int AS n FROM users');
  if (exists.n > 0) return false;
  logger.info('Пустая БД — заполняю начальными данными…');
  const rnd = mulberry32(20261031);
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const day = 86_400_000;
  const dateAgo = (days) => (days === null ? null : new Date(now - days * day).toISOString().slice(0, 10));

  await db.transaction(async (tx) => {
    // пользователи
    const users = [['admin', 'Администратор системы', 'admin', adminPassword]];
    if (demoUsers) {
      users.push(['operator', 'Дежурный оператор ЦУП', 'operator', 'operator2026']);
      users.push(['observer', 'Наблюдатель от заказчика', 'observer', 'observer2026']);
      users.push(['zuev', 'Павел Зуев', 'operator', 'flight-director-1']);
    }
    const userIds = {};
    for (const [username, fullName, role, pw] of users) {
      const u = await tx.one(
        'INSERT INTO users (username, full_name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id',
        [username, fullName, role, await hashPassword(pw)],
      );
      userIds[username] = u.id;
    }
    const opId = userIds.operator ?? userIds.admin;

    // станции
    const stationIds = {};
    for (const s of STATIONS) {
      const r = await tx.one(
        `INSERT INTO ground_stations (code, name, country, latitude, longitude, altitude_m, antenna_diameter_m, bands, min_elevation_deg, status, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        s,
      );
      stationIds[s[0]] = r.id;
    }

    // КА
    const sc = {};
    for (const s of spacecraftList(now)) {
      const [code, name, type, status, operator, launchedDaysAgo, mass, power, fuel, per, apo, inc, raan, argp, m0, color, descr] = s;
      const r = await tx.one(
        `INSERT INTO spacecraft (code, name, type, status, operator, launch_date, mass_kg, power_w, fuel_kg, perigee_km, apogee_km,
                                 inclination_deg, raan_deg, arg_perigee_deg, mean_anomaly_deg, epoch, color, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [code, name, type, status, operator, dateAgo(launchedDaysAgo), mass, power, fuel, per, apo, inc, raan, argp, m0, iso(now), color, descr],
      );
      sc[code] = r;
    }

    // миссии
    const missions = [
      ['EXP-14', 'Экспедиция-14 на станции «Ковчег»', 'Научная программа из 46 экспериментов, два выхода в открытый космос, приём грузового корабля.', 'KV-1', 'active', 'high', -96, 86, 62, 1840, 'П. Зуев'],
      ['SUP-7', 'Снабжение станции: «Пеликан-7»', 'Доставка 2,4 т грузов, дозаправка двигательной установки станции.', 'PL-7', 'active', 'medium', -26, 64, 40, 310, 'П. Зуев'],
      ['FIRE-26', 'Мониторинг лесных пожаров', 'Ежедневная съёмка лесного фонда Сибири и Дальнего Востока, оперативные карты очагов.', 'SK-1', 'active', 'high', -180, 185, 45, 120, 'А. Кириллов'],
      ['ICE-NSR', 'Ледовая обстановка Северного морского пути', 'Радиолокационная съёмка трассы СМП, прогноз ледовых полей для навигации.', 'SK-2', 'active', 'medium', -400, 330, 70, 95, 'А. Кириллов'],
      ['NAV-DEP', 'Развёртывание группировки «Вега»', 'Ввод трёх навигационных КА в трёх орбитальных плоскостях.', 'VG-1', 'active', 'critical', -1900, 60, 85, 2600, 'Р. Ахмедов'],
      ['RLY-95', 'Ретрансляция для станции «Ковчег»', 'Непрерывный канал связи станции с ЦУП через геостационарный ретранслятор.', 'LG-5', 'active', 'high', -3100, null, 100, 870, 'Р. Ахмедов'],
      ['SKY-X', 'Рентгеновский обзор неба', 'Полный обзор неба в диапазоне 0,3–10 кэВ, каталог новых источников.', 'AT-1', 'active', 'medium', -1960, 700, 33, 1450, 'Е. Сомова'],
      ['SK3-COM', 'Ввод в строй «Сокол-3»', 'Запуск, вывод на рабочую орбиту и лётные испытания третьего аппарата группировки.', 'SK-3', 'preparation', 'high', -60, 120, 90, 140, 'А. Кириллов'],
      ['LUNA-P', 'Пионер-Л: перелёт к Луне', 'Посадка в районе южного полюса Луны, исследование реголита.', 'PI-L', 'planning', 'medium', 13, 210, 15, 3900, 'Е. Сомова'],
      ['ISKRA', 'Студенческий спутник «Искра»', 'Отработка раскрытия солнечного паруса и обучение студентов управлению КА.', 'IK-1', 'active', 'low', -210, 150, 55, 4, 'Университет «Звезда»'],
      ['ION-2', 'Исследование ионосферы', 'Зондирование ионосферы, программа завершена в полном объёме.', 'ZN-2', 'completed', 'low', -5300, -400, 100, 230, 'Е. Сомова'],
    ];
    const missionIds = {};
    for (const [code, name, objective, scCode, status, priority, startDays, endDays, progress, budget, director] of missions) {
      const r = await tx.one(
        `INSERT INTO missions (code, name, objective, spacecraft_id, status, priority, start_date, end_date, progress, budget_mln, flight_director)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [code, name, objective, sc[scCode]?.id ?? null, status, priority, dateAgo(-startDays), endDays === null ? null : dateAgo(-endDays), progress, budget, director],
      );
      missionIds[code] = r.id;
    }

    // экипаж
    const crewIds = [];
    for (const c of CREW) {
      const r = await tx.one(
        `INSERT INTO crew_members (full_name, call_sign, position, status, birth_date, nationality, flights_count, hours_in_space, eva_count, bio)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        c,
      );
      crewIds.push(r.id);
    }
    const assign = [
      ['EXP-14', 0, 'commander'], ['EXP-14', 1, 'flight_engineer'], ['EXP-14', 2, 'flight_engineer'], ['EXP-14', 3, 'payload_specialist'],
      ['EXP-14', 4, 'backup'], ['LUNA-P', 4, 'commander'], ['LUNA-P', 6, 'payload_specialist'], ['LUNA-P', 5, 'mission_specialist'],
      ['SUP-7', 8, 'mission_specialist'],
    ];
    for (const [m, ci, role] of assign) {
      await tx.query('INSERT INTO mission_crew (mission_id, crew_id, role) VALUES ($1,$2,$3)', [missionIds[m], crewIds[ci], role]);
    }

    // запуски
    const launches = [
      ['Ангара-А5 / «Сокол-3»', 'Ангара-А5', 'Восточный', now + 25 * 60_000, 0, 'go', 'SK-3', 'SK3-COM', 'Ближайший пуск. Решение о готовности принято госкомиссией.'],
      ['Союз-2.1а / «Пеликан-8»', 'Союз-2.1а', 'Байконур', now + 4 * day + 3.2 * 3600_000, 0, 'scheduled', null, null, 'Следующий грузовой корабль к станции «Ковчег».'],
      ['Союз-2.1б / «Пионер-Л»', 'Союз-2.1б + РБ «Фрегат»', 'Байконур', now + 13 * day + 7.5 * 3600_000, 12, 'scheduled', 'PI-L', 'LUNA-P', 'Окно старта определяется положением Луны.'],
      ['Ангара-1.2 / «Искра-Куб-2»', 'Ангара-1.2', 'Плесецк', now + 31 * day, 0, 'hold', null, null, 'Перенос: ожидается поставка попутной нагрузки.'],
      ['Союз-2.1а / «Пеликан-7»', 'Союз-2.1а', 'Байконур', now - 26 * day, 0, 'success', 'PL-7', 'SUP-7', null],
      ['Союз-2.1б / «Сокол-2»', 'Союз-2.1б', 'Восточный', now - 920 * day, 0, 'success', 'SK-2', 'ICE-NSR', null],
      ['Ангара-1.2 / «Искра-Куб»', 'Ангара-1.2', 'Плесецк', now - 210 * day, 0, 'success', 'IK-1', 'ISKRA', 'Попутный запуск.'],
      ['Рокот / «Зонд-3»', 'Рокот', 'Плесецк', now - 700 * day, 0, 'failure', null, null, 'Нештатная работа разгонного блока, КА не выведен на орбиту.'],
      ['Протон-М / «Вега-Н3»', 'Протон-М', 'Байконур', now - 600 * day, 0, 'success', 'VG-3', 'NAV-DEP', null],
      ['Союз-2.1б / «Сокол-3»', 'Союз-2.1б', 'Восточный', now - 75 * day, 0, 'scrubbed', null, 'SK3-COM', 'Перенесён на «Ангару-А5» из-за замены носителя.'],
    ];
    for (const [name, vehicle, site, at, win, status, scCode, mCode, notes] of launches) {
      await tx.query(
        `INSERT INTO launches (name, vehicle, site, scheduled_at, window_minutes, status, spacecraft_id, mission_id, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [name, vehicle, site, iso(at), win, status, sc[scCode]?.id ?? null, missionIds[mCode] ?? null, notes],
      );
    }

    // история инцидентов за 30 дней
    const simCodes = Object.keys(sc).filter((c) => SIMULATED_STATUSES.has(sc[c].status));
    const kinds = [['seu', 0.34], ['thermal', 0.24], ['battery_low', 0.2], ['overheat', 0.1], ['attitude', 0.12]];
    const pickKind = () => {
      let r = rnd();
      for (const [k, w] of kinds) if ((r -= w) <= 0) return k;
      return 'seu';
    };
    const history = Array.from({ length: 46 }, () => ({ code: simCodes[Math.floor(rnd() * simCodes.length)], kind: pickKind(), created: now - (1 + rnd() * 29) * day }))
      .sort((a, b) => a.created - b.created);
    for (const { code, kind, created } of history) {
      const f = FAULTS[kind];
      const ackAfter = (3 + rnd() * 25) * 60_000;
      const fixAfter = ackAfter + (10 + rnd() * 240) * 60_000;
      await tx.query(
        `INSERT INTO incidents (spacecraft_id, severity, status, source, kind, title, description, acknowledged_by, acknowledged_at,
                                resolved_by, resolved_at, resolution, created_at)
         VALUES ($1,$2,'resolved','auto',$3,$4,$5,$6,$7,$6,$8,$9,$10)`,
        [sc[code].id, f.severity, kind, `${sc[code].name}: ${f.title.charAt(0).toLowerCase()}${f.title.slice(1)}`, 'Зафиксировано системой контроля телеметрии.',
          opId, iso(created + ackAfter), iso(created + fixAfter), f.fix ? `Устранено командой «${COMMAND_TYPES[f.fix].label}».` : 'Параметр вернулся в норму.', iso(created)],
      );
    }
    const manual = [
      ['info', 'resolved', null, 'MOW', 'Плановая проверка резервного канала', 'Проверка резервного канала связи Медвежьи Озёра — ЦУП прошла без замечаний.', 6],
      ['warning', 'resolved', null, 'SCL', 'Сбой привода антенны по азимуту', 'Антенна не отрабатывала целеуказания, заменён концевой датчик.', 12],
      ['info', 'acknowledged', null, 'MKE', 'Обслуживание станции Мауна-Кеа', 'Станция выведена из графика сеансов до окончания работ.', 2],
      ['warning', 'open', null, 'KGD', 'Калининград: деградация отношения сигнал/шум', 'После замены облучателя требуется повторная юстировка антенны.', 0.3],
    ];
    for (const [sev, status, scCode, stCode, title, descr, daysAgo] of manual) {
      const created = now - daysAgo * day;
      await tx.query(
        `INSERT INTO incidents (spacecraft_id, station_id, severity, status, source, title, description, created_by, acknowledged_by, acknowledged_at, resolved_by, resolved_at, resolution, created_at)
         VALUES ($1,$2,$3,$4,'manual',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [sc[scCode]?.id ?? null, stationIds[stCode], sev, status, title, descr, opId, status !== 'open' ? opId : null, status !== 'open' ? iso(created + 600_000) : null,
          status === 'resolved' ? opId : null, status === 'resolved' ? iso(created + 4 * 3600_000) : null, status === 'resolved' ? 'Работы завершены, замечаний нет.' : null, iso(created)],
      );
    }
    // открытые неисправности — сценарий для демонстрации
    const openFaults = [
      ['IK-1', 'attitude', 3 * 3600_000, 'Датчики угловой скорости показывают нештатное вращение. Солнечные батареи ушли с Солнца, генерация упала. Бортовая логика перевела КА в безопасный режим.'],
      ['SK-2', 'seu', 40 * 60_000, 'Контроль чётности ОЗУ бортового компьютера зафиксировал одиночный сбой. Возможна потеря данных целевой аппаратуры.'],
    ];
    for (const [code, kind, ago, descr] of openFaults) {
      const f = FAULTS[kind];
      await tx.query(
        `INSERT INTO incidents (spacecraft_id, severity, status, source, kind, title, description, created_at)
         VALUES ($1,$2,'open','auto',$3,$4,$5,$6)`,
        [sc[code].id, f.severity, kind, `${sc[code].name}: ${f.title.charAt(0).toLowerCase()}${f.title.slice(1)}`,
          `${descr} Рекомендуемое действие: команда «${COMMAND_TYPES[f.fix].label}».`, iso(now - ago)],
      );
    }

    // история команд
    const cmdTypes = ['PING', 'PING', 'SUN_POINTING', 'NADIR_POINTING', 'PAYLOAD_ON', 'PAYLOAD_OFF', 'REBOOT_OBC', 'ORBIT_CORRECTION'];
    const stationCodes = STATIONS.filter((s) => s[9] === 'online').map((s) => s[0]);
    const cmdHistory = Array.from({ length: 64 }, () => ({ code: simCodes[Math.floor(rnd() * simCodes.length)], type: cmdTypes[Math.floor(rnd() * cmdTypes.length)], created: now - (0.2 + rnd() * 20) * day }))
      .sort((a, b) => a.created - b.created);
    for (const { code, type, created } of cmdHistory) {
      const up = created + (2 + rnd() * 80) * 60_000;
      const failed = rnd() < 0.08;
      const params = type === 'ORBIT_CORRECTION' ? { delta_km: Math.round(1 + rnd() * 4) } : {};
      await tx.query(
        `INSERT INTO commands (spacecraft_id, type, params, status, issued_by, station_id, created_at, uplinked_at, completed_at, expires_at, result)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [sc[code].id, type, params, failed ? 'failed' : 'executed', rnd() < 0.7 ? opId : userIds.zuev ?? opId, stationIds[stationCodes[Math.floor(rnd() * stationCodes.length)]],
          iso(created), iso(up), iso(up + 4000), iso(created + 6 * 3600_000),
          failed ? 'Квитанция об исполнении не получена. Повторите команду в следующем сеансе.' : 'Команда выполнена, квитанция получена.'],
      );
    }

    await tx.query(`INSERT INTO audit_log (username, action, summary) VALUES ('система', 'seed', 'База данных заполнена начальными данными')`);
  });

  await backfillTelemetry(db, rnd, now);
  logger.info('Начальные данные загружены');
  return true;
}

/** Сутки телеметрии «задним числом», чтобы графики были живыми сразу после первого запуска. */
async function backfillTelemetry(db, rnd, now) {
  const fleet = await db.many(`SELECT * FROM spacecraft WHERE status IN ('active','standby','safe_mode')`);
  const stations = stationsForModel(await db.many('SELECT * FROM ground_stations'));
  const from = now - 24 * 3600_000;
  const stepMs = 60_000;
  const rows = [];
  for (const r of fleet) {
    const scm = { el: O.elementsFrom({ ...r, epoch: now }), powerMax: Number(r.power_w), type: r.type };
    const st = initialState(r, { battery: 70 + rnd() * 25, temperature: 10 + rnd() * 8, phase: rnd() * 6, lastT: from });
    if (r.code === 'IK-1') st.mode = 'nominal';
    for (let t = from; t <= now - stepMs; t += stepMs) {
      if (r.code === 'IK-1' && t > now - 3 * 3600_000 && !st.faults.has('attitude')) {
        st.faults.add('attitude');
        st.mode = 'safe';
        st.payloadOn = false;
      }
      if (r.code === 'SK-2' && t > now - 40 * 60_000) st.faults.add('seu');
      const sun = O.sunVector(t);
      const out = step(scm, st, t, stepMs / 1000, sun, stations, rnd);
      rows.push([r.id, new Date(t).toISOString(), +st.battery.toFixed(2), +st.temperature.toFixed(2), +out.generation.toFixed(1),
        out.signal === null ? null : +out.signal.toFixed(1), +out.alt.toFixed(1), +out.speed.toFixed(3), +out.lat.toFixed(3), +out.lon.toFixed(3),
        out.sunlit, st.mode, st.pointing, st.payloadOn, out.link?.stationId ?? null]);
    }
  }
  await insertTelemetry(db, rows);
  logger.info(`История телеметрии: ${rows.length} записей`);
}
