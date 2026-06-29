import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

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
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle className="text-foreground">Канал @{username} подключён — ждём первые данные</CardTitle>
        <p className="text-sm text-muted-foreground">
          Collector-агент считает метрики у вас локально. Осталось три шага:
        </p>
      </CardHeader>
      <CardContent>
        <ol className="space-y-4">
          {STEPS.map((step, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold text-muted-foreground">
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
      </CardContent>
    </Card>
  );
}
