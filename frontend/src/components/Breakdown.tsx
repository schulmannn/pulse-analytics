interface BreakdownItem {
  label: string;
  value: number;
  display?: string;
  color?: string; // optional HSL color for the bar fill + a leading dot
}

interface BreakdownProps {
  items: BreakdownItem[];
}

export function Breakdown({ items }: BreakdownProps) {
  if (!items || items.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        Нет данных
      </div>
    );
  }

  const maxValue = Math.max(...items.map((item) => item.value), 1);

  return (
    <div className="space-y-2">
      {items.map((item, i) => {
        const percentage = (item.value / maxValue) * 100;
        // Fill alpha is a theme token (--row-tint-*): the light-theme 0.15 pastel turns muddy
        // olive-brown on the dark canvas, so dark ships lower alphas; the coloured dot next to
        // the label stays the category signal in both themes.
        const bgStyle = item.color
          ? { backgroundColor: item.color, opacity: 'var(--row-tint-colored, 0.15)' }
          : { backgroundColor: 'hsl(var(--brand-iris))', opacity: 'var(--row-tint-neutral, 0.08)' };

        return (
          <div
            key={i}
            className="relative flex items-center justify-between overflow-hidden rounded p-2"
          >
            <div
              className="absolute bottom-0 left-0 top-0 rounded-sm transition-all"
              style={{ width: `${percentage}%`, ...bgStyle }}
            />
            <span className="relative z-10 flex max-w-[65%] items-center gap-1.5 truncate text-sm font-medium text-foreground">
              {item.color && (
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: item.color }}
                  aria-hidden="true"
                />
              )}
              <span className="truncate">{item.label}</span>
            </span>
            <span className="relative z-10 ml-2 shrink-0 text-sm tabular-nums text-muted-foreground">
              {item.display ?? item.value}
            </span>
          </div>
        );
      })}
    </div>
  );
}
