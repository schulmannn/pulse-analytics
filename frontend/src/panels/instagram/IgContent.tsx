import { useSearchParams } from 'react-router-dom';
import type { IgData } from '@/lib/useIgData';
import { CampaignsView } from '@/components/campaigns/CampaignsView';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { cn } from '@/lib/utils';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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

  return (
    <Tabs
      value={view}
      onValueChange={(next) => setView(next as 'posts' | 'campaigns')}
      className="space-y-6"
    >
      <TabsList
        aria-label="Раздел контента"
        className="flex h-auto min-h-0 flex-wrap justify-start gap-1 border-0 bg-transparent p-0"
      >
      {([['posts', 'Публикации'], ['campaigns', 'Кампании']] as const).map(([key, label]) => (
        <TabsTrigger
          key={key}
          value={key}
          className={cn(
            'btn-pill px-3 py-1 text-xs font-medium transition-colors',
            'bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground data-[state=active]:bg-primary/15 data-[state=active]:text-foreground',
          )}
        >
          {label}
        </TabsTrigger>
      ))}
      </TabsList>
      <TabsContent value="campaigns" className="mt-0">
        <CampaignsView />
      </TabsContent>
      <TabsContent value="posts" className="mt-0">
        {isDesktop ? <IgContentDesktop ig={ig} /> : <IgContentMobile ig={ig} />}
      </TabsContent>
    </Tabs>
  );
}
