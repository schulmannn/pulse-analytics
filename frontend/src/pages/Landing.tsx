import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  motion,
  useTransform,
  useReducedMotion,
  useMotionValue,
  animate,
  cubicBezier,
} from 'framer-motion';
import { AtlavueMark } from '@/components/AtlavueMark';

/**
 * Public marketing landing — "Atlavue Refined Technical" (light, product-forward, Steep-style).
 * Light by default (no forced .dark): warm paper canvas, hairline section dividers, one calm blue
 * accent, pill CTAs. The product itself does the selling — a dashboard that *assembles itself*
 * (autoplay on load) plus floating UI cards that pop in from the corners, steep.app-style.
 *
 * Motion: on mount the hero dashboard builds itself (count-up, sparkline draw, KPI tiles popping in
 * from different angles, staggered posts, self-typing insight) over a warm aurora background, with
 * peripheral cards bobbing around it; sections below reveal on entry. All collapses to a static,
 * fully-assembled state under `prefers-reduced-motion` and on mobile (mock hidden).
 */

const MAXW = 'mx-auto w-full max-w-[1200px] px-6 sm:px-10';

const EASE = cubicBezier(0.22, 1, 0.36, 1);

// shared sparkline geometry (static fragment + animated hero share one path)
const SPARK_LINE =
  'M0,44 L18,40 L36,42 L54,33 L72,35 L90,27 L108,29 L126,20 L144,22 L162,12 L180,15 L200,6';

// ── tiny inline icons (stroke = currentColor) ──────────────────────────────
function Check({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M5 12.5l4 4 10-11" />
    </svg>
  );
}
function Calendar({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="4" y="5" width="16" height="16" rx="2.2" />
      <path d="M3.5 9.5h17M8 2.8v3.6M16 2.8v3.6" />
    </svg>
  );
}
function Shield({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 3l7 3v6c0 4-3 7-7 8-4-1-7-4-7-8V6l7-3z" />
    </svg>
  );
}
function Lightbulb({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M9 18h6" />
      <path d="M10 21h4" />
      <path d="M12 3a6 6 0 0 0-4 10c.7.7 1 1.3 1 2h6c0-.7.3-1.3 1-2a6 6 0 0 0-4-10z" />
    </svg>
  );
}

