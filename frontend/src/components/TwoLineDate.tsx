import { fmt } from '@/lib/format';

/**
 * Дата публикации для узкой колонки таблицы: день и время СТРОГО двумя строками («20 июн.» /
 * «06:01»), выключка вправо. Одна строка «20 июн., 06:01» в 68–96 px ломается на три и раздувает
 * ряд, а запятая при этом остаётся висеть в конце первой строки.
 *
 * Общая для таблиц Telegram и Instagram: пока копия жила внутри `panels/Posts.tsx`, у Instagram
 * стояла сырая `fmt.date`, и одна и та же дата читалась в двух видах — «31 авг. 12:24» против
 * «8 авг., 15:26» (аудит #554, D10).
 */
export function TwoLineDate({ iso }: { iso: string }) {
  const { day, time } = fmt.dateParts(iso);
  return (
    <span className="inline-flex flex-col items-end">
      <span className="whitespace-nowrap">{day}</span>
      {time && <span className="whitespace-nowrap">{time}</span>}
    </span>
  );
}
