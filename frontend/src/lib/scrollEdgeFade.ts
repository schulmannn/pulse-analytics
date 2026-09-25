/**
 * Scroll-edge fade (полировка 2026-07-28): края КАЖДОГО `.data-table-scroll` мягко гаснут, когда
 * в ту сторону реально есть скрытый контент. Маска объявлена в самой утилите (index.css) с
 * дефолтом 0px; этот модуль — единственный драйвер её CSS-переменных, УСТАНАВЛИВАЕТСЯ ОДИН РАЗ
 * из App. Центральный, а не пер-компонентный: raw-контейнеров 14 в 11 файлах, и утилита обязана
 * работать в каждом будущем без ритуала подключения.
 *
 * Второй слой — КЛАВИАТУРА: контейнер с реальным переполнением получает табстоп и имя области
 * (см. keyboardReach). Драйвер один и тот же, потому что вопрос один и тот же — «есть ли справа
 * скрытый контент».
 *
 * Механика: capture-слушатель scroll (scroll не всплывает — capture ловит все контейнеры одним
 * слушателем) + rAF-дебаунснутый скан DOM на новые контейнеры (MutationObserver childList) +
 * ResizeObserver на каждом найденном. Не анимация — reduced-motion не касается.
 */

const FADE_PX = 20;
const EPSILON = 2;
const ATTACHED = 'edgeFadeAttached';

/**
 * Имя области прокрутки: заголовок карточки, в которой она лежит. Без имени скринридер объявит
 * «регион», и человек не поймёт, к какой из семи таблиц страницы он попал.
 */
function scrollLabel(el: HTMLElement): string | null {
  if (el.dataset.scrollLabel) return el.dataset.scrollLabel;
  for (let node: HTMLElement | null = el.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
    const title = node.querySelector<HTMLElement>('.widget-title')?.textContent?.trim();
    if (title) return title;
  }
  return el.querySelector('caption')?.textContent?.trim() || null;
}

/**
 * КЛАВИАТУРА, а не только маска. Таблицы шире экрана (заказы СДЭКа — 560px минимум, товары —
 * восемь колонок) прокручивались ТОЛЬКО мышью и тачпадом: у ячеек нет фокусируемого содержимого,
 * поэтому Tab пролетал контейнер насквозь, и правые колонки — номер отправления, статус, сумму —
 * с клавиатуры было не достать вовсе. WCAG 2.1.1; axe зовёт это scrollable-region-focusable.
 *
 * Табстоп ставится ТОЛЬКО при реальном переполнении и снимается, когда его нет: вкладка, где
 * ничего не прокручивается, не должна собирать Tab'ы за просто так.
 */
function keyboardReach(el: HTMLElement, scrollable: boolean) {
  const has = el.getAttribute('tabindex') === '0';
  if (scrollable === has) return;
  if (!scrollable) {
    el.removeAttribute('tabindex');
    el.removeAttribute('role');
    el.removeAttribute('aria-label');
    return;
  }
  el.setAttribute('tabindex', '0');
  const label = scrollLabel(el);
  if (label) {
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', `${label}, прокрутка по горизонтали`);
  }
}

function update(el: HTMLElement) {
  const overflow = el.scrollWidth - el.clientWidth;
  const scrollable = overflow > EPSILON;
  keyboardReach(el, scrollable);
  // Opt-out гасит МАСКУ, но не клавиатуру: sticky-колонка пивота всё так же прокручивается вбок,
  // и достать её правые столбцы с клавиатуры нужно ровно так же.
  if (el.dataset.edgeFadeOff != null) return;
  const left = scrollable && el.scrollLeft > EPSILON ? FADE_PX : 0;
  const right = scrollable && el.scrollLeft < overflow - EPSILON ? FADE_PX : 0;
  el.style.setProperty('--scroll-fade-l', `${left}px`);
  el.style.setProperty('--scroll-fade-r', `${right}px`);
}

let installed = false;

export function installScrollEdgeFade(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;

  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) update(entry.target as HTMLElement);
  });

  const attach = (el: HTMLElement) => {
    // Opt-out (data-edge-fade-off) разбирается в update: он про маску, а наблюдать контейнер
    // нужно в любом случае — иначе табстоп не появится и не исчезнет вслед за переполнением.
    if (el.dataset[ATTACHED]) return;
    el.dataset[ATTACHED] = '1';
    ro.observe(el);
  };

  // rAF-дебаунс: MutationObserver может стрелять пачками на каждый рендер — сканируем раз в кадр.
  let scanScheduled = false;
  const scheduleScan = () => {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      for (const el of document.querySelectorAll<HTMLElement>('.data-table-scroll')) {
        attach(el);
        // ПЕРЕ-мерка и уже привязанных (ревью): scrollWidth меняется без ресайза бокса (пивот
        // 7д→30д растит minWidth при той же высоте) — RO молчит, и фейд протухал в обе стороны.
        // Чтения по чистому layout раз в кадр, no-op записи Blink не инвалидируют — дёшево.
        if (el.dataset[ATTACHED]) update(el);
      }
    });
  };

  document.addEventListener(
    'scroll',
    (event) => {
      const el = event.target;
      if (el instanceof HTMLElement && el.classList.contains('data-table-scroll')) update(el);
    },
    { capture: true, passive: true },
  );
  new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
  scheduleScan();
}
