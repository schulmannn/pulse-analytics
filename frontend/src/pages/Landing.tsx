import { Link } from 'react-router-dom';

/*  DESIGN: Claude — public marketing landing, ported from the legacy `.lp-*` dark
    resend-style page (public/index.html). Forces the dark theme regardless of app
    theme by wrapping in `.dark` and uses only semantic/brand tokens (no hex). */

const SERIF = "'Instrument Serif', Georgia, serif";

/** Iris radial-glow background built from the brand token (matches legacy gradients). */
const GLOW_BG = {
  backgroundImage: [
    'radial-gradient(900px 520px at 80% -10%, hsl(var(--primary) / 0.18), transparent 60%)',
    'radial-gradient(680px 480px at 8% 112%, hsl(var(--primary) / 0.10), transparent 60%)',
    'linear-gradient(180deg, hsl(var(--background)), hsl(var(--background)))',
  ].join(','),
};

function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-7 w-7 items-center justify-center rounded bg-primary text-base font-medium text-primary-foreground">
        P
      </span>
      <span className="text-[17px] font-medium tracking-tight">Pulse</span>
    </div>
  );
}

export function Landing() {
  return (
    <div className="dark min-h-screen text-foreground" style={GLOW_BG}>
      {/* ── Top nav ── */}
      <nav className="sticky top-0 z-20 flex items-center justify-between gap-6 border-b border-white/5 bg-background/60 px-5 py-3.5 backdrop-blur sm:px-10">
        <div className="flex items-center gap-7">
          <BrandMark />
          <div className="hidden items-center gap-1 md:flex">
            {['О нас', 'Философия', 'Тарифы'].map((label) => (
              <span
                key={label}
                className="cursor-default rounded px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                {label}
              </span>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/login"
            className="rounded px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Войти
          </Link>
          <Link
            to="/register"
            className="rounded-full bg-foreground px-4 py-2 text-sm font-medium text-background transition-shadow hover:shadow-[0_6px_22px_hsl(var(--foreground)/0.16)]"
          >
            Начать
          </Link>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="mx-auto grid max-w-[1180px] items-center gap-10 px-5 pb-16 pt-12 sm:px-10 md:grid-cols-[1.1fr_0.9fr] md:gap-20 md:pt-24">
        <div>
          <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3.5 py-1.5 text-[13px] text-muted-foreground">
            <b className="font-semibold text-primary">Новое</b> · Коллектор любых каналов →
          </span>
          <h1
            className="mb-5 text-[clamp(46px,7vw,92px)] font-normal leading-[0.96] tracking-tight"
            style={{ fontFamily: SERIF }}
          >
            Аналитика
            <br />
            <em className="italic text-primary">для авторов</em>
          </h1>
          <p className="mb-8 max-w-[30em] text-[clamp(16px,1.4vw,19px)] leading-relaxed text-muted-foreground">
            Метрики, динамика и упоминания твоих Telegram-каналов — в одном понятном дашборде.
            Без ботов и без доступа к твоему аккаунту.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/register"
              className="rounded bg-primary px-6 py-3 text-[15px] font-medium text-primary-foreground transition-all hover:-translate-y-px hover:shadow-[0_10px_30px_hsl(var(--primary)/0.4)]"
            >
              Начать бесплатно
            </Link>
            <span className="cursor-default rounded border border-white/10 bg-white/5 px-5 py-3 text-[15px] font-medium transition-colors hover:bg-white/10">
              Документация
            </span>
          </div>
        </div>

        {/* Empty hero slot (kept from legacy — visual added later). */}
        <div className="hidden min-h-[380px] rounded-2xl border border-dashed border-primary/20 bg-white/[0.015] md:block" aria-hidden="true" />
      </section>

      {/* ── Feature strip ── */}
      <section className="mx-auto grid max-w-[1180px] gap-4 px-5 pb-20 sm:px-10 md:grid-cols-3">
        {[
          { h: 'Telegram-аналитика', p: 'Просмотры, ER, виральность и динамика подписчиков по каждому посту — с учётом альбомов.' },
          { h: 'Упоминания бренда', p: 'Отслеживай, где о тебе говорят в публичных каналах — с охватом и контекстом.' },
          { h: 'Твои данные — твои', p: 'Коллектор считает метрики у тебя локально; мы не храним твою сессию Telegram.' },
        ].map((f) => (
          <div key={f.h} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-6">
            <h3 className="mb-2 text-base font-semibold">{f.h}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{f.p}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
