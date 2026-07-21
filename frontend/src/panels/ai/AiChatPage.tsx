import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useChannels, useMe } from '@/api/queries';
import { AiAskControls, AiSendButton } from '@/panels/ai/AiAskControls';
import { AiEmptyState } from '@/panels/ai/AiEmptyState';
import { composeAiQuestion, emptyAiAskContext, type AiAskContext } from '@/lib/aiAsk';
import {
  aiToolLabel,
  useAiChat,
  useAiChats,
  useCreateAiChat,
  useDeleteAiChat,
  type AiMessage,
  type AiToolTrace,
} from '@/api/aiChat';
import { streamAiMessage, AiStreamError } from '@/lib/aiStream';
import { parseAiBlocks } from '@/lib/aiMessage';
import { RichText } from '@/components/RichText';
import { ErrorState } from '@/components/ErrorState';
import { NotFound } from '@/components/NotFound';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * AI-чат (lazy-роут /ai и /ai/:chatId). Один streaming-путь на всё приложение: hero Главной и
 * индекс чатов только СОЗДАЮТ чат и передают вопрос router-state'ом — стримит всегда эта страница.
 *
 * Поток ответа: POST …/messages → SSE (lib/aiStream). Пока идёт стрим, ход живёт в локальном
 * pending-состоянии (вопрос + растущий ответ + чипы инструментов); на done инвалидируется запрос
 * чата — персистентная версия хода приходит с сервера, pending снимается без мигания.
 */

type PendingTool = { name: string; status: 'start' | 'end' | 'error' };
type Pending = { question: string; answer: string; tools: PendingTool[] };

export function AiChatPage() {
  const { chatId: chatIdParam } = useParams();
  const me = useMe();
  const chatId = chatIdParam ? Number.parseInt(chatIdParam, 10) : null;
  // Гейт фичи: без ai.enabled страница неотличима от несуществующей (v1 — superuser-only).
  if (me.data && !me.data.ai?.enabled) return <NotFound />;
  if (chatId != null && (!Number.isInteger(chatId) || chatId <= 0)) return <NotFound />;
  return chatId == null ? <ChatIndex /> : <ChatThread key={chatId} chatId={chatId} />;
}

// ── Экран нового чата (STEEP): шапка с дропдауном недавних, глиф по центру, композер внизу ──────
function ChatIndex() {
  const chatsQuery = useAiChats(true);
  const channels = useChannels().data?.channels ?? [];
  const create = useCreateAiChat();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [ctx, setCtx] = useState<AiAskContext>(emptyAiAskContext);
  const [error, setError] = useState<string | null>(null);

  // Единая отправка: и составленный из композера вопрос, и клик по подсказке.
  const askWith = (q: string) => {
    if (!q.trim() || create.isPending) return;
    setError(null);
    create.mutate(undefined, {
      onSuccess: ({ chat }) => navigate(`/ai/${chat.id}`, { state: { q } }),
      onError: (e) => setError(e instanceof Error ? e.message : 'Не удалось создать чат'),
    });
  };
  const ask = () => {
    if (!text.trim()) return;
    askWith(composeAiQuestion(text, ctx, channels));
  };

  const chats = chatsQuery.data?.chats ?? [];
  const usage = chatsQuery.data?.usage;

  return (
    <div className="mx-auto flex min-h-[calc(100vh-8rem)] max-w-3xl flex-col">
      <div className="sticky top-0 z-sticky -mx-4 flex items-center justify-between gap-3 bg-background px-4 py-3 sm:-mx-6 sm:px-6">
        <RecentChatsMenu chats={chats} />
        {usage && (
          <span className="text-2xs font-medium text-muted-foreground" title="Вопросов сегодня / дневной лимит">
            {usage.used}/{usage.limit} за сегодня
          </span>
        )}
      </div>

      <div className="flex flex-1 items-center justify-center py-10">
        <AiEmptyState disabled={create.isPending} onPick={askWith} />
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-border bg-card px-3 py-2 text-sm text-destructive" role="alert">
          {error}
        </div>
      )}

      <form
        className="sticky bottom-0 -mx-4 bg-background px-4 py-3 sm:-mx-6 sm:px-6"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <div className="rounded-2xl border border-border bg-card p-2.5 transition-colors focus-within:border-primary/50">
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
            disabled={create.isPending}
            placeholder="Спросите о ваших метриках…"
            aria-label="Вопрос AI-ассистенту"
            className="w-full resize-none bg-transparent px-1.5 text-sm leading-relaxed text-foreground outline-hidden placeholder:text-muted-foreground disabled:opacity-60"
          />
          <div className="mt-1.5 flex items-end justify-between gap-2">
            <AiAskControls ctx={ctx} onCtx={setCtx} disabled={create.isPending} />
            <AiSendButton disabled={!text.trim() || create.isPending} busy={create.isPending} />
          </div>
        </div>
      </form>
    </div>
  );
}

