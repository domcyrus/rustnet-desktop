CREATE TABLE flow_records (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    engine_id TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    app_key TEXT NOT NULL,
    local_ip TEXT, local_port INTEGER,
    remote_ip TEXT NOT NULL, remote_port INTEGER NOT NULL,
    protocol TEXT NOT NULL, hostname TEXT, pid INTEGER,
    first_seen_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL,
    ended_ms INTEGER, end_reason TEXT,
    UNIQUE(session_id, engine_id, created_ms)
);
CREATE INDEX flow_app ON flow_records(app_key, session_id);
CREATE TABLE flow_samples (
    flow_id INTEGER NOT NULL REFERENCES flow_records(id) ON DELETE CASCADE,
    timestamp_ms INTEGER NOT NULL,
    segment INTEGER NOT NULL,
    bytes_sent INTEGER NOT NULL, bytes_received INTEGER NOT NULL,
    packets_sent INTEGER, packets_received INTEGER,
    kind TEXT NOT NULL,
    PRIMARY KEY(flow_id, timestamp_ms)
) WITHOUT ROWID;
CREATE INDEX flow_sample_time ON flow_samples(timestamp_ms, flow_id);
CREATE TABLE capture_intervals (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    bucket_ms INTEGER NOT NULL,
    observed_ms INTEGER NOT NULL,
    incomplete INTEGER NOT NULL,
    PRIMARY KEY(session_id, bucket_ms)
) WITHOUT ROWID;
CREATE INDEX capture_interval_time ON capture_intervals(bucket_ms);
PRAGMA user_version = 2;
