import { Activity } from "lucide-react";

const PAGE_SIZE = 75;
export function paginate<T>(items: T[], requested: number) {
  const pages = Math.ceil(items.length / PAGE_SIZE);
  const page = Math.max(0, Math.min(requested, pages - 1));
  return {
    page,
    pages,
    items: items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
  };
}

export function Metric({
  icon,
  label,
  value,
  caption,
  placeholder = false,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  caption: string;
  placeholder?: boolean;
}) {
  return (
    <div className="metric">
      <div className="metric-label">
        {icon}
        {label}
      </div>
      <strong className={placeholder ? "metric-placeholder" : undefined}>
        {value}
      </strong>
      <small>{caption}</small>
    </div>
  );
}
export function Pagination({
  page,
  pages,
  onChange,
}: {
  page: number;
  pages: number;
  onChange: (page: number) => void;
}) {
  return pages > 1 ? (
    <div className="pagination">
      <button disabled={page === 0} onClick={() => onChange(page - 1)}>
        Previous
      </button>
      <span>
        {page + 1} / {pages}
      </span>
      <button disabled={page >= pages - 1} onClick={() => onChange(page + 1)}>
        Next
      </button>
    </div>
  ) : null;
}
export function Empty({
  active,
  filtered = false,
}: {
  active: boolean;
  filtered?: boolean;
}) {
  return (
    <div className="empty compact">
      <Activity size={26} />
      <h2>
        {filtered
          ? "No matching connections"
          : active
            ? "Listening for traffic"
            : "No captured connections"}
      </h2>
      <p>
        {filtered
          ? "Try another search or protocol."
          : active
            ? "Connections appear when packets are observed on the selected interface."
            : "Start a capture to populate this view."}
      </p>
    </div>
  );
}