/** Заголовок «Новый AI-чат» с STEEP-дропдауном недавних чатов (⌄ появляется, когда чаты есть). */
function RecentChatsMenu({ chats }: { chats: { id: number; title: string }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!chats.length) {
    return <h2 className="text-base font-medium text-foreground">Новый AI-чат</h2>;
  }
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded px-1 py-0.5 text-base font-medium text-foreground transition-colors hover:bg-muted"
      >
        Новый AI-чат
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true">
          <path d="m4 6.5 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-popover mt-2 w-72 rounded-xl border border-border bg-card p-1.5">
          <div className="px-2.5 py-1 text-2xs font-medium tracking-wider text-muted-foreground">Недавние чаты</div>
          {chats.slice(0, 10).map((chat) => (
            <Link
              key={chat.id}
              to={`/ai/${chat.id}`}
              onClick={() => setOpen(false)}
              className="block truncate rounded px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={chat.title || 'Без названия'}
            >
              {chat.title || 'Без названия'}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Тред: сообщения + стриминг ───────────────────────────────────────────────────────────────────
function ChatThread({ chatId }: { chatId: number }) {
  const query = useAiChat(chatId);
  const channels = useChannels().data?.channels ?? [];
  const create = useCreateAiChat();
  const del = useDeleteAiChat();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [pending, setPending] = useState<Pending | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [ctx, setCtx] = useState<AiAskContext>(emptyAiAskContext);
  const abortRef = useRef<AbortController | null>(null);
  const autoSentRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const messages = useMemo(() => query.data?.messages ?? [], [query.data]);

  // Живой автоскролл: держим низ треда в поле зрения, пока приходят дельты/сообщения.
  const answerLen = pending ? pending.answer.length : -1;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, answerLen]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = (raw: string) => {
    const q = raw.trim();
    if (!q || pending) return;
    setBanner(null);
    setPending({ question: q, answer: '', tools: [] });
    const abort = new AbortController();
    abortRef.current = abort;
    void streamAiMessage(chatId, q, {
      signal: abort.signal,
      onEvent: (ev) => {
        if (ev.type === 'text') {
          setPending((p) => (p ? { ...p, answer: p.answer + ev.delta } : p));
        } else if (ev.type === 'tool') {
          setPending((p) => {
            if (!p) return p;
            const tools = [...p.tools];
            const i = tools.findIndex((t) => t.name === ev.name && t.status === 'start');
            if (ev.status === 'start') tools.push({ name: ev.name, status: 'start' });
            else if (i >= 0) tools[i] = { name: ev.name, status: ev.status };
            else tools.push({ name: ev.name, status: ev.status });
            return { ...p, tools };
          });
        } else if (ev.type === 'error') {
          setBanner(ev.message);
        } else if (ev.type === 'done' || ev.type === 'meta') {
          if (ev.type === 'meta') void qc.invalidateQueries({ queryKey: ['ai-chats'] });
        }
      },
    })
      .catch((e) => {
        if (abort.signal.aborted) return;
        setBanner(e instanceof AiStreamError ? e.message : 'Соединение прервано. Попробуйте ещё раз.');
      })
      .finally(() => {
        // Персистентная версия хода (включая частичный ответ при сбое) приходит рефетчем;
        // pending снимается только после него — без мигания и без дублей.
        void qc.invalidateQueries({ queryKey: ['ai-chat', chatId] }).finally(() => {
          setPending(null);
          void qc.invalidateQueries({ queryKey: ['ai-chats'] });
        });
      });
  };

  // Композер: текст + выбранный контекст (@источники, период) → один составленный вопрос.
  const submit = () => {
    if (!text.trim() || pending) return;
    send(composeAiQuestion(text, ctx, channels));
    setText('');
    setCtx(emptyAiAskContext);
  };

  // Вопрос, принесённый router-state'ом (hero Главной / индекс): автоотправка ровно один раз,
  // state сразу очищается — F5 не переспросит.
  useEffect(() => {
    const q = (location.state as { q?: string } | null)?.q;
    if (!q || autoSentRef.current || !query.isSuccess) return;
    autoSentRef.current = true;
    navigate(location.pathname, { replace: true, state: null });
    send(q);
    // send стабилен в рамках жизни компонента (замыкание на chatId через key-remount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, query.isSuccess]);

  if (query.isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-2/3" />
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <div className="mx-auto max-w-3xl">
        <ErrorState
          title="Чат не найден"
          reason={query.error instanceof Error ? query.error.message : 'Возможно, он был удалён'}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
        <Link to="/ai" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">
          ← Все чаты
        </Link>
      </div>
    );
  }

  const { chat } = query.data;
  const title = chat.title || pending?.question || 'Новый чат';

  return (
    <div className="mx-auto flex min-h-[calc(100vh-8rem)] max-w-3xl flex-col">
      <div className="sticky top-0 z-sticky -mx-4 flex items-center justify-between gap-3 bg-background px-4 py-3 sm:-mx-6 sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to="/ai"
            aria-label="Все чаты"
            title="Все чаты"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4" aria-hidden="true">
              <path d="M10 3 5 8l5 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
          <h2 className="truncate text-base font-medium text-foreground" title={title}>{title}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            disabled={create.isPending || !!pending}
            onClick={() =>
              create.mutate(undefined, { onSuccess: ({ chat: next }) => navigate(`/ai/${next.id}`) })
            }
            className="btn-pill border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            Новый чат
          </button>
          <button
            type="button"
            aria-label="Удалить чат"
            title="Удалить чат"
            disabled={del.isPending || !!pending}
            onClick={() => del.mutate(chatId, { onSuccess: () => navigate('/ai') })}
            className="rounded p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-50"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4" aria-hidden="true">
              <path d="M3 5h10M6.5 5V3.5h3V5M5 5l.6 8h4.8L11 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* Пустой тред центрирует STEEP-глиф с подсказками; с первым же сообщением — обычная лента. */}
      <div className={`flex-1 py-4 ${messages.length === 0 && !pending && !banner ? 'flex items-center justify-center' : 'space-y-6'}`}>
        {messages.length === 0 && !pending && !banner && (
          <AiEmptyState disabled={!!pending} onPick={(q) => send(q)} />
        )}
        {messages.map((m) => (
          <MessageRow key={m.id} message={m} />
        ))}
        {pending && (
          <>
            <UserBubble text={pending.question} />
            <div className="max-w-none">
              <ToolChips tools={pending.tools} streaming />
              {pending.answer ? (
                <div className="mt-1.5">
                  <AiRichBlocks text={pending.answer} />
                  <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-primary align-middle" aria-hidden="true" />
                </div>
              ) : (
                <p className="mt-1.5 flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner />
                  Ассистент думает…
                </p>
              )}
            </div>
          </>
        )}
        {banner && (
          <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-destructive" role="alert">
            {banner}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form
        className="sticky bottom-0 -mx-4 border-t border-border bg-background px-4 py-3 sm:-mx-6 sm:px-6"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="rounded-2xl border border-border bg-card p-2.5 transition-colors focus-within:border-primary/50">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            maxLength={4000}
            disabled={!!pending}
            placeholder={pending ? 'Ассистент отвечает…' : 'Задайте вопрос…'}
            aria-label="Сообщение ассистенту"
            className="max-h-40 w-full resize-none bg-transparent px-1.5 text-sm leading-relaxed text-foreground outline-hidden placeholder:text-muted-foreground disabled:opacity-60"
          />
          <div className="mt-1.5 flex items-end justify-between gap-2">
            <AiAskControls ctx={ctx} onCtx={setCtx} disabled={!!pending} />
            <AiSendButton disabled={!text.trim() || !!pending} />
          </div>
        </div>
      </form>
    </div>
  );
}

// ── Рендер сообщений ─────────────────────────────────────────────────────────────────────────────
function MessageRow({ message }: { message: AiMessage }) {
  if (message.role === 'user') return <UserBubble text={message.content} />;
  const trace = message.tool_trace ?? [];
  return (
    <div className="max-w-none">
      {trace.length > 0 && <ToolChips tools={trace.map((t) => traceToChip(t))} />}
      {message.content ? (
        <div className="mt-1.5">
          <AiRichBlocks text={message.content} />
        </div>
      ) : (
        <p className="mt-1.5 text-sm italic text-muted-foreground">Ответ пуст.</p>
      )}
      {message.error === 'max_tokens' && (
        <p className="mt-1 text-2xs text-muted-foreground">Ответ обрезан по лимиту длины.</p>
      )}
      {message.error && message.error !== 'max_tokens' && (
        <p className="mt-1 text-2xs text-muted-foreground">Ответ был прерван.</p>
      )}
    </div>
  );
}

const traceToChip = (t: AiToolTrace): PendingTool => ({
  name: t.name,
  status: t.ok === false ? 'error' : 'end',
});

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-muted px-4 py-2.5 text-sm leading-relaxed text-foreground">
        {text}
      </div>
    </div>
  );
}

/** Чипы инструментов: во время стрима — активный со спиннером, после — тихая строка «Данные: …». */
function ToolChips({ tools, streaming = false }: { tools: PendingTool[]; streaming?: boolean }) {
  if (!tools.length) return null;
  if (!streaming) {
    const labels = [...new Set(tools.filter((t) => t.status !== 'error').map((t) => aiToolLabel(t.name)))];
    if (!labels.length) return null;
    return (
      <p className="text-2xs font-medium text-muted-foreground">Данные: {labels.join(' · ')}</p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tools.map((t, i) => (
        <span
          // Один инструмент может вызываться несколько раз — индекс в паре с именем стабилен в рамках стрима.
          // eslint-disable-next-line react/no-array-index-key
          key={`${t.name}-${i}`}
          className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-2xs font-medium text-muted-foreground"
        >
          {t.status === 'start' ? <Spinner /> : t.status === 'error' ? <CrossIcon /> : <CheckIcon />}
          {aiToolLabel(t.name)}
        </span>
      ))}
    </div>
  );
}

/** Ответ ассистента: блочный markdown (lib/aiMessage) + безопасный inline-рендер (RichText). */
function AiRichBlocks({ text }: { text: string }) {
  const blocks = parseAiBlocks(text);
  return (
    <div className="space-y-2 text-sm leading-relaxed text-foreground">
      {blocks.map((block, i) => {
        if (block.kind === 'heading') {
          // eslint-disable-next-line react/no-array-index-key
          return (
            <p key={i} className="pt-1 font-medium">
              <RichText text={block.text} />
            </p>
          );
        }
        if (block.kind === 'list') {
          return (
            // eslint-disable-next-line react/no-array-index-key
            <ul key={i} className="space-y-1 pl-5">
              {block.items.map((item, j) => (
                // eslint-disable-next-line react/no-array-index-key
                <li key={j} className="list-disc marker:text-muted-foreground">
                  <RichText text={item} />
                </li>
              ))}
            </ul>
          );
        }
        return (
          // eslint-disable-next-line react/no-array-index-key
          <p key={i} className="whitespace-pre-wrap">
            <RichText text={block.text} />
          </p>
        );
      })}
    </div>
  );
}

function Spinner() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3 animate-spin text-primary" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3 w-3 text-muted-foreground" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function CrossIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3 w-3 text-muted-foreground" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" strokeLinecap="round" />
    </svg>
  );
}