// ── shared product-preview atoms ────────────────────────────────────────────
function Sparkline() {
  return (
    <svg viewBox="0 0 200 52" preserveAspectRatio="none" className="h-[52px] w-full" aria-hidden="true">
      <defs>
        <linearGradient id="lp-spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.16" />
          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${SPARK_LINE} L200,52 L0,52 Z`} fill="url(#lp-spark)" />
      <path d={SPARK_LINE} fill="none" stroke="hsl(var(--foreground))" strokeWidth="1.5" />
      <circle cx="200" cy="6" r="3" fill="hsl(var(--primary))" />
    </svg>
  );
}

function MiniNav({ label, active, demo }: { label: string; active?: boolean; demo?: boolean }) {
  return (
    <div className={`flex w-full items-center gap-2 rounded px-2 py-1 ${active ? 'text-foreground' : 'text-ink3'}`}>
      <span className={`h-1.5 w-1.5 rounded-sm ${active ? 'bg-primary' : 'bg-ink3/50'}`} />
      <span className="text-[10px]">{label}</span>
      {demo && <span className="ml-auto rounded bg-status-warn/15 px-1 text-[7px] font-medium text-status-warn">демо</span>}
    </div>
  );
}

function Col({ label, value, delta, up }: { label: string; value: string; delta: string; up?: boolean }) {
  return (
    <div className="flex-1 border-l border-border pl-3 first:border-l-0 first:pl-0">
      <div className="text-[9px] text-ink3">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-[15px] font-medium tabular-nums text-foreground">{value}</span>
        <span className={`text-[9px] tabular-nums ${up ? 'text-verdant' : 'text-ember'}`}>{delta}</span>
      </div>
    </div>
  );
}

function PostRow({ n, title, views, er, delta, up }: { n: number; title: string; views: string; er: string; delta: string; up?: boolean }) {
  return (
    <div className="flex items-center gap-3 border-t border-border py-2 text-[10px]">
      <span className="w-3 text-ink3 tabular-nums">{n}</span>
      <span className="min-w-0 flex-1 truncate text-foreground">{title}</span>
      <span className="w-12 text-right tabular-nums text-ink2">{views}</span>
      <span className="w-8 text-right tabular-nums text-ink2">{er}</span>
      <span className={`w-9 text-right tabular-nums ${up ? 'text-verdant' : 'text-ember'}`}>{delta}</span>
    </div>
  );
}

// ── animated hero: a dashboard that assembles itself on load + floating UI ───
// (autoplay on mount; not scroll-driven)

const SPRING = { type: 'spring', stiffness: 240, damping: 22, mass: 0.9 } as const;

// soft warm aurora behind the hero (steep-style): peach + pink + a touch of blue
function HeroAurora() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute left-[24%] top-1/2 h-[780px] w-[1040px] -translate-y-1/2 rounded-full"
        style={{ background: 'radial-gradient(closest-side, rgba(242,135,90,0.26), rgba(242,135,90,0) 72%)' }}
      />
      <div
        className="absolute right-[14%] top-[2%] h-[540px] w-[640px] rounded-full"
        style={{ background: 'radial-gradient(closest-side, rgba(235,110,150,0.20), rgba(235,110,150,0) 70%)' }}
      />
      <div
        className="absolute right-[2%] top-[58%] h-[460px] w-[560px] rounded-full"
        style={{ background: 'radial-gradient(closest-side, rgba(45,107,224,0.12), rgba(45,107,224,0) 70%)' }}
      />
    </div>
  );
}

function KpiTile({
  label, value, delta, up, fx, fy, frot, delay, reduce,
}: {
  label: string; value: string; delta: string; up?: boolean;
  fx: number; fy: number; frot: number; delay: number; reduce: boolean;
}) {
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, x: fx, y: fy, rotate: frot, scale: 0.8 }}
      animate={{ opacity: 1, x: 0, y: 0, rotate: 0, scale: 1 }}
      transition={{ ...SPRING, delay: reduce ? 0 : delay }}
      className="rounded-lg border border-border bg-card px-2.5 py-2 will-change-transform"
    >
      <div className="text-[9px] text-ink3">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-[15px] font-medium tabular-nums text-foreground">{value}</span>
        <span className={`text-[9px] tabular-nums ${up ? 'text-verdant' : 'text-ember'}`}>{delta}</span>
      </div>
    </motion.div>
  );
}

function HeroSparkline({ reduce }: { reduce: boolean }) {
  return (
    <svg viewBox="0 0 200 52" preserveAspectRatio="none" className="h-[52px] w-full" aria-hidden="true">
      <defs>
        <linearGradient id="lp-spark-h" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.16" />
          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
        </linearGradient>
      </defs>
      <motion.path
        d={`${SPARK_LINE} L200,52 L0,52 Z`} fill="url(#lp-spark-h)"
        initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }}
        transition={{ delay: 0.9, duration: 0.6 }}
      />
      <motion.path
        d={SPARK_LINE} fill="none" stroke="hsl(var(--foreground))" strokeWidth="1.5"
        initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }}
        transition={{ delay: 0.55, duration: 1.0, ease: EASE }}
      />
      <motion.circle
        cx="200" cy="6" r="3" fill="hsl(var(--primary))"
        initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }}
        transition={{ delay: 1.5, duration: 0.3 }}
      />
    </svg>
  );
}

const RISK_LINE = 'Охват растёт на 8%, а подписчиков стало меньше на 108.';

function DashboardMock({ reduce }: { reduce: boolean }) {
  const views = useMotionValue(reduce ? 48210 : 0);
  const viewsText = useTransform(views, (v) => Math.round(v).toLocaleString('ru-RU'));
  const typeProg = useMotionValue(reduce ? 1 : 0);
  const typed = useTransform(typeProg, (v) => RISK_LINE.slice(0, Math.round(RISK_LINE.length * v)));

  useEffect(() => {
    if (reduce) return;
    const c1 = animate(views, 48210, { delay: 0.35, duration: 1.4, ease: EASE });
    const c2 = animate(typeProg, 1, { delay: 1.6, duration: 1.25, ease: 'linear' });
    return () => { c1.stop(); c2.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fade = (delay: number) => ({
    initial: reduce ? false : { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: { delay: reduce ? 0 : delay, duration: 0.5, ease: EASE },
  });

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="flex w-full text-foreground"
    >
      {/* sidebar */}
      <motion.div
        initial={reduce ? false : { opacity: 0, x: -16 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: reduce ? 0 : 0.15, duration: 0.5, ease: EASE }}
        className="hidden w-[132px] shrink-0 flex-col gap-3 border-r border-border bg-background p-3 sm:flex"
      >
        <div className="flex items-center gap-1.5">
          <AtlavueMark className="h-3.5 w-3.5 text-primary" />
          <span className="text-[11px] font-medium">Atlavue</span>
        </div>
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-card px-1.5 py-1">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-avatar text-[9px] font-medium text-ink2">N</span>
          <div className="min-w-0">
            <div className="truncate text-[10px] font-medium">@newsroom</div>
            <div className="truncate text-[8px] text-ink3">4 781 подписчик</div>
          </div>
        </div>
        <div>
          <div className="px-2 pb-1 text-[8px] text-ink3">Платформа</div>
          <MiniNav label="Telegram" active />
          <MiniNav label="Instagram" demo />
        </div>
        <div className="space-y-0.5">
          <MiniNav label="Обзор" active />
          <MiniNav label="Аналитика" />
          <MiniNav label="Контент" />
          <MiniNav label="Упоминания" />
        </div>
      </motion.div>

      {/* main */}
      <div className="min-w-0 flex-1 bg-card p-4">
        <div className="flex items-center justify-between border-b border-border pb-2.5">
          <span className="text-[11px] font-medium">Обзор</span>
          <div className="flex items-center gap-2 text-[9px] text-ink3">
            <span>7д</span>
            <span className="relative text-foreground">30д<span className="absolute inset-x-0 -bottom-1 h-px bg-primary" /></span>
            <span>90д</span>
            <span className="h-2.5 w-px bg-border" />
            <Calendar className="h-3 w-3 text-ink2" />
          </div>
        </div>

        <div className="pt-3">
          <div className="text-[9px] text-ink3">Просмотры · 30 дней</div>
          <div className="mt-1 flex items-end justify-between gap-3">
            <div className="flex items-baseline gap-2">
              <motion.span className="text-[34px] font-medium leading-none tabular-nums">{viewsText}</motion.span>
              <motion.span
                initial={reduce ? false : { opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: reduce ? 0 : 1.5, duration: 0.4, ease: EASE }}
                className="rounded bg-green-tint px-1.5 py-0.5 text-[9px] font-medium tabular-nums text-verdant"
              >↑ 8.4%</motion.span>
            </div>
            <div className="w-[46%]"><HeroSparkline reduce={reduce} /></div>
          </div>
          <div className="mt-1 text-[8px] text-ink3">к прошлому периоду · ≈2 835 на пост</div>
        </div>

        {/* KPI tiles pop in from different angles */}
        <div className="mt-3 grid grid-cols-4 gap-2 border-t border-border pt-3">
          <KpiTile reduce={reduce} label="Подписчики" value="4 781" delta="−108" fx={-90} fy={-30} frot={-7} delay={0.55} />
          <KpiTile reduce={reduce} label="Ср. охват" value="2 835" delta="+4%" up fx={40} fy={-80} frot={6} delay={0.68} />
          <KpiTile reduce={reduce} label="Реакции" value="1 204" delta="+58" up fx={-30} fy={80} frot={5} delay={0.81} />
          <KpiTile reduce={reduce} label="Вовлечённость" value="6.7%" delta="+0.4" up fx={90} fy={36} frot={-6} delay={0.94} />
        </div>

        <div className="mt-3 border-t border-border pt-2">
          <div className="pb-1 text-[9px] text-ink3">Лучшие публикации</div>
          <motion.div {...fade(1.05)}><PostRow n={1} title="Как мы выбираем темы для канала" views="12 480" er="9.1%" delta="+24%" up /></motion.div>
          <motion.div {...fade(1.15)}><PostRow n={2} title="Большой гайд по продуктивности" views="8 902" er="7.4%" delta="−6%" /></motion.div>
          <motion.div {...fade(1.25)}><PostRow n={3} title="Подкаст: итоги сезона и планы" views="7 415" er="6.2%" delta="+11%" up /></motion.div>
        </div>

        {/* self-typing insight */}
        <motion.div {...fade(1.5)} className="mt-3 flex items-start gap-2 border-t border-border pt-2.5">
          <span className="mt-0.5 rounded bg-amber-tint px-1 py-0.5 text-[8px] font-medium text-status-warn">Риск</span>
          <p className="text-[10px] leading-snug text-ink2">
            <motion.span>{typed}</motion.span>
            {!reduce && <span className="ml-px inline-block animate-pulse text-primary">▍</span>}
          </p>
        </motion.div>
      </div>
    </motion.div>
  );
}

function HeroCopy({ reduce }: { reduce: boolean }) {
  const container = { hidden: {}, show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } } };
  const item = {
    hidden: { opacity: 0, y: 16 },
    show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } },
  };
  return (
    <motion.div variants={container} initial={reduce ? false : 'hidden'} animate="show">
      <motion.div variants={item} className="text-[13px] font-medium text-primary">Telegram + Instagram</motion.div>
      <motion.h1 variants={item} className="mt-4 text-[clamp(54px,8vw,76px)] font-medium leading-[0.95] tracking-tight text-foreground">Atlavue</motion.h1>
      <motion.p variants={item} className="mt-5 max-w-[22em] text-[clamp(18px,1.6vw,22px)] leading-snug text-ink2">
        Аналитика Telegram и Instagram без лишнего шума
      </motion.p>
      <motion.div variants={item} className="mt-8 flex flex-wrap items-center gap-3">
        <Link to="/register" className="btn-pill bg-primary px-5 py-3 text-[15px] font-medium text-primary-foreground transition-colors hover:bg-primary/90">
          Создать аккаунт
        </Link>
        <Link to="/login" className="btn-pill border border-border bg-card px-5 py-3 text-[15px] font-medium text-foreground transition-colors hover:bg-muted">
          Посмотреть демо
        </Link>
      </motion.div>
      <motion.p variants={item} className="mt-5 text-[13px] text-ink3">Демо доступно без регистрации · данные собираются локально</motion.p>
    </motion.div>
  );
}

function Hero() {
  const reduce = useReducedMotion() ?? false;
  return (
    <section className="relative border-b border-border">
      <HeroAurora />
      <div className={`${MAXW} relative z-1 grid items-center gap-12 py-16 md:grid-cols-[minmax(0,420px)_1fr] md:py-24`}>
        <HeroCopy reduce={reduce} />
        <div className="relative hidden md:block">
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_30px_70px_-40px_rgba(20,24,40,0.28)]">
            <DashboardMock reduce={reduce} />
          </div>
          <FloatingCards reduce={reduce} />
        </div>
      </div>
    </section>
  );
}

// ── floating peripheral UI: pops in from an angle, then gently bobs ──────────
function FloatBob({
  children, className, fromX, fromY, delay, bob, reduce,
}: {
  children: ReactNode; className: string; fromX: number; fromY: number;
  delay: number; bob: number; reduce: boolean;
}) {
  return (
    <motion.div
      className={`absolute z-20 ${className}`}
      initial={reduce ? false : { opacity: 0, x: fromX, y: fromY, scale: 0.85 }}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      transition={{ ...SPRING, delay: reduce ? 0 : delay }}
    >
      <motion.div
        className="will-change-transform backface-hidden"
        animate={reduce ? undefined : { y: [0, -6, 0] }}
        transition={reduce ? undefined : { duration: bob, repeat: Infinity, ease: 'easeInOut', delay }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

function FloatCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2 shadow-[0_20px_44px_-22px_rgba(20,24,40,0.5)]">
      {children}
    </div>
  );
}

function FloatingCards({ reduce }: { reduce: boolean }) {
  return (
    <>
      <FloatBob reduce={reduce} className="-left-10 -top-3" fromX={-50} fromY={-40} delay={0.8} bob={4.5}>
        <FloatCard>
          <div className="text-[10px] text-ink3">Новые подписчики</div>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className="text-[18px] font-medium tabular-nums text-foreground">+124</span>
            <span className="text-[10px] font-medium text-verdant">за 24 ч</span>
          </div>
        </FloatCard>
      </FloatBob>

      <FloatBob reduce={reduce} className="-right-12 top-[38%]" fromX={56} fromY={-10} delay={1.0} bob={5.2}>
        <FloatCard>
          <div className="flex items-center gap-2.5">
            <svg width="34" height="34" viewBox="0 0 36 36" aria-hidden="true">
              <circle cx="18" cy="18" r="15" fill="none" stroke="hsl(var(--border))" strokeWidth="4" />
              <circle
                cx="18" cy="18" r="15" fill="none" stroke="hsl(var(--primary))" strokeWidth="4"
                strokeDasharray="94.2" strokeDashoffset="24" strokeLinecap="round" transform="rotate(-90 18 18)"
              />
            </svg>
            <div>
              <div className="text-[15px] font-medium tabular-nums text-foreground">75%</div>
              <div className="text-[9px] text-ink3">Цель месяца</div>
            </div>
          </div>
        </FloatCard>
      </FloatBob>

      <FloatBob reduce={reduce} className="-bottom-7 left-10" fromX={-24} fromY={52} delay={1.2} bob={4.8}>
        <FloatCard>
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-green-tint text-verdant">
              <Check className="h-3 w-3" />
            </span>
            <div>
              <div className="text-[14px] font-medium tabular-nums text-foreground">1 204 <span className="text-[10px] font-medium text-verdant">+58</span></div>
              <div className="text-[9px] text-ink3">Реакции сегодня</div>
            </div>
          </div>
        </FloatCard>
      </FloatBob>
    </>
  );
}

// ── scroll-reveal wrapper for the sections below the hero ────────────────────
function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const reduce = useReducedMotion() ?? false;
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.6, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}

// ── page sections ──────────────────────────────────────────────────────────
function Header() {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur-sm">
      <div className={`${MAXW} flex h-[68px] items-center justify-between`}>
        <Link to="/" className="flex items-center gap-2.5">
          <AtlavueMark className="h-[18px] w-[18px] text-primary" />
          <span className="text-[17px] font-medium tracking-tight text-foreground">Atlavue</span>
        </Link>
        <nav className="flex items-center gap-6 sm:gap-7">
          <a href="#features" className="hidden text-sm text-ink2 transition-colors hover:text-foreground sm:block">Возможности</a>
          <a href="#security" className="hidden text-sm text-ink2 transition-colors hover:text-foreground sm:block">Безопасность</a>
          <Link to="/login" className="text-sm font-medium text-foreground transition-colors hover:text-primary">Войти</Link>
          <Link to="/register" className="btn-pill bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90">
            Начать
          </Link>
        </nav>
      </div>
    </header>
  );
}

function Pillars() {
  const items = [
    { h: 'Локальный сбор данных', p: 'Collector работает на вашей стороне. Сессия Telegram не попадает в Atlavue.', icon: Shield },
    { h: 'Инсайты по постам', p: 'Сигнал → тезис → действие по каждому посту, а не просто графики.', icon: Lightbulb },
    { h: 'Состояние источников', p: 'Источник, последний сбор, версия сборщика и статус API — на виду.', icon: AtlavueMark },
  ];
  return (
    <section id="security" className="border-b border-border">
      <Reveal className={`${MAXW} py-16`}>
        <div className="text-[13px] font-medium text-ink3">Почему Atlavue</div>
        <h2 className="mt-2 max-w-[16em] text-[clamp(24px,3vw,30px)] font-medium tracking-tight text-foreground">
          Спокойная аналитика, которой можно доверять
        </h2>
        <div className="mt-10 grid gap-px overflow-hidden md:grid-cols-3">
          {items.map((it, i) => {
            const Ico = it.icon;
            return (
            <div key={it.h} className={`${i > 0 ? 'md:border-l md:border-border md:pl-10' : ''} ${i < items.length - 1 ? 'md:pr-10' : ''}`}>
              <Ico className="h-5 w-5 text-foreground" />
              <h3 className="mt-3 text-[17px] font-medium text-foreground">{it.h}</h3>
              <p className="mt-2 max-w-[20em] text-sm leading-relaxed text-ink2">{it.p}</p>
            </div>
            );
          })}
        </div>
      </Reveal>
    </section>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-xl border border-border bg-card p-5">{children}</div>;
}

function KpiFragment() {
  return (
    <Panel>
      <div className="text-[11px] text-ink3">Просмотры · 30 дней</div>
      <div className="mt-1 flex items-end justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <span className="text-[40px] font-medium leading-none tabular-nums text-foreground">48 210</span>
          <span className="rounded bg-green-tint px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-verdant">↑ 8.4%</span>
        </div>
        <div className="w-[42%]"><Sparkline /></div>
      </div>
      <div className="mt-1.5 text-[11px] text-ink3">к прошлому периоду · ≈2 835 на пост</div>
      <div className="mt-4 flex gap-3 border-t border-border pt-4">
        <Col label="Подписчики" value="4 781" delta="−108" />
        <Col label="Ср. охват" value="2 835" delta="+4%" up />
        <Col label="Реакции" value="1 204" delta="+58" up />
        <Col label="Вовлечённость" value="6.7%" delta="+0.4" up />
      </div>
    </Panel>
  );
}

function InsightFragment() {
  return (
    <Panel>
      <div className="text-[11px] text-ink3">Инсайт</div>
      <div className="mt-3 flex items-center gap-2.5">
        <span className="rounded bg-amber-tint px-1.5 py-0.5 text-[11px] font-medium text-status-warn">Риск</span>
        <span className="text-[15px] font-medium text-foreground">Охват растёт, база сжимается</span>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-ink2">
        Подписчиков стало меньше на 108 при росте просмотров на 8%.
      </p>
      <p className="mt-3 flex items-start gap-2 text-sm text-ink2">
        <span className="text-primary">→</span>
        Проверьте посты перед оттоком в разделе «Рост».
      </p>
      <div className="mt-3 text-[13px] font-medium text-primary">Топ-пост: «Как мы выбираем темы» →</div>
    </Panel>
  );
}

function HealthRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-t border-border py-2.5 first:border-t-0 first:pt-0">
      <span className="text-[13px] text-ink2">{label}</span>
      <span className="font-mono text-[12px] tabular-nums text-ink3">{value}</span>
    </div>
  );
}

function HealthFragment() {
  return (
    <Panel>
      <div className="text-[11px] text-ink3">Состояние данных</div>
      <div className="mt-3">
        <HealthRow label="Источник" value="Telegram · MTProto" />
        <HealthRow label="Последний сбор" value="09:14 · 2 ч назад" />
        <HealthRow label="Сборщик" value="v1.0.5" />
        <HealthRow
          label="API"
          value={<span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-verdant" />200 OK</span>}
        />
      </div>
      <div className="mt-3 text-[13px] font-medium text-primary">Настроить сбор →</div>
    </Panel>
  );
}

function Feature({
  eyebrow,
  title,
  body,
  bullets,
  fragment,
  reverse,
}: {
  eyebrow: string;
  title: string;
  body: string;
  bullets: string[];
  fragment: ReactNode;
  reverse?: boolean;
}) {
  return (
    <section className="border-b border-border">
      <div className={`${MAXW} grid items-center gap-12 py-16 md:grid-cols-2`}>
        <Reveal className={reverse ? 'md:order-2' : ''}>
          <div className="text-[13px] font-medium text-primary">{eyebrow}</div>
          <h2 className="mt-3 max-w-[12em] text-[clamp(24px,3vw,30px)] font-medium tracking-tight text-foreground">{title}</h2>
          <p className="mt-3 max-w-[26em] text-base leading-relaxed text-ink2">{body}</p>
          <ul className="mt-5 space-y-2.5">
            {bullets.map((b) => (
              <li key={b} className="flex items-center gap-2.5 text-sm text-ink2">
                <Check className="h-4 w-4 shrink-0 text-primary" />
                {b}
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal className={reverse ? 'md:order-1' : ''} delay={0.1}>{fragment}</Reveal>
      </div>
    </section>
  );
}

function CtaBand() {
  return (
    <section className="bg-blue-tint">
      <Reveal className={`${MAXW} flex flex-col items-center py-20 text-center`}>
        <h2 className="text-[clamp(28px,4vw,36px)] font-medium tracking-tight text-foreground">Начните за минуту</h2>
        <p className="mt-4 max-w-[28em] text-[17px] text-ink2">Подключите канал или откройте демо без регистрации.</p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <Link to="/register" className="btn-pill bg-primary px-5 py-3 text-[15px] font-medium text-primary-foreground transition-colors hover:bg-primary/90">
            Создать аккаунт
          </Link>
          <Link to="/login" className="btn-pill border border-border bg-card px-5 py-3 text-[15px] font-medium text-foreground transition-colors hover:bg-muted">
            Посмотреть демо
          </Link>
        </div>
      </Reveal>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border">
      <div className={`${MAXW} flex flex-col items-start justify-between gap-4 py-10 sm:flex-row sm:items-center`}>
        <div className="flex items-center gap-2.5 text-[13px] text-ink3">
          <AtlavueMark className="h-[18px] w-[18px] text-ink3" />
          Atlavue · спокойная аналитика
        </div>
        <nav className="flex items-center gap-6 text-[13px] text-ink3">
          <a href="#features" className="transition-colors hover:text-foreground">Возможности</a>
          <a href="#security" className="transition-colors hover:text-foreground">Безопасность</a>
          <Link to="/login" className="transition-colors hover:text-foreground">Войти</Link>
          <Link to="/register" className="transition-colors hover:text-foreground">Создать аккаунт</Link>
        </nav>
      </div>
    </footer>
  );
}

export function Landing() {
  return (
    <div className="force-light min-h-screen overflow-x-hidden bg-background text-foreground">
      <Header />
      <Hero />
      <Pillars />
      <div id="features">
        <Feature
          eyebrow="Обзор"
          title="Весь канал на одном экране"
          body="Просмотры, охват, реакции и вовлечённость — одним взглядом, с дельтой к прошлому периоду."
          bullets={['Главная метрика + спарклайн с пиками', 'KPI-ledger: 4 показателя в строке', 'Сравнение с прошлым периодом']}
          fragment={<KpiFragment />}
        />
        <Feature
          eyebrow="Инсайты"
          title="Инсайты, а не просто графики"
          body="Каждый сигнал — это готовый вывод и следующий шаг, а не ещё один график, который надо толковать."
          bullets={['Сигнал: Риск или Рост', 'Тезис простым языком', 'Действие и ссылка-доказательство']}
          fragment={<InsightFragment />}
          reverse
        />
        <Feature
          eyebrow="Данные"
          title="Источники под контролем"
          body="Видно, откуда данные, когда собраны в последний раз и здоров ли сборщик — без догадок."
          bullets={['Источник и последний сбор', 'Версия сборщика', 'Статус API в реальном времени']}
          fragment={<HealthFragment />}
        />
      </div>
      <CtaBand />
      <Footer />
    </div>
  );
}
