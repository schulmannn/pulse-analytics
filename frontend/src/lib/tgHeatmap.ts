export const TG_DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const;

export interface HeatmapCell {
  n: number;
  ervSum: number;
  reachSum: number;
}

export interface HeatmapBestSlot {
  weekday: number;
  hour: number;
  avgErv: number;
  n: number;
  reachSum: number;
}
