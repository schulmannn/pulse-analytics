import { useSearchParams } from 'react-router-dom';
import type { IgData } from '@/lib/useIgData';
import { CampaignsView } from '@/components/campaigns/CampaignsView';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { cn } from '@/lib/utils';
import { IgContentDesktop } from '@/panels/instagram/IgContentDesktop';
import { IgContentMobile } from '@/panels/instagram/IgContentMobile';

/** IG Контент — публикации + вкладка «Кампании» (?view=campaigns) и канонический фильтр кампании
    (?campaign=). На desktop (md+) публикации — плотная таблица с bulk-выбором, детальной модалкой и
    вторичными разборами за компактным табом (?more=); на мобильном сохранён прежний стек блоков. */
export function IgContent({ ig }: { ig: IgData }) {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'campaigns' ? 'campaigns' : 'posts';
  // JS-ветвление desktop/mobile (не CSS): блоки вторичных разборов несут WidgetGroup c фикс. id —
  // если бы обе ветки монтировались одновременно (как в TG-таблице), id дублировались бы. Один
  // рендер за раз. Инициализатор useMediaQuery читает matchMedia синхронно → первый кадр корректен.
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const setView = (next: 'posts' | 'campaigns') =>
    setParams(
      (prev) => {
        const merged = new URLSearchParams(prev);
        if (next === 'posts') merged.delete('view');
        else merged.set('view', next);
        return merged;
      },
      { replace: true },
    );

  const tabs = (
    <div className="flex flex-wrap gap-1" role="tablist" aria-label="Раздел контента">
      {([['posts', 'Публикации'], ['campaigns', 'Кампании']] as const).map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={view === key}
          onClick={() => setView(key)}
          className={cn(
            'btn-pill px-3 py-1 text-xs font-medium transition-colors',
            view === key ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (view === 'campaigns') {
    return (
      <div className="space-y-6">
        {tabs}
        <CampaignsView />
      </div>
    );
  }

  return isDesktop ? <IgContentDesktop ig={ig} tabs={tabs} /> : <IgContentMobile ig={ig} tabs={tabs} />;
}
