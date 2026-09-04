import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { AtlavueMark } from '@/components/AtlavueMark';
import { useForcedTheme } from '@/lib/forcedTheme';

/**
 * Public marketing landing — минимальная чёрная версия.
 *
 * Направление (Refero): опорная ссылка — тёмная сборка shuttle.zip. Плавающая пилюля-топбар по
 * центру над чёрным холстом, узкая колонка, дисплейный кегль весом 500 с трекингом -0.025em
 * (никогда не bold), CTA с одной серой строкой-подстрочником. Дисциплина радиуса 9999px у всего
 * интерактивного — из ченджлога Linear.
 *
 * Заголовок называет КАТЕГОРИЮ, а не площадки: так у LiveDune («в соцсетях»), Popsters («в
 * социальных сетях») и Databox («a single source»). Перечисление живёт в подписи, поэтому первый
 * экран не нужно править с каждым новым источником.
 *
 * Продуктовые скриншоты сняты намеренно — они устаревают быстрее страницы. Секции с панелями
 * вернутся, когда будут свежие снимки UI.
 *
 * Страница всегда чёрная: `useForcedTheme('dark')` пришпиливает тему документа на время жизни
 * лендинга и возвращает пользовательскую при уходе. Подкрасить одно поддерево классом в Tailwind
 * v4 НЕЛЬЗЯ — цветовые алиасы `@theme` подставляются на `:root`, см. коммент в `lib/forcedTheme`.
 * Так страница берёт ровно проверенные тёмные токены, без локальных хексов. Собственной моторики
 * нет: только ховер-переходы, поэтому под `prefers-reduced-motion` гасить нечего.
 */

// Узкая колонка подписи/подвала (мера Shuttle — 620px). Заголовок берёт свою, более широкую:
// русские слова длиннее английских, и на 620px дисплейный кегль рвёт строку слишком часто.
const COL = 'mx-auto w-full max-w-[620px] px-6 text-center';
const HEAD_COL = 'mx-auto w-full max-w-[820px] px-6 text-center';

const DISPLAY = 'text-balance font-medium leading-[1.06] tracking-[-0.025em]';

/** Стрелка доезжает на ховере — house-паттерн кнопки (гейт hover-fine: на таче просто стоит). */
function SlideArrow({ className = 'size-3.5' }: { className?: string }) {
  return (
    <ArrowRight
      aria-hidden="true"
      className={`${className} transition-transform dur-fast ease-house hover-fine:group-hover:translate-x-0.5 motion-reduce:group-hover:translate-x-0`}
    />
  );
}

function TopBar() {
  return (
    <nav className="sticky top-0 z-sticky px-4 py-3">
      {/* Пилюля отделяется от холста тоном и волоском, без тени: у Shuttle под ней чёрный
          `shadow-2xl`, но их холст — чистый #000, а наш почти чёрный, и такая тень читается
          прямоугольным пятном. */}
      <div className="mx-auto flex w-fit items-center rounded-full border border-border bg-card/85 p-1 backdrop-blur-sm">
        {/* Начертание прячется ниже `sm`, поэтому имя несёт сама ссылка — иначе в таб-порядке
            телефона остаётся безымянная ссылка (mark помечен aria-hidden). */}
        <Link to="/" aria-label="Atlavue" className="flex shrink-0 items-center gap-2 px-4 text-base font-medium text-foreground">
          <AtlavueMark className="h-[18px] w-[18px] shrink-0 text-primary" />
          <span className="hidden sm:block">Atlavue</span>
        </Link>
        <ul className="flex items-center">
          <li>
            <Link to="/login" className="block whitespace-nowrap px-4 py-2 text-sm font-medium opacity-70 transition-opacity dur-fast ease-house hover:opacity-100">
              Войти
            </Link>
          </li>
          <li>
            <Link
              to="/register"
              className="group btn-pill ml-2 flex shrink-0 items-center gap-1.5 whitespace-nowrap bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors dur-fast ease-house hover:bg-primary/90"
            >
              Начать
              <SlideArrow className="size-3" />
            </Link>
          </li>
        </ul>
      </div>
    </nav>
  );
}

function FootLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="transition-opacity dur-fast ease-house hover:opacity-70">
      {children}
    </Link>
  );
}

export function Landing({ onEnterDemo }: { onEnterDemo: () => void }) {
  useForcedTheme('dark');
  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden bg-background text-foreground">
      <TopBar />

      <main className="flex flex-1 items-center justify-center py-20 sm:py-28">
        <div className={HEAD_COL}>
          <h1 className={`${DISPLAY} text-[clamp(38px,7vw,62px)] text-foreground`}>
            Вся аналитика в одном месте
          </h1>
          {/* Неразрывный пробел перед тире: иначе на узком экране строка начинается с «—». */}
          <p className="mx-auto mt-5 max-w-[38em] text-pretty text-[17px] leading-relaxed text-ink2">
            Соцсети, продажи и другие источники&nbsp;— без ручных выгрузок.
          </p>

          <div className="mt-9 flex flex-col items-center">
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link
                to="/register"
                className="group btn-pill inline-flex items-center gap-1.5 bg-primary px-5 py-2.5 text-[15px] font-medium text-primary-foreground transition-colors dur-fast ease-house hover:bg-primary/90"
              >
                Начать
                <SlideArrow />
              </Link>
              <button
                type="button"
                onClick={onEnterDemo}
                className="btn-pill border border-border bg-card px-5 py-2.5 text-[15px] font-medium text-foreground transition-colors dur-fast ease-house hover:bg-muted"
              >
                Посмотреть демо
              </button>
            </div>
            <span className="mt-3 text-xs text-ink3">Бесплатно, без карты · демо без регистрации</span>
          </div>
        </div>
      </main>

      <footer className="pb-12">
        <div className={COL}>
          <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-ink3">
            <FootLink to="/login">Войти</FootLink>
            <span aria-hidden="true">·</span>
            <FootLink to="/privacy">Политика</FootLink>
            <span aria-hidden="true">·</span>
            <FootLink to="/data-deletion">Удаление данных</FootLink>
          </p>
        </div>
      </footer>
    </div>
  );
}
