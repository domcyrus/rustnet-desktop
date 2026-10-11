import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Blocks } from "lucide-react";
import { Chart } from "./Chart";
import { Metric, Pagination, paginate } from "./components";
import {
  bytes,
  destination,
  endpoint,
  nameEvidence,
  received,
  type Application,
  type TrafficPoint,
} from "./model";

export function ApplicationDetails({
  app,
  points,
  totalRx,
  selected,
  onSelect,
  onInspect,
}: {
  app: Application;
  points: TrafficPoint[];
  totalRx: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onInspect: (id: string, expand?: boolean) => void;
}) {
  const [page, setPage] = useState(0);
  const pagination = paginate(app.connections, page);
  return (
    <>
      <div className="app-title">
        <span className="app-icon large">
          <Blocks size={23} />
        </span>
        <div>
          <h2>{app.name}</h2>
          <p className="subtitle">
            {app.pids.length
              ? `PIDs ${app.pids.slice(0, 8).join(", ")}${app.pids.length > 8 ? "…" : ""}`
              : "Process owner unavailable"}
          </p>
        </div>
      </div>
      {app.executable && <p className="executable">{app.executable}</p>}
      <p className="app-counts">
        {app.connections.length} active connections · {app.pids.length} PIDs ·{" "}
        <span title="Unique remote IP addresses across active connections">
          {app.hosts} {app.hosts === 1 ? "host" : "hosts"}
        </span>
      </p>
      <div className="app-metrics">
        <Metric
          icon={<ArrowDownLeft />}
          label="Download"
          value={bytes(app.rx, true)}
          caption="2-second average"
        />
        <Metric
          icon={<ArrowUpRight />}
          label="Upload"
          value={bytes(app.tx, true)}
          caption="2-second average"
        />
        <Metric
          icon={<ArrowDownLeft />}
          label="Total downloaded"
          value={bytes(app.downloaded)}
          caption="Retained connections"
        />
        <Metric
          icon={<ArrowUpRight />}
          label="Total uploaded"
          value={bytes(app.uploaded)}
          caption="Retained connections"
        />
      </div>
      <Chart points={points} label="Traffic · last 60 seconds" />
      <div className="endpoints-title">
        <h3>Talking to</h3>
        <span>{app.connections.length} connections</span>
      </div>
      {pagination.items.map((c) => (
        <div
          className="endpoint"
          key={c.id}
          onDoubleClick={() => onInspect(c.id, true)}
        >
          <button
            className="endpoint-summary"
            aria-expanded={selected === c.id}
            onClick={() => onSelect(selected === c.id ? null : c.id)}
          >
            <span>
              <strong>{destination(c)}</strong>
              <small>
                {c.application || c.protocol} · {nameEvidence(c)}
              </small>
            </span>
            <span>{bytes(received(c), true)}</span>
          </button>
          {selected === c.id && (
            <div className="endpoint-expanded">
              <span>
                {endpoint(c.remote)} · {c.state} · PID{" "}
                {c.process?.pid ?? "unknown"}
              </span>
              <button className="button" onClick={() => onInspect(c.id)}>
                Inspect connection
              </button>
            </div>
          )}
        </div>
      ))}
      <div className="list-footer">
        <span>
          {totalRx
            ? `${((app.rx / totalRx) * 100).toFixed(1)}% of current download traffic`
            : "No current download traffic"}
        </span>
        <Pagination
          page={pagination.page}
          pages={pagination.pages}
          onChange={setPage}
        />
      </div>
    </>
  );
}
