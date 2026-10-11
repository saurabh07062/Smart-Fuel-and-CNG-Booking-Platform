import type { ReactNode } from "react";

/**
 * The one table.
 *
 * There were fourteen hand-rolled tables in this project and no shared one.
 * Each had invented its own header casing, cell padding, empty state and
 * mobile behaviour, which is why two consoles showing the same kind of data
 * looked like two products. This is deliberately small: it owns the shell,
 * the header, the empty state and the horizontal scroll, and leaves every
 * cell's content to the caller.
 *
 * WHAT IT DOES NOT DO
 *
 * No sorting, filtering, pagination or selection. None of the fourteen needed
 * them, and a table component that guesses at those grows into something
 * nobody can read. If a screen needs sorting later it should be added here
 * once, with a reason.
 *
 * ON SMALL SCREENS
 *
 * It scrolls horizontally inside its own card rather than collapsing into
 * stacked rows. A booking table has an order id, a customer, a vehicle, an
 * amount and a status; stacked, that becomes a wall of labels. Scrolling
 * keeps the comparison a table exists for -- and `-webkit-overflow-scrolling`
 * makes it feel native in the app.
 */

export interface Column<Row> {
  /** Stable key, also used for the React key of each cell. */
  key: string;
  /** Column heading. Keep it short; it is set in small caps. */
  header: ReactNode;
  /** The cell. Given the row and its index. */
  cell: (row: Row, index: number) => ReactNode;
  /** Numbers right-align, which is the only way a column of money reads. */
  align?: "left" | "right" | "center";
  /** Optional fixed width, e.g. "120px" or "22%". */
  width?: string;
  /** Hidden below 640px. For columns a phone can live without. */
  hideOnPhone?: boolean;
}

interface Props<Row> {
  columns: Column<Row>[];
  rows: Row[];
  /** Stable identity per row — never the array index. */
  rowKey: (row: Row, index: number) => string;
  /** Shown instead of the table when there are no rows. */
  empty?: ReactNode;
  /** An accessible name, since a table of figures needs one. */
  label: string;
  /** Rendered above the table, inside the same card (a title, a filter). */
  toolbar?: ReactNode;
  /** Called when a row is activated; makes rows focusable and clickable. */
  onRowClick?: (row: Row) => void;
  /** Set on the outer element, for tests. */
  testId?: string;
  /**
   * Set on each `<tr>`, for tests that assert about one row rather than the
   * table. The hand-rolled tables each had one of these, and a shared table
   * that cannot express it would push every migration into weakening its own
   * tests to "find the text somewhere on the page" — which stops telling you
   * the values landed in the right row.
   */
  rowTestId?: (row: Row, index: number) => string;
}

export default function DataTable<Row>({
  columns,
  rows,
  rowKey,
  empty,
  label,
  toolbar,
  onRowClick,
  testId,
  rowTestId,
}: Props<Row>) {
  return (
    <div className="ds-table-card" data-testid={testId}>
      {toolbar && <div className="ds-table-toolbar">{toolbar}</div>}

      {rows.length === 0 ? (
        <div className="ds-table-empty">{empty ?? "Nothing to show yet."}</div>
      ) : (
        <div className="ds-table-scroll">
          <table className="ds-table" aria-label={label}>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    style={{ width: c.width, textAlign: c.align ?? "left" }}
                    className={c.hideOnPhone ? "ds-hide-phone" : undefined}
                  >
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={rowKey(row, i)}
                  data-testid={rowTestId?.(row, i)}
                  className={onRowClick ? "is-clickable" : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  /* A clickable row has to be reachable by keyboard too, or it
                     is a button that only a mouse can press. */
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      style={{ textAlign: c.align ?? "left" }}
                      className={c.hideOnPhone ? "ds-hide-phone" : undefined}
                    >
                      {c.cell(row, i)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
