import type { Campaign, CampaignPost, CampaignSummary } from '@/api/schemas';
import type { CampaignSourceOption, CampaignSourceScope } from '@/lib/campaignSources';

/** Минимальный срез запроса публикаций, нужный таблице (загрузка/ошибка/ретрай). */
export interface CampaignPostsQuery {
  isPending: boolean;
  isError: boolean;
  isRefetching: boolean;
  refetch: () => void;
}

/**
 * Общий контракт представлений страницы кампании. Оркестратор (CampaignPage) владеет
 * маршрутом, запросами, гейтами и мутациями; desktop/mobile — только презентация. Один и тот
 * же bundle → обе ветки честно рисуют одни данные, а тест-контракт (data-testid) держится в
 * презентации, которая реально смонтирована (JS-ветвление, не CSS).
 */
export interface CampaignViewProps {
  campaign: Campaign;
  summary: CampaignSummary;
  /** Сводка по всем источникам — база для «N из M» и списка источников фильтра. */
  baseSummary: CampaignSummary | undefined;
  posts: CampaignPost[];
  postsQ: CampaignPostsQuery;
  canEdit: boolean;
  isArchived: boolean;
  sourceOptions: CampaignSourceOption[];
  selectedSource: CampaignSourceScope | null;
  onSelectSource: (value: string) => void;
  onEdit: () => void;
  onToggleArchive: () => void;
  onDelete: () => void;
  onRemovePost: (post: CampaignPost) => void;
  onRemovePosts: (posts: CampaignPost[]) => void;
  archivePending: boolean;
  deletePending: boolean;
  removePending: boolean;
}
