/**
 * Ukrainian UI strings and locale formatting — the single source of truth.
 *
 * **Ukrainian-only by design, but structured so a second language stays cheap.** Every string
 * lives in the `t` object below rather than inline in components, so adding English later means
 * adding a sibling dictionary and a `useLocale()` hook, not hunting strings across 10 route
 * files. Paying for a full i18n framework now would be paying for a switcher nobody asked for.
 *
 * Two things that are easy to get wrong in Ukrainian and matter here:
 *
 * 1. **Plurals have three forms**, not two: 1 день / 2 дні / 5 днів. `plural()` implements the
 *    CLDR rule rather than an `n === 1 ? a : b` check, which would be wrong for most numbers.
 * 2. **Money is never localised.** `formatMoney` deliberately does NOT use `Intl.NumberFormat`
 *    with `uk-UA`, because that produces a narrow no-break space as the thousands separator
 *    and puts the sign after the number ("1 234,50 ₴"). A payroll figure has to be
 *    copy-pasteable into a spreadsheet and diffable against the bank, so it stays
 *    `1234.50` with a dot and no grouping. See ui/Money.tsx.
 */

/** Ukrainian is the only locale; named so call sites read intentionally. */
export const LOCALE = 'uk-UA';

/**
 * Pick the right plural form for a Ukrainian count.
 *
 * @param one   form for 1, 21, 31… (день)
 * @param few   form for 2–4, 22–24… (дні)
 * @param many  form for 0, 5–20, 25–30… (днів)
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(n));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** `5 годин`, `2 години`, `1 година`. */
export function hoursLabel(n: number): string {
  return `${n} ${plural(n, 'година', 'години', 'годин')}`;
}

/** `3 зміни`, `1 зміна`, `7 змін`. */
export function shiftsLabel(n: number): string {
  return `${n} ${plural(n, 'зміна', 'зміни', 'змін')}`;
}

/**
 * Format an ISO date (`2026-05-05`) as `05.05.2026`, the Ukrainian convention.
 *
 * Parsed by splitting the string rather than `new Date(iso)`. `new Date('2026-05-05')` is
 * parsed as UTC midnight and then rendered in local time, which in any negative-offset timezone
 * shows the PREVIOUS day — a pay period boundary silently off by one. The API always sends
 * `YYYY-MM-DD`, so splitting is both safe and timezone-proof.
 */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  return `${d}.${mo}.${y}`;
}

/**
 * Format a UTC timestamp (`2026-08-05T22:30:00.000Z`) as the local Ukrainian date.
 *
 * **Use this for `timestamptz` columns, and `formatDate` for `DATE` columns — they are not
 * interchangeable.** A `DATE` (`work_date`, `period_start`, `revenue_date`) carries no timezone
 * and must be shown exactly as stored, so `formatDate` splits the string and never constructs a
 * `Date`. A `timestamptz` (`created_at`) is a real instant in UTC, so taking its first 10
 * characters shows the UTC date: a run created at 22:30 UTC on the 5th renders as 05.08 when in
 * Kyiv (UTC+3) it was already the 6th. Here converting IS the correct behaviour.
 */
