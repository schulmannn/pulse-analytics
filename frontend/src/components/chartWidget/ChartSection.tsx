import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { PERIOD_WORD, SIZE_COL_SPAN, SIZE_DEFER_RENDER, SIZE_HEIGHT } from './constants';
import { useChartSectionModel } from './useChartSectionModel';
import { WidgetBody } from './WidgetBody';
import { WidgetHeader } from './WidgetHeader';
import { MenuIcon } from './WidgetMenu';
import { WidgetEditOverlay, WidgetExpandOverlay } from './WidgetOverlays';
import { WidgetPeriodPills } from './WidgetPeriodPills';
import { WidgetResizeHandle } from './WidgetResizeHandle';
import type { ChartSectionProps } from './types';
import { SourceIdentity } from '@/components/SourceIdentity';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useHomeSource } from '@/lib/homeSourceContext';
import { pinToHome, unpinFromHome } from '@/lib/widgetPrefsStore';
import { WidgetInViewContext } from '@/lib/widgetViewport';

/** Configurable dashboard card. Public consumers import this through components/ChartWidget. */
export function ChartSection(props: ChartSectionProps) {
  const model = useChartSectionModel(props);
  const homeSource = useHomeSource();
  // Прогрессивная загрузка: homeKey-карточки (доска Главной) и явно помеченные `deferData` доски
  // гейтят data-запросы тела до приближения к вьюпорту — content-visibility (#290) уже скипает их
  // layout/paint, но данные всей доски фетчались разом. Одноразово: увидели → true навсегда. Без
  // IntersectionObserver (jsdom/SSR — гвард как в observeSize) не гейтим вовсе.
  const dataGated = !!props.homeKey || !!props.deferData;
  const [inView, setInView] = useState(() => !dataGated || typeof IntersectionObserver === 'undefined');
  const sectionRef = model.refs.sectionRef;
  useEffect(() => {
    if (inView) return;
    const el = sectionRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    // Синхронная проверка: карточка в пределах запаса видимости фетчит прямо на mount-кадре, не
    // дожидаясь асинхронного первого колбэка IO. Запас зеркалит rootMargin ниже.
    const nearViewport = () => el.getBoundingClientRect().top < window.innerHeight + 600;
    if (nearViewport()) {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setInView(true);
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    // Скролл-фолбэк как в LazyBlock (useFeed): headless/frame-starved окружения и фоновые вкладки,
    // где IO молчит. ОБЯЗАТЕЛЬНО capture: scroll НЕ всплывает, а десктоп прокручивает не окно, а
    // элемент [data-dashboard-scroll] (DashboardLayout) — без capture слушатель на window не
    // получил бы НИ ОДНОГО события и фолбэк был бы мёртвым ровно там, где он нужен. Тот же приём
    // уже используют ChartTooltip/LineChart для сброса подсказки.
    let lastRun = 0;
    const onScroll = () => {
      const now = Date.now();
      if (now - lastRun < 200) return;
      lastRun = now;
      if (nearViewport()) setInView(true);
    };
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => {
      io.disconnect();
      window.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [inView, sectionRef]);
  const { widgetId, label } = model.identity;
  const { group, reorder, dragging, effectiveSize } = model.layout;
  const { prefs, updatePrefs, pinned } = model.preferences;
  const allowExpand = !props.noExpand;
  const cardRef = useRef<HTMLDivElement>(null);
  const cardPressRef = model.refs.cardPressRef;
  const openExpand = model.expansion.openExpand;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Контекстное (правый клик) меню карточки — те же действия, что у кнопки «⋯» (WidgetMenu):
  // power-путь без прицеливания в иконку. В reorder-режиме и у strip-полос меню не живёт.
  const contextActions = !reorder && !props.strip;

  // The whole-card tap is a pointer convenience around the real, labelled expand button rendered
  // by WidgetHeader. Keep the passive card a <div> (it contains menus and other controls, so it
  // cannot validly become one giant button) and register the pointer gesture on its DOM node.
  useEffect(() => {
    const card = cardRef.current;
    if (!card || reorder || props.noExpand) return;
    const handlePointerDown = (event: PointerEvent) => {
      cardPressRef.current = { x: event.clientX, y: event.clientY };
    };
    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('button, a, input, select, label, [role="dialog"], [data-widget-action]')
      ) {
        return;
      }
      const press = cardPressRef.current;
      cardPressRef.current = null;
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) return;
      openExpand();
    };
    card.addEventListener('pointerdown', handlePointerDown);
    card.addEventListener('click', handleClick);
    return () => {
      card.removeEventListener('pointerdown', handlePointerDown);
      card.removeEventListener('click', handleClick);
    };
  }, [cardPressRef, openExpand, props.noExpand, reorder]);

  return (
    <section
      ref={model.refs.sectionRef}
      className={`relative min-w-0 ${reorder ? 'cursor-grab touch-none select-none active:cursor-grabbing' : ''} ${
        SIZE_COL_SPAN[effectiveSize]
      } ${model.controls.menuOpen ? 'z-10' : ''} ${props.className ?? ''}`}
      style={model.layout.outerStyle}
      data-widget-size={effectiveSize}
      data-widget-user-sized={model.layout.userSized ? '' : undefined}
      onPointerDown={
        reorder
          ? (event) => {
              if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
              event.preventDefault();
              try {
                event.currentTarget.setPointerCapture(event.pointerId);
              } catch {
                // The pointer can disappear before capture on touch cancellation.
              }
              group?.dragStart(widgetId, event);
            }
          : undefined
      }
      onPointerMove={reorder ? (event) => group?.dragMove(event) : undefined}
      onPointerUp={reorder ? () => group?.dragEnd() : undefined}
      onPointerCancel={reorder ? () => group?.dragEnd() : undefined}
    >
      {/* content-visibility живёт на КАРТОЧКЕ, а не на внешнем section: paint containment клипает
          содержимое по padding-box, а резидентная тень карточки — декорация самого элемента и
          клипу не подлежит (на section она стала бы «контентом» и обрезалась). Гейты: в
          reorder-режиме FLIP/drag WidgetGroup меряет и глайдит карточки — консервативно рендерим
          всё; открытое меню (absolute top-full) может вылезать за низ карточки — без гейта его
          обрезал бы тот же paint containment. Оба переключения затрагивают одну-две карточки. */}
      {/* Provider оборачивает ТОЛЬКО тело карточки: оверлеи ниже — сиблинги, expand-тело обязано
          фетчить всегда (deep-link ?detail= может открыть невиденную карточку) и берёт дефолт
          контекста (true). */}
      <WidgetInViewContext.Provider value={inView}>
      <ContextMenu>
      <ContextMenuTrigger asChild disabled={!contextActions}>
      <div
        ref={cardRef}
        className={`${
          props.strip
            ? 'group/strip relative flex flex-col'
            : `flex flex-col ${SIZE_HEIGHT[effectiveSize]} ${
                reorder || model.controls.menuOpen ? '' : SIZE_DEFER_RENDER[effectiveSize]
              } rounded-2xl border bg-card p-4 shadow-[0_12px_32px_-30px_rgba(0,0,0,0.9)] sm:p-5 transition-colors hover:border-ink3/40 hover:[--card-tint-alpha:0.16] dark:hover:border-white/12 dark:hover:[--card-tint-alpha:0]`
        } ${
          model.controls.homeEditing && props.homeKey
            ? 'border-ink3/25'
            : 'border-border dark:border-white/6'
        } ${reorder ? 'widget-jiggle' : 'widget-enter cursor-pointer'} ${dragging ? 'shadow-lg' : ''}`}
        style={model.layout.innerStyle}
        data-widget-accented={model.layout.activeColor ? '' : undefined}
        data-widget-card
        data-drill-to={props.drillTo || undefined}
        data-widget-tinted={model.layout.activeTinted && model.layout.activeColor ? '' : undefined}
      >
        <WidgetHeader
          label={label}
          action={
            props.homeKey && homeSource ? (
              <>
                <SourceIdentity
                  network={homeSource.network}
                  channelId={homeSource.channelId}
                  compact={effectiveSize === 'third'}
                />
                {props.action}
              </>
            ) : props.action
          }
          strip={!!props.strip}
          stripToolbar={!!props.stripToolbar}
          reorder={reorder}
          allowExpand={allowExpand}
          homeKey={props.homeKey}
          removePresence={model.controls.removePresence}
          onRemove={model.controls.removeFromHome}
          onExpand={model.expansion.openExpand}
          onReorderMove={group ? (dir) => group.move(widgetId, dir) : undefined}
          menu={{
            open: model.controls.menuOpen,
            onOpenChange: model.controls.setMenuOpen,
            label,
            widgetId,
            group,
            pinned,
            prefs,
            onPrefsChange: updatePrefs,
            onEdit: model.controls.openEdit,
            allowEdit: !props.strip,
            reorder,
          }}
        />
        {props.periodControl && (
          <>
            {/* One date control per work page: inside a feed the top-bar page period is authoritative,
                so a page-controlled card never renders its own period selector. Home / standalone
                cards (no PagePeriodProvider) keep their independent saved period + pills. */}
            <WidgetPeriodPills
              days={model.period.widgetDays}
              onChange={(next) => updatePrefs({ ...prefs, period: next })}
              hidden={reorder || model.period.pageControlled}
            />
            {model.period.periodWidened && !reorder && (
              <p className="mt-1 text-2xs text-muted-foreground print:hidden">
                За {PERIOD_WORD[model.period.requestedDays]} данных нет — показано за{' '}
                {PERIOD_WORD[model.period.widgetDays]}.
              </p>
            )}
          </>
        )}
        <WidgetBody
          strip={!!props.strip}
          stripToolbar={!!props.stripToolbar}
          reorder={reorder}
          bodyRef={model.refs.bodyRef}
          widgetId={widgetId}
          label={label}
          period={model.period.widgetPeriod}
          target={model.layout.activeTarget}
          fillHeight={model.layout.fillHeight}
          fixedTile={!props.strip && effectiveSize !== 'full'}
          primary={model.variants.primaryBody}
          footer={model.variants.activeVariant ? props.children : undefined}
          resetKeys={model.bodyResetKeys}
        />
      </div>
      </ContextMenuTrigger>
      {contextActions && (
        <ContextMenuContent aria-label={`Действия виджета «${label}»`}>
          {allowExpand && (
            <ContextMenuItem onSelect={() => openExpand()}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
                <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />
              </svg>
              Развернуть
            </ContextMenuItem>
          )}
          {!props.strip && (
            <ContextMenuItem onSelect={() => model.controls.openEdit()}>
              <MenuIcon kind="edit" /> Изменить
            </ContextMenuItem>
          )}
          {(allowExpand || !props.strip) && (group || props.homeKey) && <ContextMenuSeparator />}
          {group && (
            <ContextMenuItem
              onSelect={() => {
                group.beginReorder();
                requestAnimationFrame(() =>
                  document.querySelector<HTMLElement>('[data-reorder-done]')?.focus(),
                );
              }}
            >
              <MenuIcon kind="drag" /> Переставить
            </ContextMenuItem>
          )}
          {props.homeKey && (
            <ContextMenuItem
              onSelect={() => {
                // Зеркало пункта WidgetMenu: результат пина живёт на другой странице — тост.
                const homeKey = props.homeKey as string;
                if (pinned) {
                  unpinFromHome(homeKey);
                  if (pathname !== '/home') toast(`«${label}» — убрано с главной`);
                } else {
                  pinToHome(homeKey);
                  if (pathname !== '/home') {
                    toast(`«${label}» — на главной`, {
                      action: { label: 'Открыть', onClick: () => navigate('/home') },
                    });
                  }
                }
              }}
            >
              <MenuIcon kind="home" /> {pinned ? 'Убрать с главной' : 'На главную'}
            </ContextMenuItem>
          )}
          {group && (
            <ContextMenuItem onSelect={() => updatePrefs({ ...prefs, hidden: true })}>
              <MenuIcon kind="hide" /> Скрыть
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      )}
      </ContextMenu>
      </WidgetInViewContext.Provider>
      {model.layout.resizeEnabled && !reorder && (
        <WidgetResizeHandle
          label={label}
          size={effectiveSize}
          minSize={model.layout.resizeMinSize}
          onResize={model.controls.resizeWidget}
        />
      )}

      <WidgetEditOverlay
        open={model.controls.editOpen}
        configDriven={!!props.configEditor}
        title={props.title}
        prefs={prefs}
        variants={model.variants.resolvedVariants}
        periodControl={!!props.periodControl && !model.period.pageControlled}
        seriesOptions={!!props.seriesOptions}
        showSource={widgetId.startsWith('home-')}
        showSize={!!group && !props.fixedSize}
        defaultSize={props.defaultSize ?? 'third'}
        defaultColor={props.defaultColor}
        defaultTinted={model.layout.tintedDefault}
        minSize={model.variants.activeVariant?.minSize ?? 'third'}
        onChange={updatePrefs}
        onClose={() => model.controls.setEditOpen(false)}
      />
      <WidgetExpandOverlay
        open={model.expansion.open}
        noExpand={!!props.noExpand}
        onClose={model.expansion.closeExpand}
        originRect={model.refs.originRectRef.current}
        widgetId={widgetId}
        label={label}
        accentStyle={model.expansion.accentStyle}
        periodControl={!!props.periodControl}
        days={model.period.widgetDays}
        expand={props.expand}
        richExpand={model.expansion.richExpand}
        resetKeys={model.bodyResetKeys}
        body={model.expansion.overlayBody}
      />
    </section>
  );
}
