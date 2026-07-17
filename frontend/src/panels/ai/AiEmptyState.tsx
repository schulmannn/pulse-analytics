import { Cartograph } from '@/components/Cartograph';

/**
 * Пустой AI-чат (STEEP-паттерн): line-art глиф (Cartograph «assistant»), «Чем помочь?» и три
 * кликабельных примера вопроса — клик отправляет вопрос сразу (onPick), без набора текста.
 * Используется и на экране нового чата (/ai), и в пустом треде.
 */

export const AI_SUGGESTIONS = [
  'Как выросли просмотры за последний месяц?',
  'Какие посты зашли лучше всего на этой неделе?',
  'Сравни эту неделю с прошлой',
] as const;

export function AiEmptyState({
  onPick,
  disabled = false,
}: {
  onPick: (q: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col items-center text-center">
      <Cartograph name="assistant" className="h-28" />
      <h3 className="mt-5 text-lg font-medium text-foreground">Чем помочь?</h3>
      <div className="mt-4 flex flex-col items-stretch gap-0.5">
        {AI_SUGGESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            disabled={disabled}
            onClick={() => onPick(q)}
            className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true">
              <path d="M8 2.5 9.6 6.4 13.5 8 9.6 9.6 8 13.5 6.4 9.6 2.5 8 6.4 6.4Z" strokeLinejoin="round" />
            </svg>
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
