/**
 * Штриховка ПРОПУСКА — общая для линии и столбцов, чтобы «нет данных» выглядело одинаково везде.
 *
 * Нейтральный muted, а не цвет серии: это отсутствие измерения, а не значение.
 * `patternUnits="userSpaceOnUse"` обязателен — viewBox графиков тянется неравномерно
 * (`preserveAspectRatio="none"`), и при objectBoundingBox штрих поехал бы вместе с ним;
 * `vector-effect` держит толщину штриха постоянной в экранных пикселях по тому же канону,
 * что и все обводки проекта.
 */
export function ChartGapPattern({ id }: { id: string }) {
  return (
    <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line
        x1="0"
        y1="0"
        x2="0"
        y2="6"
        stroke="hsl(var(--muted-foreground))"
        strokeWidth="1"
        opacity="0.25"
        vectorEffect="non-scaling-stroke"
      />
    </pattern>
  );
}
