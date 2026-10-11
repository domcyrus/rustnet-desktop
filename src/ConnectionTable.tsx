import { useRef, type CSSProperties } from "react";
import {
  bytes,
  connectionLifecycle,
  destination,
  endpoint,
  processName,
  type Connection,
  type Sort,
} from "./model";

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
  onSelect: (connection: string, expanded: boolean) => void;
}) {
  const lastClickedConnection = useRef<string | null>(null);
  return (
    <table
      onDoubleClick={(event) => {
        const row = (event.target as Element).closest<HTMLTableRowElement>(
          "tr[data-connection-id]",
        );
        const connection =
          lastClickedConnection.current || row?.dataset.connectionId;
        if (connection) onSelect(connection, true);
      }}
    >
      <thead>
        <tr>
          <th aria-sort={sort === "process" ? "ascending" : "none"}>
            <button
              className="sort-heading"
              aria-label="Sort by process"
              onClick={() => setSort("process")}
            >
              Process {sort === "process" && "↑"}
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
          <th>Protocol</th>
          <th>State</th>
          <th
            className="numeric"
            aria-sort={sort === "download" ? "descending" : "none"}
          >
            <button
              className="sort-heading"
              aria-label="Sort by download rate"
              onClick={() => setSort("download")}
            >
              Download rate {sort === "download" && "↓"}
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
              Upload rate {sort === "upload" && "↓"}
            </button>
          </th>
        </tr>
      </thead>
      <tbody>
        {filtered.map((c) => {
          const lifecycle = connectionLifecycle(c);
          return (
            <tr
              key={c.id}
              data-connection-id={c.id}
              style={
                {
                  "--lifecycle-fade": lifecycle?.fade ?? 0,
                } as CSSProperties
              }
              onClick={(event) => {
                if (event.detail < 2) {
                  lastClickedConnection.current = c.id;
                  onSelect(c.id, false);
                } else onSelect(lastClickedConnection.current || c.id, true);
              }}
              className={`${selectedConnection === c.id ? "selected" : ""} ${c.historic ? "historic" : ""} ${lifecycle ? "stale-connection" : ""}`}
            >
              <td>
                <button
                  className="row-select"
                  aria-pressed={selectedConnection === c.id}
                  aria-label={`Inspect ${processName(c)} connection to ${destination(c)}`}
                >
                  {processName(c)}
                </button>
                <small>
                  {c.process?.pid == null
                    ? "PID unknown"
                    : `PID ${c.process.pid}`}
                </small>
              </td>
              <td>
                <span className="hostname" title={destination(c)}>
                  {destination(c)}
                </span>
                <small>{endpoint(c.remote)}</small>
              </td>
              <td>
                <span className="protocol-badge">
                  {c.application || c.protocol}
                </span>
                <small>{c.protocol}</small>
              </td>
              <td>
                <span className="state-label">
                  {c.historic ? "Closed" : c.state}
                </span>
                {c.historic && <small>Last state: {c.state}</small>}
                {lifecycle && (
                  <small className="lifecycle-countdown">
                    {lifecycle.label}
                  </small>
                )}
              </td>
              <td className="numeric">
                {c.historic
                  ? "Closed"
                  : bytes(c.traffic.incoming_bytes_per_second, true)}
              </td>
              <td className="numeric">
                {c.historic
                  ? "Closed"
                  : bytes(c.traffic.outgoing_bytes_per_second, true)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
