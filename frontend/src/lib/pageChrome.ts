/**
 * Shared sticky page-header geometry — ONE source for the personal Home header (panels/Home) and
 * every feed section header (panels/feed/useFeed). The strip bleeds to the shared main canvas edges
 * (the negative `-mx` cancels the shell's `px-4 sm:px-6`), sticks to the top of the inset panel over
 * a SOLID canvas background (no hairline / blur — it is indistinguishable from the page at rest and
 * simply clips the content sliding under it), and reserves a consistent gap below. Flex alignment
 * (single-row vs mobile-stacked) is left to each caller; only the geometry is shared here so the two
 * headers cannot drift apart into diverging copies.
 */
export const PAGE_HEADER_SHELL =
  'sticky top-0 z-sticky -mx-4 mb-6 bg-background px-4 py-3 sm:-mx-6 sm:px-6';

/**
 * CSS-переменная с ФАКТИЧЕСКОЙ высотой sticky-шапки страницы. Шапка переменной высоты (flex-wrap:
 * длинное имя источника + период-бар переносятся на второй ряд), поэтому второй sticky-слой не может
 * зашить свой `top` константой. Значение пишет ОДИН ResizeObserver в `FeedBlock` (panels/feed/useFeed)
 * прямо на элемент секции — без React-состояния, чтобы измерение не будило перерисовку страницы
 * (волна фризов #290). Пока переменная не установлена, `top: var(...)` невалиден → элемент просто не
 * липнет, то есть деградация совпадает с прежним поведением.
 */
export const FEED_HEADER_HEIGHT_VAR = '--feed-header-h';

/**
 * Второй уровень навигации страницы (табы раздела) — липнет ПОД шапкой внутри элемента-скроллера
 * `[data-dashboard-scroll]`, только на md+ (мобильный поток не трогаем). Полоса непрозрачна
 * (`bg-background`) и несёт нижний hairline, поэтому контент уходит под неё без просвета; hairline
 * постоянный, а не по факту прилипания — переключение состояния меняло бы высоту полосы и давало CLS.
 */
export const PAGE_SUBNAV_SHELL =
  'md:sticky md:top-(--feed-header-h) md:z-sticky md:border-b md:border-border md:bg-background md:py-2';
