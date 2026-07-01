import { useNavigate } from 'react-router-dom';
import { useDemo } from '@/lib/demo-context';

/** Warm line-art bloom — echoes the empty-state illustration, in the light "refined technical"
 *  palette (hairline strokes, one accent). Purely decorative. */
function BloomArt() {
  return (
    <svg viewBox="0 0 240 190" className="h-40 w-52" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-border">
        {/* ground */}
        <path d="M40 168 H150" strokeDasharray="2 7" className="text-border" />
        <path d="M168 168 H206" strokeDasharray="2 7" className="text-border" />
        {/* left — closed bud on a curved stem */}
        <path d="M96 168 C92 130 96 108 108 92" />
        <path d="M108 92 C98 86 92 74 98 64 C106 70 110 82 108 92 Z" />
        <path d="M108 92 C118 86 124 74 118 64 C110 70 106 82 108 92 Z" />
        <path d="M99 128 C88 122 82 128 82 136 C92 137 99 133 99 128 Z" className="text-border" />
      </g>
      {/* right — open bloom with the single accent */}
      <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-border">
        <path d="M162 168 C168 128 160 96 150 74" />
        <path d="M150 74 C138 66 132 74 134 82 C144 84 150 80 150 74 Z" className="text-border" />
      </g>
      <g transform="translate(150 58)">
        {[0, 60, 120, 180, 240, 300].map((deg) => (
          <ellipse
            key={deg}
            cx="0"
            cy="-13"
            rx="6.5"
            ry="12"
            transform={`rotate(${deg})`}
            className="fill-primary/10 stroke-primary/70"
            strokeWidth="1.5"
          />
        ))}
        <circle cx="0" cy="0" r="5" className="fill-primary/20 stroke-primary" strokeWidth="1.5" />
      </g>
    </svg>
  );
}

/**
 * First-run onboarding — shown when a signed-in user has no channels yet (and isn't in demo mode).
 * Two paths: connect real data (→ setup) or explore the product filled with sample data (demo mode).
 */
export function GetStarted() {
  const navigate = useNavigate();
  const { enterDemo } = useDemo();

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center px-4 py-10 text-center">
      <div className="text-ink3">
        <BloomArt />
      </div>

      <h1 className="mt-6 text-2xl font-medium tracking-tight text-foreground">Начните работу</h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
        Подключите свой канал — и увидите аналитику Telegram и Instagram в одном месте. Или посмотрите,
        как это выглядит, на демо-данных.
      </p>

      <div className="mt-7 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={() => navigate('/settings')}
          className="btn-pill bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Подключить данные
        </button>
        <button
          type="button"
          onClick={enterDemo}
          className="btn-pill border border-border bg-background px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          Демо-данные
        </button>
      </div>

      <div className="mt-12 w-full border-t border-border pt-5">
        <p className="text-xs text-muted-foreground">Нужна помощь с настройкой?</p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm">
          <button
            type="button"
            onClick={() => navigate('/connect')}
            className="font-medium text-primary hover:underline"
          >
            Как это работает
          </button>
          <a href="mailto:schulmannn@gmail.com" className="font-medium text-primary hover:underline">
            Написать нам
          </a>
        </div>
      </div>
    </div>
  );
}
