/**
 * Подгрузка шрифтовых семейств студии «Оформление».
 *
 * Шрифты РАЗДАЁМ САМИ (`@fontsource-variable/*`), а не с fonts.gstatic.com — у приложения строгий
 * CSP `font-src 'self'` (server/lib/securityHeaders.js), и это правило менять не за чем: сторонний
 * шрифтовый хост означает и лишний origin, и утечку факта визита. Тем же путём шрифты раздаёт сам
 * shadcn (их реестр зависит от `@fontsource-variable`), так что «как в create» здесь буквально.
 *
 * Карта СТАТИЧЕСКАЯ: `import()` с шаблонной строкой Vite не разрешает для пакетов из node_modules,
 * а заодно статический список — единственное место, где перечень семейств живёт в коде. Каждая
 * запись становится отдельным чанком: пользователь на Geist не скачивает ни байта чужого шрифта,
 * а выбравший Inter получает только его подмножества (latin + cyrillic, ~65KB).
 *
 * Сама карта обязана лежать в ОБОЛОЧКЕ: при загрузке страницы с сохранённой темой CSS достаётся из
 * прерисовочного кэша, и модуль палитр не поднимается вовсе — некому было бы попросить шрифт.
 */
const LOADERS: Record<string, () => Promise<unknown>> = {
  inter: () => import('@fontsource-variable/inter'),
  manrope: () => import('@fontsource-variable/manrope'),
  montserrat: () => import('@fontsource-variable/montserrat'),
  'open-sans': () => import('@fontsource-variable/open-sans'),
  roboto: () => import('@fontsource-variable/roboto'),
  nunito: () => import('@fontsource-variable/nunito'),
  rubik: () => import('@fontsource-variable/rubik'),
  raleway: () => import('@fontsource-variable/raleway'),
  'source-sans-3': () => import('@fontsource-variable/source-sans-3'),
  'ibm-plex-sans': () => import('@fontsource-variable/ibm-plex-sans'),
  'golos-text': () => import('@fontsource-variable/golos-text'),
  lora: () => import('@fontsource-variable/lora'),
  'playfair-display': () => import('@fontsource-variable/playfair-display'),
  'jetbrains-mono': () => import('@fontsource-variable/jetbrains-mono'),
  'roboto-mono': () => import('@fontsource-variable/roboto-mono'),
};

/** Ключи, для которых есть загрузчик. Экспорт ради инварианта в тесте: каждое `webfont`-семейство
    таблицы обязано иметь здесь пару, иначе выбор шрифта тихо не сделал бы ничего. */
export const APPEARANCE_FONT_KEYS: readonly string[] = Object.keys(LOADERS);

const requested = new Set<string>();

/**
 * Просит браузер подтянуть семейство. Идемпотентно и «тихо»: неизвестный ключ (канон, System,
 * запись из чужой версии) — не ошибка, а «ничего не грузим»; упавшая загрузка снимает отметку,
 * чтобы следующий заход попробовал снова. Шрифт применяется к уже отрисованной странице, поэтому
 * до его прихода текст стоит на системном запасном варианте стека — обычный FOUT, а не пустота.
 */
export function loadAppearanceFont(key: string | null | undefined): void {
  if (!key || requested.has(key)) return;
  const load = LOADERS[key];
  if (!load) return;
  requested.add(key);
  void load().catch(() => {
    requested.delete(key);
  });
}

/**
 * Подтягивает объявления ВСЕХ семейств — вызывается, когда пользователь открыл список шрифтов.
 * Список, в котором имена набраны не своими начертаниями, — не выбор шрифта, а перечень слов.
 *
 * Грузим сразу и все: это лишь `@font-face`-объявления (по паре килобайт CSS), а сами woff2
 * браузер запрашивает ТОЛЬКО под реально отрисованные строки — прокрутил до «Playfair Display»,
 * тогда он и приедет. Раньше здесь была цепочка `requestIdleCallback`; она молчит в фоновой или
 * неотрисовываемой вкладке, и список так и оставался ненабранным (поймано вживую).
 */
export function prefetchAppearanceFonts(): void {
  for (const key of Object.keys(LOADERS)) loadAppearanceFont(key);
}
