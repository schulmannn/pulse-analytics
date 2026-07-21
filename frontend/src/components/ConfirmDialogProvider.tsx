import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Промис-подтверждение поверх канонного ui/alert-dialog — замена браузерного window.confirm на
 * разрушающих действиях (аудит blocks.so: 8 живых confirm'ов). Императивная форма сохраняет
 * call-sites: `if (await confirm({...})) act()`. Radix даёт focus-trap/Escape/возврат фокуса
 * (useRestoreOpenerFocus в ui/dialog-семействе), role=alertdialog — честная семантика.
 *
 * `typeToConfirm` — усиленный вариант для необратимого (удаление канала): кнопка мертва, пока
 * пользователь не введёт точное имя (паттерн GDPR-удаления аккаунта из AccountSection).
 */
export interface ConfirmOptions {
  /** Вопрос-заголовок («Удалить кампанию „Запуск“?»). */
  title: string;
  /** Последствие/что останется — второй строкой, спокойно и честно. */
  reason?: ReactNode;
  /** Подпись кнопки действия (по умолчанию «Удалить»). */
  actionLabel?: string;
  /** Разрушающий тон кнопки действия (по умолчанию true — основной кейс). */
  destructive?: boolean;
  /** Точная строка, которую пользователь обязан ввести, чтобы кнопка ожила. */
  typeToConfirm?: string;
  /** Подпись поля ввода при typeToConfirm (по умолчанию «Название»). */
  typeToConfirmLabel?: string;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm: ConfirmProvider отсутствует выше по дереву');
  return confirm;
}

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [typed, setTyped] = useState('');
  // resolve живёт и в ref: onOpenChange(false) от Radix (Escape/оверлей) обязан отвечать false
  // даже если state-замыкание устарело.
  const pendingRef = useRef<PendingConfirm | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      // Второй confirm поверх первого — прежний честно закрываем отказом (не бывает в UI, но
      // промис не должен зависнуть навсегда).
      pendingRef.current?.resolve(false);
      const next = { options, resolve };
      pendingRef.current = next;
      setPending(next);
      setTyped('');
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    pendingRef.current?.resolve(ok);
    pendingRef.current = null;
    setPending(null);
    setTyped('');
  }, []);

  const options = pending?.options;
  const needsTyping = !!options?.typeToConfirm;
  const typedOk = !needsTyping || typed.trim() === options?.typeToConfirm;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {options && (
        <AlertDialog open onOpenChange={(open) => !open && settle(false)}>
          <AlertDialogContent className="max-w-md">
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2.5">
                {(options.destructive ?? true) && (
                  <span
                    aria-hidden="true"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
                      <path d="M12 9v4" />
                      <path d="M12 17h.01" />
                    </svg>
                  </span>
                )}
                <span>{options.title}</span>
              </AlertDialogTitle>
              {options.reason && <AlertDialogDescription>{options.reason}</AlertDialogDescription>}
            </AlertDialogHeader>
            {needsTyping && (
              <div className="space-y-1.5">
                <Label htmlFor="confirm-typed">
                  {options.typeToConfirmLabel ?? 'Название'}{' '}
                  <span className="font-normal text-muted-foreground">
                    — введите <strong className="font-medium text-foreground">{options.typeToConfirm}</strong>
                  </span>
                </Label>
                <Input
                  id="confirm-typed"
                  autoComplete="off"
                  autoFocus
                  placeholder={options.typeToConfirm}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                />
              </div>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => settle(false)}>Отмена</AlertDialogCancel>
              <Button
                type="button"
                size="sm"
                variant={(options.destructive ?? true) ? 'destructive' : 'default'}
                disabled={!typedOk}
                onClick={() => settle(true)}
              >
                {options.actionLabel ?? 'Удалить'}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </ConfirmContext.Provider>
  );
}
