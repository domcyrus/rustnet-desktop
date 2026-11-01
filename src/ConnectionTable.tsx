import { Fragment, useId, useRef, type CSSProperties } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Inspector } from "./Inspector";
import {
  bytes,
  connectionLifecycle,
  destination,
  endpoint,
  processName,
  type Connection,
  type Sort,
} from "./model";

/** Reveal a summary row without scrolling the surrounding workspace. */
export function revealConnectionRow(row: HTMLTableRowElement | undefined) {
  const scroll = row?.closest<HTMLElement>(".table-scroll");
  if (!row || !scroll || !scroll.clientHeight) return;
  const bounds = scroll.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  const heading =
    scroll.querySelector("thead")?.getBoundingClientRect().height ?? 42;
  if (rect.top < bounds.top + heading)
    scroll.scrollTop += rect.top - bounds.top - heading;
  else if (rect.bottom > bounds.bottom)
    scroll.scrollTop += rect.bottom - bounds.bottom;
}

export function ConnectionTable({
  filtered,
  sort,
  setSort,
  selectedConnection,
  onSelect,
}: {
  filtered: Connection[];
  sort: Sort;
  setSort: (sort: Sort) => void;
  selectedConnection: string | null;
  onSelect: (connection: string | null) => void;
}) {
  const lastClickedConnection = useRef<string | null>(null);
  const inspectorId = useId();
  return (
    <table className="connection-table" aria-label="Captured connections">
      <colgroup>
        <col className="process-column" />
        <col />
        <col className="traffic-column" />
        <col className="traffic-column" />
      </colgroup>
      <thead>
        <tr>
          <th aria-sort={sort === "process" ? "ascending" : "none"}>
            <button
              className="sort-heading"
              aria-label="Sort by process"
              onClick={() => setSort("process")}
            >
              Application {sort === "process" && "↑"}
            </button>
          </th>
          <th aria-sort={sort === "destination" ? "ascending" : "none"}>
            <button
              className="sort-heading"
              aria-label="Sort by destination"
              onClick={() => setSort("destination")}
            >
              Destination {sort === "destination" && "↑"}
            </button>
          </th>
          <th
            className="numeric"
            aria-sort={sort === "download" ? "descending" : "none"}
          >
            <button
              className="sort-heading"
              aria-label="Sort by download rate"
              onClick={() => setSort("download")}
            >
              Download {sort === "download" && "↓"}
            </button>
          </th>
          <th
            className="numeric"
            aria-sort={sort === "upload" ? "descending" : "none"}
          >
            <button
              className="sort-heading"
              aria-label="Sort by upload rate"
              onClick={() => setSort("upload")}
            >
              Upload {sort === "upload" && "↓"}
            </button>
          </th>
        </tr>
      </thead>
      <tbody>
        {filtered.map((c) => {
          const lifecycle = connectionLifecycle(c);
          const selected = selectedConnection === c.id;
          return (
            <Fragment key={c.id}>
              <tr
                data-connection-id={c.id}
                style={
                  { "--lifecycle-fade": lifecycle?.fade ?? 0 } as CSSProperties
                }
                onClick={(event) => {
                  if (event.detail < 2) {
                    lastClickedConnection.current = c.id;
                    onSelect(selected ? null : c.id);
                  }
                }}
                onDoubleClick={() =>
                  onSelect(lastClickedConnection.current || c.id)
                }
                className={`${selected ? "selected" : ""} ${c.historic ? "historic" : ""} ${lifecycle ? "stale-connection" : ""}`}
              >
                <td>
                  <button
                    className="row-select"
                    aria-pressed={selected}
                    aria-expanded={selected}
                    aria-controls={selected ? inspectorId : undefined}
                    aria-label={`Inspect ${processName(c)} connection to ${destination(c)}`}
                    title={processName(c)}
                  >
                    {selected ? (
                      <ChevronDown size={14} aria-hidden="true" />
                    ) : (
                      <ChevronRight size={14} aria-hidden="true" />
                    )}
                    <span>{processName(c)}</span>
                  </button>
                  <small>
                    {c.process?.pid == null
                      ? "PID unknown"
                      : `PID ${c.process.pid}`}
                  </small>
                </td>
                <td>
                  <span className="hostname" title={destination(c)}>
                    {c.hostname || endpoint(c.remote)}
                  </span>
                  <small className="connection-address">
                    {c.hostname && `${endpoint(c.remote)} · `}
                    {c.application || c.protocol} ·{" "}
                    {c.historic ? `Closed · Last state: ${c.state}` : c.state}
                  </small>
                  {lifecycle && (
                    <small className="lifecycle-countdown">
                      {lifecycle.label}
                    </small>
                  )}
                </td>
                <td className="numeric connection-download">
                  {c.historic
                    ? "Closed"
                    : bytes(c.traffic.incoming_bytes_per_second, true)}
                </td>
                <td className="numeric connection-upload">
                  {c.historic
                    ? "Retained"
                    : bytes(c.traffic.outgoing_bytes_per_second, true)}
                </td>
              </tr>
              {selected && (
                <tr className="connection-detail-row">
                  <td colSpan={4}>
                    <Inspector
                      id={inspectorId}
                      connection={c}
                      onClose={() => onSelect(null)}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
