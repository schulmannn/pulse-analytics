import { Link } from 'react-router-dom';

interface CollectorEmptyStateProps {
  username: string;
}

const STEPS: { title: string; body: string; to: string | null; cta: string | null }[] = [
  {
    title: 'Получите ключ канала',
    body: 'API-ключ этого канала лежит в Настройках.',
    to: '/settings',
    cta: 'Открыть настройки',
  },
  {
    title: 'Запустите collector-агент',
    body: 'Скачайте агент и запустите его у себя — он считает метрики локально и шлёт их сюда.',
    to: '/connect',
    cta: 'Инструкция по подключению',
  },
  {
    title: 'Данные появятся здесь',
    body: 'После первого снимка от агента дашборд заполнится автоматически — обновлять не нужно.',
    to: null,
    cta: null,
  },
];

/** Onboarding empty state for a collector channel that hasn't sent data yet — a concrete
    next-step checklist rather than a bare "нет данных". */
export function CollectorEmptyState({ username }: CollectorEmptyStateProps) {
  return (
    <div className="max-w-lg rounded border border-border bg-background p-6">
      <div className="space-y-1.5">
        <h3 className="font-medium leading-none tracking-tight text-foreground">Канал @{username} подключён — ждём первые данные</h3>
        <p className="text-sm text-muted-foreground">
          Collector-агент считает метрики у вас локально. Осталось три шага:
        </p>
      </div>
      <div>
        <ol className="mt-6 space-y-4">
          {STEPS.map((step, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium text-muted-foreground">
                {i + 1}
              </span>
              <div className="space-y-1">
                <div className="text-sm font-medium text-foreground">{step.title}</div>
                <p className="text-sm text-muted-foreground">{step.body}</p>
                {step.to && step.cta && (
                  <Link to={step.to} className="inline-block text-sm font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">
                    {step.cta} →
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
