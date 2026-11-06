CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    started_ms INTEGER NOT NULL,
    last_seen_ms INTEGER NOT NULL,
    ended_ms INTEGER,
    interface TEXT NOT NULL,
    dropped_snapshots INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    runtime_status TEXT NOT NULL DEFAULT 'starting',
    capture_error TEXT
);
CREATE TABLE applications (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    executable TEXT
);
CREATE TABLE destinations (
    app_key TEXT NOT NULL REFERENCES applications(key),
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    last_ip TEXT NOT NULL,
    first_seen_ms INTEGER NOT NULL,
    last_seen_ms INTEGER NOT NULL,
    connections INTEGER NOT NULL,
    PRIMARY KEY (app_key, key)
);
CREATE INDEX destinations_last_seen ON destinations(last_seen_ms);
CREATE TABLE traffic_buckets (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    minute_ms INTEGER NOT NULL,
    app_key TEXT NOT NULL REFERENCES applications(key),
    destination_key TEXT NOT NULL,
    protocol TEXT NOT NULL,
    port INTEGER NOT NULL,
    bytes_sent INTEGER NOT NULL CHECK (typeof(bytes_sent) = 'integer' AND bytes_sent >= 0),
    bytes_received INTEGER NOT NULL CHECK (typeof(bytes_received) = 'integer' AND bytes_received >= 0),
    connections INTEGER NOT NULL,
    PRIMARY KEY (session_id, minute_ms, app_key, destination_key, protocol, port)
);
CREATE INDEX traffic_time ON traffic_buckets(minute_ms);
CREATE TABLE observation_buckets (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    minute_ms INTEGER NOT NULL,
    observed_ms INTEGER NOT NULL,
    snapshots INTEGER NOT NULL,
    incomplete INTEGER NOT NULL,
    PRIMARY KEY (session_id, minute_ms)
);
CREATE INDEX observation_time ON observation_buckets(minute_ms);
PRAGMA user_version = 1;
