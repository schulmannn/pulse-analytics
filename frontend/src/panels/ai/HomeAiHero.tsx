import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMe } from '@/api/queries';
import { useAiChats, useCreateAiChat } from '@/api/aiChat';

/**
 * AI-hero Главной (STEEP-паттерн): приветствие + «Спросить что угодно…» + недавние чаты.
 * Рендерится ТОЛЬКО на desktop-ветке Главной и только при me.ai.enabled (v1 — владелец;
 * mobile-ветка Главной не меняется). Лёгкий по зависимостям — едет в entry-чанке вместе с Home;
 * тяжёлая механика стриминга живёт в lazy-странице /ai.
 *
 * Отправка: создаём пустой чат → уходим на /ai/:id с вопросом в router-state — страница чата
 * автоотправляет его и стримит ответ (один общий streaming-путь, без дублирования логики).
 */
export function HomeAiHero() {
  const me = useMe();
  const aiEnabled = !!me.data?.ai?.enabled;
  const chatsQuery = useAiChats(aiEnabled);
  const create = useCreateAiChat();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!aiEnabled) return null;

  const ask = () => {
    const q = text.trim();
    if (!q || create.isPending) return;
    setError(null);
    create.mutate(undefined, {
      onSuccess: ({ chat }) => navigate(`/ai/${chat.id}`, { state: { q } }),
      onError: (e) => setError(e instanceof Error ? e.message : 'Не удалось создать чат'),
    });
  };

  const recent = (chatsQuery.data?.chats ?? []).slice(0, 4);

  return (
    <section aria-label="AI-ассистент" className="mb-8">
      <h3 className="text-2xl font-medium tracking-tight text-foreground">{greeting()}</h3>
      <div className="mt-4 flex items-start gap-8">
        <form
          className="min-w-0 max-w-2xl flex-1 rounded-2xl border border-border bg-card p-4 transition-colors focus-within:border-primary/50"
          onSubmit={(e) => {
            e.preventDefault();
            ask();
          }}
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                ask();
              }
            }}
            rows={2}
            maxLength={4000}
            placeholder="Спросите о ваших метриках: «Как вырос канал за месяц?», «Какие посты зашли лучше всего?»"
            aria-label="Вопрос AI-ассистенту"
            className="w-full resize-none bg-transparent text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-2xs font-medium tracking-wide text-muted-foreground">
              AI-аналитик Atlavue · отвечает по данным ваших источников
            </span>
            <button
              type="submit"
              disabled={!text.trim() || create.isPending}
              className="btn-pill inline-flex items-center gap-1.5 bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {create.isPending ? 'Открываю…' : 'Спросить'}
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5" aria-hidden="true">
                <path d="M8 12V4M4.5 7.5 8 4l3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </form>

        <div className="hidden w-64 shrink-0 lg:block">
          <div className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">Недавние чаты</div>
          <ul className="mt-2 space-y-0.5">
            {recent.map((chat) => (
              <li key={chat.id}>
                <Link
                  to={`/ai/${chat.id}`}
                  className="block truncate rounded px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  title={chat.title || 'Без названия'}
                >
                  {chat.title || 'Без названия'}
                </Link>
              </li>
            ))}
          </ul>
          <Link
            to="/ai"
            className="mt-1 flex items-center gap-1.5 rounded px-2 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4 shrink-0 text-primary" aria-hidden="true">
              <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5c3 0 5.5 2.5 5.5 5.5Z" />
              <path d="M8 5.8v4.4M5.8 8h4.4" strokeLinecap="round" />
            </svg>
            Новый AI-чат
          </Link>
        </div>
      </div>
    </section>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Доброй ночи!';
  if (h < 12) return 'Доброе утро!';
  if (h < 18) return 'Добрый день!';
  return 'Добрый вечер!';
}
