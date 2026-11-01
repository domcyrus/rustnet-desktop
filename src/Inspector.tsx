import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useId,
  useState,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowLeftRight,
  Blocks,
  ChevronUp,
  Globe,
  Layers,
  Network,
} from "lucide-react";
import {
  bytes,
  connectionLifecycle,
  destination,
  endpoint,
  nameEvidence,
  processName,
  received,
  sent,
  type Connection,
  type Neighbor,
  type TcpWindow,
} from "./model";

const ShowUnobserved = createContext(false);
export function Inspector({
  connection: c,
  onClose,
  id,
}: {
  connection: Connection | undefined;
  onClose: () => void;
  id?: string;
}) {
  const [showUnobserved, setShowUnobserved] = useState(false);
  const generatedId = useId();
  const lifecycle = c ? connectionLifecycle(c) : null;
  return (
    <ShowUnobserved value={showUnobserved}>
      <aside
        className="inspector inline-inspector"
        id={id || generatedId}
        aria-label="Connection inspector"
      >
        <div className="inspector-heading">
          <div className="inspector-identity">
            <h2>{c ? destination(c) : "Connection details"}</h2>
            {c && (
              <p className="inspector-process">
                {processName(c)}
                {c.process?.pid != null && ` · PID ${c.process.pid}`} ·{" "}
                {c.historic ? "Closed" : c.state}
                {lifecycle && ` · ${lifecycle.label}`}
              </p>
            )}
          </div>
          <div className="inspector-actions">
            {c && (
              <button
                className="button inspector-navigation"
                aria-pressed={showUnobserved}
                onClick={() => setShowUnobserved(!showUnobserved)}
              >
                {showUnobserved
                  ? "Hide unobserved fields"
                  : "Show unobserved fields"}
              </button>
            )}
            <button
              className="button inspector-navigation"
              aria-label="Close inspector"
              onClick={onClose}
            >
              Collapse <ChevronUp size={15} />
            </button>
          </div>
        </div>
        {!c ? (
          <p className="inspector-note">
            The selected connection is no longer retained. Select another
            connection.
          </p>
        ) : (
          <div className="inspector-panels">
            <section aria-label="Connection and traffic">
              <h3 className="inspector-column-title">
                <ArrowLeftRight size={16} />
                Connection &amp; traffic
              </h3>
              <dl className="inspector-traffic" aria-label="Connection traffic">
                <Property label="Receiving">
                  <strong>
                    {c.historic ? "Closed" : bytes(received(c), true)}
                  </strong>
                  <small>2-second average</small>
                </Property>
                <Property label="Sending">
                  <strong>
                    {c.historic ? "Closed" : bytes(sent(c), true)}
                  </strong>
                  <small>2-second average</small>
                </Property>
                <Property label="Received">
                  <strong>{bytes(c.traffic.bytes_received)}</strong>
                  <small>Connection total</small>
                </Property>
                <Property label="Sent">
                  <strong>{bytes(c.traffic.bytes_sent)}</strong>
                  <small>Connection total</small>
                </Property>
              </dl>
              <div className="inspector-route">
                <dl>
                  <Property label="Local endpoint">
                    <code>{endpoint(c.local)}</code>
                  </Property>
                </dl>
                <ArrowLeftRight size={18} aria-hidden="true" />
                <dl>
                  <Property label="Remote endpoint">
                    <code>{endpoint(c.remote)}</code>
                  </Property>
                </dl>
              </div>
              <DetailCard title="Connection" icon={<Network size={16} />}>
                <dl className="inspector-fields">
                  <Property label="Packets received">
                    {c.traffic.packets_received?.toLocaleString() ??
                      "Unavailable"}
                  </Property>
                  <Property label="Packets sent">
                    {c.traffic.packets_sent?.toLocaleString() ?? "Unavailable"}
                  </Property>
                  <Property label="Service">
                    {c.service || "Not identified"}
                  </Property>
                  <Property label="Remote scope">
                    {c.remote_scope || "Unavailable"}
                    {c.remote_is_gateway && " · Gateway"}
                  </Property>
                  <Property label="Observed VLANs" wide>
                    {c.observed_vlan_ids?.join(", ") || "None observed"}
                  </Property>
                  <Property label="Round-trip time">
                    {c.rtt.current_ms == null
                      ? "Unavailable"
                      : `${c.rtt.current_ms.toFixed(1)} ms`}
                  </Property>
                  <Property label="Direction">
                    {c.direction || "Unknown"}
                  </Property>
                  <Property label="First observed">
                    {new Date(c.created_at).toLocaleString()}
                  </Property>
                  <Property label="Last activity">
                    {new Date(c.last_activity).toLocaleString()}
                  </Property>
                  {c.historic && c.closed_at && (
                    <Property label="Archived at">
                      {new Date(c.closed_at).toLocaleString()}
                    </Property>
                  )}
                </dl>
              </DetailCard>
              <NetworkDetails connection={c} />
            </section>
            <section aria-label="Process details">
              <DetailCard title="Process" icon={<Blocks size={16} />}>
                <dl className="inspector-fields">
                  <Property label="Process">{processName(c)}</Property>
                  <Property label="PID">{c.process?.pid ?? "Unknown"}</Property>
                  <Property label="Parent PID">
                    {c.process?.ppid ?? "Unavailable"}
                  </Property>
                  <Property label="User / group">
                    {c.process?.user_group || "Unavailable"}
                  </Property>
                  <Property label="UID / GID">
                    {c.process?.uid ?? "Unavailable"}
                    {c.process?.gid != null && ` : ${c.process.gid}`}
                  </Property>
                  <Property label="Process tree" wide>
                    {c.process?.lineage ? (
                      <ol className="process-lineage">
                        {c.process.lineage.truncated && (
                          <li className="muted">
                            Earlier ancestors unavailable
                          </li>
                        )}
                        {c.process.lineage.ancestors.map((ancestor, index) => (
                          <li key={`${ancestor.pid}-${index}`}>
                            <span>
                              {ancestor.name} <small>PID {ancestor.pid}</small>
                            </span>
                            {ancestor.executable && (
                              <code>{ancestor.executable}</code>
                            )}
                          </li>
                        ))}
                        <li>
                          <strong>{processName(c)}</strong>{" "}
                          <small>PID {c.process.pid ?? "Unknown"}</small>
                        </li>
                      </ol>
                    ) : (
                      "Unavailable"
                    )}
                  </Property>
                  <Property label="Executable" wide>
                    <code>{c.process?.executable || "Unavailable"}</code>
                    {!c.process?.executable && (
                      <small className="field-explanation">
                        The engine could not read the executable path. The
                        process may have exited, or OS permissions or sandbox
                        isolation may restrict access.
                      </small>
                    )}
                  </Property>
                  <Property label="Process match" wide>
                    {c.process?.attribution_match?.replaceAll(/[-_]/g, " ") ||
                      "Unknown"}
                    {c.process?.attribution_match === "startup-snapshot" && (
                      <small className="field-explanation">
                        Matched a socket present when capture started, with its
                        socket and process identity still validated. The
                        executable path may come from that initial scan.
                      </small>
                    )}
                  </Property>
                </dl>
              </DetailCard>
              {c.container && (
                <DetailCard title="Container" icon={<Blocks size={16} />}>
                  <dl className="inspector-fields">
                    <Property label="Runtime">{c.container.runtime}</Property>
                    <Property label="Name">
                      {c.container.name || "Unavailable"}
                    </Property>
                    <Property label="Container ID" wide>
                      <code>{c.container.id}</code>
                    </Property>
                    <Property label="Cgroup" wide>
                      <code>{c.container.cgroup_path || "Unavailable"}</code>
                    </Property>
                  </dl>
                </DetailCard>
              )}
              {c.kubernetes && (
                <DetailCard title="Kubernetes" icon={<Blocks size={16} />}>
                  <dl className="inspector-fields">
                    <Property label="Pod" wide>
                      {[c.kubernetes.pod_namespace, c.kubernetes.pod_name]
                        .filter(Boolean)
                        .join(" / ") || "Unavailable"}
                    </Property>
                    <Property label="Pod UID" wide>
                      <code>{c.kubernetes.pod_uid || "Unavailable"}</code>
                    </Property>
                    <Property label="Container" wide>
                      {c.kubernetes.container_name || "Unavailable"}
                    </Property>
                    <Property label="Container ID" wide>
                      <code>{c.kubernetes.container_id || "Unavailable"}</code>
                    </Property>
                    <Property label="Cgroup" wide>
                      <code>{c.kubernetes.cgroup_path || "Unavailable"}</code>
                    </Property>
                  </dl>
                </DetailCard>
              )}
            </section>
            <section aria-label="Protocol details">
              <DetailCard
                title="Protocol & transport"
                icon={<Layers size={16} />}
              >
                <dl className="inspector-fields">
                  <Property label="Transport">{c.protocol}</Property>
                  <Property label="Detected protocol">
                    {c.application || "Unknown"}
                  </Property>
                  <Property label="State">{c.state}</Property>
                  {c.protocol_details?.map((field, index) => (
                    <Property
                      key={`${field.label}-${index}`}
                      label={field.label}
                    >
                      <span
                        className={
                          field.warning ? "metadata-warning" : undefined
                        }
                      >
                        {field.value ?? "Not observed"}
                      </span>
                    </Property>
                  ))}
                  <Property label="Name evidence">{nameEvidence(c)}</Property>
                </dl>
              </DetailCard>
              <TransportDetails connection={c} />
              <p className="inspector-note">
                {c.hostname_source === "captured_dns"
                  ? "This hostname is inferred from a captured DNS response, not confirmed by this connection."
                  : "Names and protocol metadata come from observed traffic. Encrypted application content is not decrypted."}
              </p>
            </section>
          </div>
        )}
      </aside>
    </ShowUnobserved>
  );
}
function NetworkDetails({ connection: c }: { connection: Connection }) {
  const showUnobserved = useContext(ShowUnobserved);
  const observed =
    Object.values(c.network_context ?? {}).some(
      (value) => value != null && value !== "",
    ) ||
    Object.values(c.geoip ?? {}).some(
      (value) => value != null && value !== "",
    ) ||
    c.attributed_hostname ||
    c.hostname_source === "captured_dns";
  if (!observed && !showUnobserved) return null;
  const mac = (n?: Neighbor | null) =>
    n ? `${n.mac}${n.vendor ? ` (${n.vendor})` : ""}` : "Not observed";
  return (
    <DetailCard title="Network context" icon={<Globe size={16} />}>
      <dl className="inspector-fields">
        <Property label="Local hostname" wide>
          {c.network_context?.local_hostname || "Not resolved"}
        </Property>
        <Property label="Local MAC" wide>
          <code>{mac(c.network_context?.local_mac)}</code>
        </Property>
        <Property label="Remote hostname" wide>
          {c.network_context?.remote_hostname || "Not resolved"}
        </Property>
        <Property label="Remote MAC" wide>
          <code>{mac(c.network_context?.remote_mac)}</code>
        </Property>
        <Property label="Country">
          {c.geoip?.country_name || c.geoip?.country_code || "Unavailable"}
        </Property>
        <Property label="City">{c.geoip?.city || "Unavailable"}</Property>
        <Property label="ASN" wide>
          {c.geoip?.asn != null
            ? `AS${c.geoip.asn}${c.geoip.as_org ? ` (${c.geoip.as_org})` : ""}`
            : "Unavailable"}
        </Property>
        <Property label="Attributed name" wide>
          {c.attributed_hostname?.name ||
            (c.hostname_source === "captured_dns" ? c.hostname : null) ||
            "Not observed"}
          {c.attributed_hostname && (
            <small className="field-explanation">
              {c.attributed_hostname.source === "captured_dns"
                ? "Captured DNS"
                : c.attributed_hostname.source}{" "}
              · {new Date(c.attributed_hostname.observed_at).toLocaleString()}.
              Inferred from a DNS response, not confirmed by this connection.
            </small>
          )}
        </Property>
      </dl>
    </DetailCard>
  );
}
function TransportDetails({ connection: c }: { connection: Connection }) {
  const time = (value?: number | null) =>
    value == null ? "Not measured" : `${value.toFixed(1)} ms`;
  const windowSize = (value?: TcpWindow | null) =>
    value == null
      ? "Not observed"
      : `${bytes(value.bytes)}${value.scale_known ? "" : " (raw, scale unknown)"}`;
  const showUnobserved = useContext(ShowUnobserved);
  const health = c.tcp_health;
  if (
    !showUnobserved &&
    !Object.entries(c.rtt).some(
      ([key, value]) => key !== "current_ms" && value != null,
    ) &&
    !health &&
    !c.request_health &&
    !c.health_details?.length
  )
    return null;
  const requestProtocol =
    ["DNS", "LLMNR", "NetBIOS", "STUN", "NTP"].includes(c.application ?? "") &&
    c.protocol === "UDP";
  return (
    <DetailCard title="Transport health" icon={<Activity size={16} />}>
      <dl className="inspector-fields">
        {(c.protocol === "TCP" || c.application === "QUIC") && (
          <Property label="Initial RTT">{time(c.rtt.initial_ms)}</Property>
        )}
        {c.protocol === "TCP" && (
          <>
            <Property label="Live RTT">{time(c.rtt.tcp_smoothed_ms)}</Property>
            <Property label="TCP retransmits">
              {health?.retransmits ?? "Not measured"}
            </Property>
            <Property label="Out of order">
              {health?.out_of_order ?? "Not measured"}
            </Property>
            <Property label="Duplicate ACKs">
              {health?.duplicate_acks ?? "Not measured"}
            </Property>
            <Property label="Fast retransmits">
              {health?.fast_retransmits ?? "Not measured"}
            </Property>
            <Property label="Local receive window" wide>
              {windowSize(health?.local_receive_window)}
            </Property>
            <Property label="Remote receive window" wide>
              {windowSize(health?.remote_receive_window)}
            </Property>
          </>
        )}
        {(
          [
            ["DNS response time", c.rtt.dns_response_ms],
            ["LLMNR response time", c.rtt.llmnr_response_ms],
            ["NetBIOS response time", c.rtt.netbios_response_ms],
            ["Ping RTT", c.rtt.icmp_echo_ms],
            ["STUN RTT", c.rtt.stun_ms],
            ["NTP RTT", c.rtt.ntp_ms],
          ] as const
        )
          .filter(([, value]) => value != null)
          .map(([label, value]) => (
            <Property key={label} label={label}>
              {time(value)}
            </Property>
          ))}
        {requestProtocol && (
          <>
            <Property label="Request retries">
              {c.request_health?.retries ?? "Not measured"}
            </Property>
            <Property label="Request timeouts">
              {c.request_health?.timeouts ?? "Not measured"}
            </Property>
          </>
        )}
        {c.application === "QUIC" && (
          <>
            <Property label="QUIC retries">
              {c.request_health?.quic_retries ?? "Not measured"}
            </Property>
            <Property label="Version negotiations">
              {c.request_health?.quic_version_negotiations ?? "Not measured"}
            </Property>
          </>
        )}
        {c.health_details?.map((field, index) => (
          <Property key={`${field.label}-${index}`} label={field.label} wide>
            {field.value ?? "Not observed"}
          </Property>
        ))}
      </dl>
      {c.application === "QUIC" && (
        <p className="inspector-note">
          QUIC loss counters cannot be observed because ACK frames are
          encrypted.
        </p>
      )}
      {c.protocol !== "TCP" &&
        c.application !== "QUIC" &&
        !requestProtocol &&
        c.rtt.current_ms == null && (
          <p className="inspector-note">
            No transport timing observed for this connection.
          </p>
        )}
    </DetailCard>
  );
}
function fieldText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number")
        return String(child);
      if (isValidElement<{ children?: ReactNode; className?: string }>(child)) {
        if (child.props.className === "field-explanation") return "";
        return fieldText(child.props.children);
      }
      return "";
    })
    .join("")
    .trim();
}
function Property({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const showUnobserved = useContext(ShowUnobserved);
  const unobserved =
    /^(Unavailable|Unknown|Not observed|Not measured|Not resolved|Not identified|None observed|No hostname observed)$/i.test(
      fieldText(children),
    );
  if (unobserved && !showUnobserved) return null;
  return (
    <div className={`property ${wide ? "property-wide" : ""}`}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function DetailCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="inspector-card">
      <h3>
        {icon}
        {title}
      </h3>
      {children}
    </div>
  );
}
