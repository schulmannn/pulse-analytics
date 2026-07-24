import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useMentionNotifyLink,
  useMentionNotifyStatus,
  useRunMentionNotify,
  useSetMentionNotify,
  useUnbindMentionNotify,
} from '@/api/queries';
import { Icon } from '@/components/nav-icons';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { cn } from '@/lib/utils';

const DAY_LABELS: Array<[number, string]> = [
  [1, 'Пн'], [2, 'Вт'], [3, 'Ср'], [4, 'Чт'], [5, 'Пт'], [6, 'Сб'], [7, 'Вс'],
];

/**
 * «Уведомления в Telegram» — личная подписка на новые упоминания выбранного канала.
 * Флоу привязки: кнопка выдаёт deep-link t.me/<bot>?start=<token> и открывает его; пока диалог
 * открыт и привязки нет, статус поллится (3с) — нажатие Start в Telegram подхватывается само.
 * Тумблер включается только когда закрыты все требования (бот, привязка, правила, QR-сессия);
 * незакрытые показываются чек-листом. Подписка личная: поиск идёт через СОБСТВЕННУЮ managed-сессию
 * подписчика и тратит его квоту searchPosts (~10/день) одним прогоном в сутки.
 */
export function MentionNotifyDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);

  const [linkOpened, setLinkOpened] = useState(false);
  const status = useMentionNotifyStatus(linkOpened);
  const link = useMentionNotifyLink();
  const toggle = useSetMentionNotify();
  const unbind = useUnbindMentionNotify();
  const testRun = useRunMentionNotify();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const data = status.data;
  const bound = !!data?.binding.bound;
  // Привязка завершилась — глушим поллинг.
  useEffect(() => {
    if (bound) setLinkOpened(false);
  }, [bound]);

  const requirements = data?.requirements;
  const checklist: Array<{ ok: boolean; label: string }> = data
    ? [
        { ok: data.bot_configured, label: 'Бот уведомлений настроен на сервере' },
        { ok: bound, label: 'Личный чат с ботом привязан' },
        { ok: !!requirements?.rules_configured, label: 'Правила упоминаний настроены' },
        {
          ok: requirements?.session_state === 'ok',
          label:
            requirements?.session_state === 'reauth_required'
              ? 'Telegram-сессия недействительна — переподключите аккаунт'
              : 'Telegram подключён по QR (поиск идёт через вашу сессию)',
        },
      ]
    : [];
  const ready = checklist.length > 0 && checklist.every((item) => item.ok);
  const enabled = !!data?.subscription.enabled;

  const connectBot = async () => {
    const res = await link.mutateAsync().catch(() => null);
    if (!res) return;
    window.open(res.url, '_blank', 'noopener');
    setLinkOpened(true);
  };

  // Расписание рендерится напрямую из статуса; каждый клик сразу сохраняется (PUT), пока мутация
  // в полёте — контролы заблокированы. Пустой send_days = «каждый день» (канон сервера).
  const sendDays = data?.subscription.send_days?.length ? data.subscription.send_days : [1, 2, 3, 4, 5, 6, 7];
  const sendHour = data?.subscription.send_hour ?? 10;
  const saveSchedule = (patch: { send_days?: number[]; send_hour?: number }) =>
    toggle.mutate({ enabled, ...patch });
  const toggleDay = (day: number) => {
    const next = sendDays.includes(day) ? sendDays.filter((d) => d !== day) : [...sendDays, day];
    if (next.length === 0) return;   // «ни одного дня» — бессмыслица, последний чип не снимается
    saveSchedule({ send_days: next });
  };

  const testResult = (() => {
    if (!testRun.isSuccess || !testRun.data) return null;
    const r = testRun.data;
    if (r.seed) return 'Отправлена стартовая сводка — проверьте личку.';
    if ((r.fresh ?? 0) === 0) return 'Новых упоминаний нет — бот прислал проверку связи.';
    return `Отправлено сообщений: ${r.sent ?? 0}.`;
  })();

  const error =
    (link.error instanceof Error ? link.error.message : null) ??
    (toggle.error instanceof Error ? toggle.error.message : null) ??
    (unbind.error instanceof Error ? unbind.error.message : null) ??
    (testRun.error instanceof Error ? testRun.error.message : null) ??
    (status.isError ? (status.error instanceof Error ? status.error.message : 'Ошибка запроса') : null);

  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-start justify-center overflow-y-auto bg-background/75 p-8 backdrop-blur-xs backdrop-grayscale"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="my-auto w-full max-w-lg rounded-lg border border-border bg-card shadow-2xl focus:outline-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-6 border-b border-border px-6 py-5">
          <div>
            <h2 id={titleId} className="text-base font-medium text-foreground">Уведомления в Telegram</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Раз в день бот присылает в личку новые упоминания выбранного канала. Поиск идёт через
              вашу Telegram-сессию и тратит вашу квоту searchPosts.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть уведомления"
            title="Закрыть"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Icon name="close" className="size-4" />
          </button>
        </header>

        <div className="space-y-5 px-6 py-5">
          {status.isPending && <p className="text-sm text-muted-foreground">Загружаем статус…</p>}

          {data && (
            <>
              {/* Чек-лист готовности — самодиагностика вместо молчащей подписки. */}
              <ul className="space-y-2">
                {checklist.map((item) => (
                  <li key={item.label} className="flex items-start gap-2.5 text-sm">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'mt-1 size-2 shrink-0 rounded-full',
                        item.ok ? 'bg-success' : 'bg-muted-foreground/40',
                      )}
                    />
                    <span className={item.ok ? 'text-foreground' : 'text-muted-foreground'}>{item.label}</span>
                  </li>
                ))}
              </ul>

              {!data.bot_configured && (
                <div className="space-y-1 rounded border border-border bg-muted/30 px-4 py-3">
                  <p className="text-sm font-medium text-foreground">Бот ещё не настроен на сервере</p>
                  <p className="text-xs leading-5 text-muted-foreground">
                    Нужен токен бота: создайте бота в @BotFather и задайте переменную окружения
                    <span className="font-medium text-foreground"> TG_BOT_TOKEN</span> на сервере.
                    После деплоя здесь появится кнопка привязки.
                  </p>
                </div>
              )}

              {!bound && data.bot_configured && (
                <div className="space-y-2 border-t border-border pt-4">
                  <button
                    type="button"
                    onClick={() => void connectBot()}
                    disabled={link.isPending}
                    className="btn-pill bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {link.isPending ? 'Готовим ссылку…' : 'Привязать бота'}
                  </button>
                  <p className="text-xs leading-5 text-muted-foreground">
                    Откроется чат с ботом — нажмите в нём <b>Start</b>. Ссылка действует 15 минут.
                    {linkOpened && ' Ждём подтверждение из Telegram…'}
                  </p>
                </div>
              )}

              <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
                <div>
                  <p className="text-sm font-medium text-foreground">Присылать новые упоминания</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {enabled
                      ? data.subscription.last_notified_at
                        ? 'Включено. Первое сообщение уже отправлено.'
                        : 'Включено. Первая сводка придёт при ближайшем ежедневном прогоне.'
                      : 'Выключено.'}
                    {data.subscription.last_error ? ' Последний прогон завершился ошибкой.' : ''}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  aria-label="Присылать новые упоминания"
                  disabled={toggle.isPending || (!enabled && !ready)}
                  onClick={() => toggle.mutate({ enabled: !enabled })}
                  className={cn(
                    'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:pointer-events-none disabled:opacity-50',
                    enabled ? 'bg-primary' : 'bg-muted-foreground/30',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'absolute top-0.5 size-5 rounded-full bg-background transition-[left]',
                      enabled ? 'left-[22px]' : 'left-0.5',
                    )}
                  />
                </button>
              </div>

              {/* Расписание: рендер из статуса, каждый клик сохраняется сразу. Времена — МСК. */}
              {enabled && (
                <div className="space-y-3 border-t border-border pt-4">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-xs font-medium text-muted-foreground">Дни отправки</span>
                    <div role="group" aria-label="Дни отправки" className="flex gap-1">
                      {DAY_LABELS.map(([day, label]) => {
                        const active = sendDays.includes(day);
                        return (
                          <button
                            key={day}
                            type="button"
                            aria-pressed={active}
                            disabled={toggle.isPending}
                            onClick={() => toggleDay(day)}
                            className={cn(
                              'rounded-full border px-2 py-1 text-xs transition-colors disabled:pointer-events-none disabled:opacity-50',
                              active
                                ? 'border-primary/40 bg-primary/10 font-medium text-primary'
                                : 'border-border text-muted-foreground hover:bg-muted/50',
                            )}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <label htmlFor={`${titleId}-hour`} className="text-xs font-medium text-muted-foreground">
                      Время отправки (МСК)
                    </label>
                    <select
                      id={`${titleId}-hour`}
                      value={sendHour}
                      disabled={toggle.isPending}
                      onChange={(event) => saveSchedule({ send_hour: Number(event.target.value) })}
                      className="rounded border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-hidden focus:border-primary disabled:opacity-50"
                    >
                      {Array.from({ length: 24 }, (_, hour) => (
                        <option key={hour} value={hour}>{String(hour).padStart(2, '0')}:00</option>
                      ))}
                    </select>
                  </div>
                  <p className="text-2xs leading-4 text-muted-foreground">
                    Бот проверит упоминания в выбранный час (или позже, если сервер был занят) — не
                    чаще одного раза в день. Поиск тратит вашу квоту searchPosts.
                  </p>
                </div>
              )}

              {/* Тест-прогон: не ждать планового часа. Явно тратит квоту — по кнопке. */}
              {enabled && ready && (
                <div className="space-y-2 border-t border-border pt-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-foreground">Тестовый прогон</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Ищет и присылает прямо сейчас, не дожидаясь расписания.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => testRun.mutate()}
                      disabled={testRun.isPending}
                      className="btn-pill border border-border bg-background px-3.5 py-1.5 text-xs font-medium text-foreground hover:bg-hover-row disabled:opacity-50"
                    >
                      {testRun.isPending ? 'Прогоняем…' : 'Прислать сейчас'}
                    </button>
                  </div>
                  {testResult && <p role="status" className="text-xs text-success">{testResult}</p>}
                </div>
              )}

              {bound && (
                <div className="flex items-center justify-between gap-4 border-t border-border pt-4 text-xs text-muted-foreground">
                  <span>
                    Чат привязан{data.binding.username ? ` (@${data.binding.username})` : ''}.
                  </span>
                  <button
                    type="button"
                    onClick={() => unbind.mutate()}
                    disabled={unbind.isPending}
                    className="btn-pill px-3 py-1.5 font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                  >
                    Отвязать
                  </button>
                </div>
              )}
            </>
          )}

          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