export function formatTimestampDate(iso: string, timeZone = 'Europe/Kyiv'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // en-GB gives dd/mm/yyyy; swapping the separator yields the Ukrainian dd.mm.yyyy without
  // relying on the runtime's uk-UA data, which formats as `05.08.26` in some engines.
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
    .format(d)
    .replace(/\//g, '.');
}

/** Ukrainian month names in the nominative case, for a month picker. */
export const MONTHS = [
  'Січень',
  'Лютий',
  'Березень',
  'Квітень',
  'Травень',
  'Червень',
  'Липень',
  'Серпень',
  'Вересень',
  'Жовтень',
  'Листопад',
  'Грудень',
] as const;

/** All UI copy. Grouped by screen; shared words in `common`. */
export const t = {
  common: {
    appName: 'Розрахунок зарплати',
    loading: 'завантаження…',
    save: 'Зберегти',
    cancel: 'Скасувати',
    close: 'Закрити',
    edit: 'Редагувати',
    add: 'Додати',
    signOut: 'Вийти',
    employee: 'Працівник',
    location: 'Локація',
    date: 'Дата',
    status: 'Статус',
    actions: 'Дії',
    hours: 'Годин',
    amount: 'Сума',
    level: 'Рівень',
    from: 'з',
    to: 'по',
    total: 'Разом',
    currency: '₴',
    reload: 'Оновіть сторінку, перш ніж діяти на основі цих даних.',
    couldNotLoad: (what: string) => `Не вдалося завантажити ${what}`,
    saving: 'Зберігаємо…',
    // Status-pill labels shared across screens (shifts, revenue, extraction jobs) that this
    // group does not otherwise own a word for.
    statusNeedsReview: 'потребує перевірки',
    statusProcessing: 'обробка',
    statusBlocked: 'заблоковано',
  },

  nav: {
    // Rail group headings. Grouping is what makes the nav teach the shape of the product
    // instead of presenting nine equal-weight links (docs/design/system.md § Structure).
    groupOps: 'Операції',
    groupPayroll: 'Розрахунки',
    groupSetup: 'Налаштування',
    today: 'Сьогодні',
    /** Screen-reader text on a count badge, so "3" is never announced bare. */
    needsAttention: (n: number) => `${n} потребує уваги`,
    revenue: 'Виручка',
    shifts: 'Зміни',
    schedule: 'Графік',
    import: 'Імпорт',
    runs: 'Розрахунки',
    review: 'Перевірка',
    employees: 'Працівники',
    setup: 'Налаштування',
    myShifts: 'Мої зміни',
    myPay: 'Моя зарплата',
  },

  login: {
    title: 'Вхід',
    email: 'Електронна пошта',
    password: 'Пароль',
    signIn: 'Увійти',
    signingIn: 'Вхід…',
    newPasswordTitle: 'Встановіть новий пароль',
    newPasswordHint: 'Тимчасовий пароль потрібно змінити при першому вході.',
    newPassword: 'Новий пароль',
    setPassword: 'Встановити пароль',
    failed: 'Не вдалося увійти. Перевірте пошту та пароль.',
  },

  employees: {
    title: 'Працівники',
    addTitle: 'Додати працівника',
    name: "Ім'я",
    levelWithRate: 'Рівень (визначає ставку за день)',
    chooseLevel: 'Виберіть рівень…',
    revenuePercent: 'Відсоток від виручки (0–100)',
    /** Short form for a table header, where the long label would not fit. */
    revenuePercentShort: '% виручки',
    /** Unit suffix on a rate, e.g. "600 ₴/день". */
    perDay: 'день',
    adding: 'Додаємо…',
    addButton: 'Додати працівника',
    noLevels:
      'Ще немає жодного рівня. Адміністратор має спочатку створити рівень із погодинною ставкою.',
    empty: 'Ще немає працівників.',
    emptyAction: 'Додайте першого вище.',
    login: 'Вхід',
    canSignIn: 'може входити',
    noLogin: 'немає входу',
    invite: 'Запросити',
    inviteEmail: 'Пошта для входу',
    role: 'Роль',
    roleEmployee: 'працівник — власні зміни та зарплата',
    roleManager: 'менеджер — усі операції з зарплатою',
    roleAdmin: 'адміністратор — налаштування та акаунти',
    sendInvite: 'Надіслати запрошення',
    inviting: 'Надсилаємо…',
    inviteHint:
      'Cognito надішле тимчасовий пароль; працівник встановить власний при першому вході.',
    active: 'активний',
    inactive: 'неактивний',
    deactivate: 'Деактивувати',
    reactivate: 'Активувати',
    badPercent: 'Відсоток від виручки має бути числом від 0 до 100.',
    chooseLevelFirst: 'Виберіть рівень — він визначає ставку за день.',
    loginEmailFor: (name: string) => `Пошта для входу для ${name}`,
    roleFor: (name: string) => `Роль для ${name}`,
    levelFor: (name: string) => `Рівень для ${name}`,
    revenuePercentFor: (name: string) => `Відсоток від виручки для ${name}`,
  },

  /** Photographing a hand-written document for AI extraction. */
  photo: {
    title: 'Імпорт із фото',
    hint:
      'Сфотографуйте рукописний звіт — AI розпізнає його. Дані НЕ застосовуються автоматично: спочатку ви перевіряєте їх у черзі перевірки.',
    file: 'Фото або PDF',
    upload: 'Завантажити',
    uploading: 'Завантажуємо…',
    uploaded: 'Завантажено. Розпізнавання триває — перевірте чергу перевірки за хвилину.',
    uploadFailed: 'Не вдалося завантажити файл',
    chooseFirst: 'Спочатку виберіть файл.',
    inQueue: (n: number) => `У черзі на перевірку: ${n}`,
  },

  /**
   * The "Today" home screen — a worklist, not a dashboard.
   *
   * Every string here names a thing the manager can act on and links to it. Deliberately no
   * "welcome back" copy and no vanity metrics: the screen replaced "Choose a section from the
   * navigation", and its job is to answer "what needs me?" in one glance.
   */
  today: {
    title: 'Сьогодні',
    needsAttention: 'Потребує уваги',
    /** The all-clear state. A clean worklist is a real answer, not an empty table. */
    allClear: 'Усе під контролем.',
    allClearHint: 'Немає нічого, що потребує вашої уваги.',
    reviewQueue: (n: number) =>
      `${n} ${plural(n, 'документ очікує', 'документи очікують', 'документів очікує')} перевірки`,
    pendingShifts: (n: number) =>
      `${n} ${plural(n, 'зміна очікує', 'зміни очікують', 'змін очікує')} підтвердження`,
    missingRevenue: (n: number) =>
      `${n} ${plural(n, 'день без даних', 'дні без даних', 'днів без даних')} про виручку`,
    weekRevenue: 'Виручка за 7 днів',
    quickActions: 'Швидкі дії',
    open: 'Відкрити',
  },

  revenue: {
    title: 'Виручка за день',
    periodTotal: 'Разом за період',
    addTitle: 'Додати виручку',
    addManually: 'Додати вручну',
    importTitle: 'Імпорт виручки',
    revenueDate: 'Дата',
    amountUah: 'Сума, ₴',
    saving: 'Зберігаємо…',
    empty: 'Ще немає записів про виручку.',
    emptyAction: 'Додайте перший запис вище.',
    source: 'Джерело',
    sourceManual: 'вручну',
    sourceExtracted: 'з документа',
  },

  shifts: {
    title: 'Зміни',
    empty: 'Немає запланованих змін.',
    emptyAction: 'Імпортуйте графік або дочекайтеся заявок.',
    window: 'Час',
    approve: 'Підтвердити',
    reject: 'Відхилити',
    delete: 'Видалити',
    requested: 'заявка',
    approved: 'підтверджено',
    rejected: 'відхилено',
    source: 'Джерело',
    decision: 'Рішення',
    couldNotLoad: 'Не вдалося завантажити зміни',
    sourceNative: 'вручну',
    sourceExtracted: 'з документа',
    sourceImported: 'з імпорту',
  },

  myShifts: {
    title: 'Мої зміни',
    empty: 'У вас ще немає змін.',
    emptyAction: 'Підтверджені зміни з’являться тут.',
  },

  myPay: {
    title: 'Моя зарплата',
    empty: 'Розрахунків ще не було.',
    emptyAction: 'Ваша зарплата з’явиться тут після розрахунку.',
    period: 'Період',
    latestPeriod: 'За останній період',
    hourlyPay: 'За години',
    revenueShare: 'Від виручки',
    bonus: 'Премія',
  },

  runs: {
    payrollTotal: 'До виплати',
    title: 'Розрахунки зарплати',
    runTitle: 'Розрахувати зарплату',
    hint:
      'Розрахунок остаточний і одразу видимий працівникам. Періоди — з 1 по 15 і з 16 до кінця місяця.',
    year: 'Рік',
    month: 'Місяць',
    period: 'Період',
    firstHalf: '1 – 15 число',
    secondHalf: '16 – кінець місяця',
    run: 'Розрахувати',
    // Preview-then-commit: a run is immutable, so the manager sees the figures first.
    calculate: 'Порахувати',
    calculating: 'Рахуємо…',
    previewTitle: 'Перевірте розрахунок',
    previewHint: 'Ще не збережено. Перевірте суми та підтвердьте.',
    confirmRun: 'Підтвердити і зберегти',
    staleReview: 'Дані змінилися після розрахунку. Натисніть «Порахувати» ще раз.',
    savedTitle: 'Розрахунок збережено',
    running: 'Розраховуємо…',
    bonusesTitle: 'Персональні премії',
    bonusesHint:
      'Необов’язково, для кожного окремо, лише за цей період. Залиште порожнім, якщо премії немає. Розрахунок не можна змінити після створення, тому вносьте премії до запуску.',
    bonusFor: (name: string) => `Премія для ${name}`,
    bonusColumn: 'Премія',
    bonusPerEmployeeCaption: 'Премія за працівника',
    loadingEmployees: 'завантаження працівників…',
    employeesFailed:
      'Не вдалося завантажити працівників, тому премії внести неможливо. Оновіть сторінку перед розрахунком.',
    noActive: 'Немає активних працівників.',
    breakdown: 'Розбір зарплати',
    hourly: 'За години',
    revenueShare: 'Від виручки',
    allEmployees: 'Усі працівники',
    pastRuns: 'Попередні розрахунки',
    completedRunsCaption: 'Завершені розрахунки',
    noRuns: 'Зарплату ще не розраховували.',
    noRunsAction: 'Скористайтеся формою вище, коли будуть внесені виручка та зміни.',
    periodStart: 'Початок періоду',
    periodEnd: 'Кінець періоду',
    created: 'Створено',
    blockedTitle: 'Розрахунок заблоковано — немає виручки',
    blockedHint:
      'Додайте підтверджену виручку за кожен день нижче, потім запустіть розрахунок знову. Нічого не збережено.',
    badYear: 'Введіть рік від 2000 до 2100.',
    badMonth: 'Введіть місяць від 1 до 12.',
    badBonus: (names: string) =>
      `Виправте суму премії для: ${names}. Використовуйте число 0 або більше.`,
  },

  review: {
    title: 'Черга перевірки',
    caption: 'Розпізнавання, що очікують перевірки',
    empty: 'Немає нічого на перевірку.',
    emptyAction: 'Завантажені документи з’являться тут, якщо розпізнавання неточне.',
    failedTitle: 'Не вдалося завантажити чергу перевірки',
    failedHint: 'Це не те саме, що порожня черга — можливо, документи очікують.',
    document: 'Документ',
    type: 'Тип',
    confidence: 'Впевненість',
    extracted: 'Розпізнано',
    decision: 'Рішення',
    typeRevenue: 'виручка',
    typeSchedule: 'графік',
    confirm: 'Підтвердити',
    reject: 'Відхилити',
    rejectReason: 'Причина відхилення',
  },

  setup: {
    title: 'Налаштування',
    locations: 'Локації',
    addLocation: 'Додати локацію',
    locationName: 'Назва',
    opensAt: 'Відкриття',
    closesAt: 'Закриття',
    levels: 'Рівні',
    addLevel: 'Додати рівень',
    levelName: 'Назва рівня',
    ratePerDay: 'Ставка за день, ₴',
    noLocations: 'Ще немає локацій.',
    noLocationsAction: 'Додайте одну нижче.',
    noLevels: 'Ще немає рівнів.',
    noLevelsAction: 'Додайте один нижче.',
    adding: 'Додаємо…',
  },

  schedule: {
    title: 'Графік',
    /** Monday-first, per Ukrainian convention — this order is the point, not Sunday-first. */
    weekdays: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'] as const,
    year: 'Рік',
    month: 'Місяць',
    prevMonth: 'Попередній місяць',
    nextMonth: 'Наступний місяць',
    today: 'сьогодні',
  },

  importScreen: {
    title: 'Імпорт графіка',
    hint: 'Завантажте файл .xlsx з графіком. Нічого не зберігається, доки ви не підтвердите.',
    choose: 'Виберіть файл',
    parse: 'Розпізнати',
    parsing: 'Розпізнаємо…',
    commit: 'Зберегти зміни',
    committing: 'Зберігаємо…',
    anomalies: 'Аномалії',
    empty: 'Файл ще не вибрано.',
    workbook: 'Файл графіка',
    preview: 'Попередній перегляд',
    previewResult: 'Результат розпізнавання',
    commitHeading: 'Зберегти',
    commitResult: 'Результат збереження',
    year: 'Рік',
    month: 'Місяць',
    // Each of these lists a thing the manager must resolve before the import is trustworthy,
    // so the headings say what is wrong rather than naming an internal field.
    unmappedNames: 'Не розпізнані імена',
    // The mapping step is what turns a parsed workbook into real shifts.
    mapNamesTitle: 'Прив’яжіть імена з файлу до працівників',
    mapNamesHint:
      'Без прив’язки зміни не створюються. Позначте «не людина» для рядків-заготовок, як-от «Бариста 1» — їх більше не будуть запитувати.',
    sheetName: 'Ім’я у файлі',
    chooseEmployee: 'Виберіть працівника…',
    notAPerson: 'Не людина (заготовка)',
    mapNameFor: (name: string) => `Працівник для «${name}»`,
    unknownLocations: 'Невідомі локації',
    missingSlots: 'Немає налаштованої зміни',
    inactiveEmployees: 'Неактивні працівники',
    conflicts: 'Конфлікти',
    created: 'створено',
    skipped: 'пропущено',
    windowChanged: 'Змінено час зміни',
    chooseFileFirst: 'Спочатку виберіть файл графіка.',
    monthsFound: (months: string) => `знайдені місяці: ${months}`,
  },
} as const;
