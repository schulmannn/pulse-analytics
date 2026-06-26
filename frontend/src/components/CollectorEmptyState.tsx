import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface CollectorEmptyStateProps {
  username: string;
}

export function CollectorEmptyState({ username }: CollectorEmptyStateProps) {
  return (
    <Card className="max-w-lg">
      {/* DESIGN: Claude review */}
      <CardHeader>
        <CardTitle className="text-foreground">
          Канал @{username} подключён, но данные ещё не поступали
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Collector-агент считает метрики у тебя локально и шлёт их сюда. Пока он не запущен —
          данных нет.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Link
            to="/connect"
            className="inline-flex items-center justify-center rounded-md border bg-card px-4 py-2 text-sm font-medium text-primary hover:bg-card/80 transition-colors"
          >
            Инструкция по подключению
          </Link>
          <Link
            to="/settings"
            className="inline-flex items-center justify-center rounded-md border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-card/80 transition-colors"
          >
            Открыть настройки / ключ
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
