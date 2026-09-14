import { ReactNode } from "react";
import { PageHeader } from "./PageHeader";
import {
  EmptyState, ErrorState, Ledger, ListShell, Pagination, SearchInput,
  TableSkeleton,
} from "./ui";

/*
  THE LIST PAGE (2026-08-07).

  One shell, every list. This is the structural answer to "each page should have
  the same type of layouts".

  Before this, ~20 list pages each re-implemented the identical seven-state
  sequence by hand — header, filter row, error, loading, empty, filtered-empty,
  rows, pagination — and they had drifted, exactly as you would expect:

    * nine pages were `<Ledger>` with a `.ledger-bar`; the rest were a card
      wrapping a hand-rolled `<table>` with a hand-rolled filter row
    * the error branch was missing on several, so a dropped connection rendered
      "No channel partners yet" over a roster of forty
    * card padding came in ELEVEN different combinations
    * the filter row floated above the card on six pages, aligned with nothing,
      and vanished on the empty and loading states — exactly when you want to
      change the filter

  None of that can happen through this component, because there is nowhere to
  put it. A page supplies its data and its columns; the shell owns the shape.

  ORDER OF STATES IS LOAD-BEARING. Error comes FIRST, before loading and before
  empty: both of those are claims about data that was actually fetched, and this
  app is one Render instance where a cold start is routine. "No policies yet" on
  a failed request is a lie about the business.
*/

export interface ListPageProps<T> {
  /* --- header --- */
  title: string;
  /** Small label above the title — the section this page belongs to. */
  eyebrow?: string;
  /** The ONE number the page is about, set opposite the title. */
  figure?: { label: string; value: ReactNode; tone?: "in" | "out" | "due" };
  /** The primary action(s). Usually one button. */
  actions?: ReactNode;
  documentTitle?: string;

  /* --- filtering --- */
  search?: { value: string; onChange: (v: string) => void;
    placeholder?: string };
  /** `<FilterPill>`s. Rendered after the search box, in order. */
  filters?: ReactNode;
  /** Pushed to the right of the bar — an export button, a count. */
  barEnd?: ReactNode;
  /** True when anything is narrowing the list; picks the empty state. */
  filtered?: boolean;
  onClearFilters?: () => void;

  /* --- data --- */
  query: {
    isError: boolean;
    isLoading: boolean;
    refetch: () => void;
  };
  items: T[];
  /** Column headers: a fragment of `<LTh>`. */
  head: ReactNode;
  /** One `<LedgerRow>` per item. */
  row: (item: T) => ReactNode;
  /** One `<MobileCard>` per item — the phone rendering. */
  card: (item: T) => ReactNode;
  /** Only when the columns genuinely cannot compress further. */
  minWidth?: number;

  /* --- states --- */
  empty: { title: string; hint?: string; action?: ReactNode };
  /** Defaults to a "nothing matches these filters" message. */
  filteredEmpty?: { title: string; hint?: string };
  loadingCols?: number;

  pagination?: { page: number; pageSize: number; total: number;
    onChange: (p: number) => void };

  /** Anything between the filter bar and the list — tabs, a stat row. */
  children?: ReactNode;

  /**
   * Anything BELOW the list, shown on every state including empty.
   *
   * Added 2026-08-24 for the Policies page's "and these matched but are not
   * yours" panel, which has to appear precisely when the list came back EMPTY —
   * the whole question it answers is "is it not there, or is it not mine?".
   * Putting it in `children` would render it above the results, which reads as
   * a second list rather than as a footnote to the first.
   */
  footer?: ReactNode;
}

export function ListPage<T extends { id: string }>({
  title, eyebrow, figure, actions, documentTitle,
  search, filters, barEnd, filtered = false, onClearFilters,
  query, items, head, row, card, minWidth,
  empty, filteredEmpty, loadingCols = 5,
  pagination, children, footer,
}: ListPageProps<T>) {
  const hasBar = !!(search || filters || barEnd);

  return (
    <>
      <PageHeader title={title} eyebrow={eyebrow} figure={figure}
        actions={actions} documentTitle={documentTitle} />

      {hasBar && (
        <div className="ledger-bar">
          {search && (
            <SearchInput
              value={search.value}
              onChange={search.onChange}
              placeholder={search.placeholder ?? "Search…"}
              className="min-w-[200px] flex-1 sm:max-w-xs"
            />
          )}
          {filters}
          {barEnd && <div className="ledger-bar-end">{barEnd}</div>}
        </div>
      )}

      {children}

      {/* Error FIRST — see the note above. */}
      {query.isError ? (
        <ErrorState onRetry={query.refetch} />
      ) : query.isLoading ? (
        <TableSkeleton cols={loadingCols} />
      ) : items.length === 0 ? (
        <EmptyState
          title={filtered
            ? (filteredEmpty?.title ?? `No ${title.toLowerCase()} match these filters`)
            : empty.title}
          hint={filtered
            ? (filteredEmpty?.hint
              ?? "Try widening the date range or clearing a filter.")
            : empty.hint}
          action={filtered && onClearFilters ? (
            <button className="btn-secondary" onClick={onClearFilters}>
              Clear filters
            </button>
          ) : empty.action}
        />
      ) : (
        <>
          <ListShell
            bare
            cards={items.map(card)}
            table={
              <Ledger minWidth={minWidth} head={head}>
                {items.map(row)}
              </Ledger>
            }
          />
          {pagination && <Pagination {...pagination} />}
        </>
      )}

      {/* Below everything, on EVERY state — including the empty one, which is
          exactly when the Policies page needs it. Deliberately outside the
          error branch too: a footnote about what else matched is still true
          when the list itself failed to load. */}
      {footer}
    </>
  );
}
