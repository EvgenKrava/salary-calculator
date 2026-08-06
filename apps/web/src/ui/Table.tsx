import type { ReactNode } from 'react';
import './table.css';

/**
 * Tables are the primary surface here, not a fallback — the design system embraces being a
 * ledger rather than hiding rows inside cards. Semantic markup matters twice over: screen
 * readers, and managers copying figures into a spreadsheet.
 */
export function Table({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="table-wrap panel">
      <table className="table">
        <caption className="table__caption">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export function Th({ children, numeric = false }: { children: ReactNode; numeric?: boolean }) {
  return (
    <th scope="col" className={numeric ? 'th th--num' : 'th'}>
      {children}
    </th>
  );
}

export function Td({ children, label }: { children: ReactNode; label?: string }) {
  // `label` drives the mobile stacked layout: below 640px the header row is hidden and each
  // cell prints its own column name, so a figure is never separated from what it means.
  // Optional so existing call sites keep working — they just lose the mobile label.
  return (
    <td className="td" data-label={label}>
      {children}
    </td>
  );
}

/** Any numeric cell: mono, tabular, right-aligned so columns line up. */
export function NumCell({
  children,
  money = false,
  label,
}: {
  children?: ReactNode;
  money?: boolean;
  label?: string;
}) {
  return (
    <td className={money ? 'td td--num td--money mono' : 'td td--num mono'} data-label={label}>
      {children}
    </td>
  );
}
