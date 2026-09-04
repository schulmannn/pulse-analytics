import { SegmentedControl } from '@/components/SegmentedControl';

/** Bounded segmented control for metric-page rail selects (dimension / comparison baseline).
 * It lives outside either explorer implementation so Instagram/Yandex/mentions routes do not pull
 * the generic Telegram `MetricPage` chunk merely to reuse this thin wrapper. */
export function SegSelect<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: string }[];
  ariaLabel: string;
}) {
  return (
    <SegmentedControl
      ariaLabel={ariaLabel}
      className="mb-3 w-full"
      segmentClassName="px-2"
      value={value}
      onChange={onChange}
      options={options.map((option) => ({ value: option.value, content: option.label }))}
    />
  );
}
