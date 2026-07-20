import { useEffect, useState } from 'react';
import { PERIOD_WORD, SIZE_COL_SPAN, SIZE_DEFER_RENDER, SIZE_HEIGHT } from './constants';
import { useChartSectionModel } from './useChartSectionModel';
import { WidgetBody } from './WidgetBody';
import { WidgetHeader } from './WidgetHeader';
import { WidgetEditOverlay, WidgetExpandOverlay } from './WidgetOverlays';
import { WidgetPeriodPills } from './WidgetPeriodPills';
import type { ChartSectionProps } from './types';
import { SourceIdentity } from '@/components/SourceIdentity';
import { useHomeSource } from '@/lib/homeSourceContext';
import { WidgetInViewContext } from '@/lib/widgetViewport';

/** Configurable dashboard card. Public consumers import this through components/ChartWidget. */
export function ChartSection(props: ChartSectionProps) {
  const model = useChartSectionModel(props);
  const homeSource = useHomeSource();
  // Прогрессивная загрузка Главной: только homeKey-карточки (доска) гейтят data-запросы тела до
  // приближения к вьюпорту — content-visibility (#290) уже скипает их layout/paint, но данные всей
  // доски фетчались разом. Одноразово: увидели → true навсегда. Без IntersectionObserver
  // (jsdom/SSR — гвард как в observeSize) не гейтим вовсе.
  const dataGated = !!props.homeKey;
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
    // Скролл-фолбэк как в LazyBlock (useFeed): headless/frame-starved окружения, где IO молчит.
    let lastRun = 0;
    const onScroll = () => {
      const now = Date.now();
      if (now - lastRun < 200) return;
      lastRun = now;
      if (nearViewport()) setInView(true);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      io.disconnect();
      window.removeEventListener('scroll', onScroll);
    };
  }, [inView, sectionRef]);
  const { widgetId, label } = model.identity;
  const { group, sequenceIndex, reorder, dragging, effectiveSize } = model.layout;
  const { prefs, updatePrefs, pinned } = model.preferences;
  const allowExpand = !props.noExpand;

  return (
    <section
      ref={model.refs.sectionRef}
      className={`min-w-0 ${reorder ? 'cursor-grab touch-none select-none active:cursor-grabbing' : ''} ${
        SIZE_COL_SPAN[effectiveSize]
      } ${model.controls.menuOpen ? 'z-10' : ''} ${props.className ?? ''}`}
      style={model.layout.outerStyle}
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
      <div
        className={`${
          props.strip
            ? 'group/strip relative flex flex-col'
            : `flex flex-col ${SIZE_HEIGHT[effectiveSize]} ${
                reorder || model.controls.menuOpen ? '' : SIZE_DEFER_RENDER[effectiveSize]
              } rounded-2xl border bg-card p-4 shadow-[0_12px_32px_-30px_rgba(0,0,0,0.9)] sm:p-5 transition-colors hover:border-ink3/40 hover:[--card-tint-alpha:0.16] dark:hover:border-white/[0.12] dark:hover:[--card-tint-alpha:0]`
        } ${
          model.controls.homeEditing && props.homeKey
            ? 'border-ink3/25'
            : 'border-border dark:border-white/[0.06]'
        } ${reorder ? 'widget-jiggle' : 'widget-enter cursor-pointer'} ${dragging ? 'shadow-lg' : ''}`}
        style={model.layout.innerStyle}
        data-widget-accented={model.layout.activeColor ? '' : undefined}
        data-drill-to={props.drillTo || undefined}
        data-widget-tinted={model.layout.activeTinted && model.layout.activeColor ? '' : undefined}
        onPointerDown={
          reorder || props.noExpand
            ? undefined
            : (event) => (model.refs.cardPressRef.current = { x: event.clientX, y: event.clientY })
        }
        onClick={
          reorder || props.noExpand
            ? undefined
            : (event) => {
                if ((event.target as HTMLElement).closest('button, a, input, select, label, [role="dialog"]')) return;
                const press = model.refs.cardPressRef.current;
                model.refs.cardPressRef.current = null;
                if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) return;
                model.expansion.openExpand();
              }
        }
      >
        <WidgetHeader
          label={label}
          action={
            props.homeKey && homeSource ? (
              <>
                <SourceIdentity network={homeSource.network} channelId={homeSource.channelId} />
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
          menu={{
            open: model.controls.menuOpen,
            onOpenChange: model.controls.setMenuOpen,
            label,
            widgetId,
            group,
            sequenceIndex,
            pinned,
            prefs,
            onPrefsChange: updatePrefs,
            onExpand: model.expansion.openExpand,
            onEdit: model.controls.openEdit,
            allowExpand,
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
          primary={model.variants.primaryBody}
          footer={model.variants.activeVariant ? props.children : undefined}
          resetKeys={model.bodyResetKeys}
        />
      </div>
      </WidgetInViewContext.Provider>

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
        minSize={model.variants.activeVariant?.minSize ?? 'third'}
        onChange={updatePrefs}
        onClose={() => model.controls.setEditOpen(false)}
      />
      <WidgetExpandOverlay
        open={model.expansion.open}
        noExpand={!!props.noExpand}
        customExplorer={props.explorer}
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
