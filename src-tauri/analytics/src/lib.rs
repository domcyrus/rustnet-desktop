//! SQLite history derived from capture metadata, independent of packet capture and Tauri.
mod detection;
pub mod icons;
mod incremental;
pub use incremental::SeriesCache;
mod query;
mod series;
mod series_detection;
mod timeline;
pub use query::{HistoryQuery, HistoryReport, read_history};
use std::{collections::HashSet, path::Path, time::Duration};
pub use timeline::{SeriesReport, read_series};

use chrono::{DateTime, FixedOffset};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

const MINUTE: i64 = 60_000;
const RETENTION: i64 = 30 * 24 * 60 * MINUTE;
const MAX_INTERVAL: i64 = 5_000;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Deserialize)]
struct Snapshot {
    schema_version: u64,
    #[serde(rename = "type")]
    kind: String,
    timestamp: DateTime<FixedOffset>,
    runtime: Runtime,
    stats: Stats,
    connections: Vec<Flow>,
}

#[derive(Deserialize)]
struct Runtime {
    status: String,
    capture_error: Option<String>,
    process_detection: Detection,
}

#[derive(Deserialize)]
struct Detection {
    degraded: bool,
}

#[derive(Deserialize)]
struct Stats {
    packets_dropped: u64,
    capture_packets_dropped: u64,
    interface_packets_dropped: u64,
}

impl Stats {
    fn dropped(&self) -> [u64; 3] {
        [
            self.packets_dropped,
            self.capture_packets_dropped,
            self.interface_packets_dropped,
        ]
    }
}

#[derive(Deserialize, Serialize)]
struct Flow {
    id: String,
    created_at: DateTime<FixedOffset>,
    last_activity: DateTime<FixedOffset>,
    process: Option<Process>,
    hostname: Option<String>,
    remote: Remote,
    local: Option<Remote>,
    #[serde(default)]
    historic: bool,
    closed_at: Option<DateTime<FixedOffset>>,
    protocol: String,
    traffic: Counters,
}

#[derive(Deserialize, Serialize)]
struct Process {
    pid: Option<i64>,
    name: Option<String>,
    executable: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct Remote {
    ip: String,
    port: u16,
}

#[derive(Deserialize, Serialize)]
struct Counters {
    bytes_sent: i64,
    bytes_received: i64,
    packets_sent: Option<i64>,
    packets_received: Option<i64>,
}

/// One writer per capture session. Dropping it closes its connection and temporary counters.
pub struct Store {
    db: Connection,
    session: i64,
    previous: Option<(i64, u64, [u64; 3])>,
    last_pruned: i64,
}

impl Store {
    /// Open a local database and begin a new session. Times are Unix milliseconds.
    pub fn open(path: &Path, interface: &str, now_ms: i64) -> Result<Self> {
        let mut db = Connection::open(path)?;
        db.busy_timeout(Duration::from_millis(250))?;
        db.pragma_update(None, "foreign_keys", true)?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
        match version {
            0 => {
                let tx = db.transaction()?;
                tx.execute_batch(include_str!("schema.sql"))?;
                tx.commit()?;
            }
            1..=3 => {}
            _ => return Err(format!("Unsupported traffic history schema: {version}").into()),
        }
        if version < 2 {
            let tx = db.transaction()?;
            tx.execute_batch(include_str!("series.sql"))?;
            tx.commit()?;
        }
        if version < 3 {
            let tx = db.transaction()?;
            tx.execute_batch(include_str!("incremental.sql"))?;
            tx.commit()?;
        }
        series::initialize(&db)?;
        // These tables are private to this writer and disappear when capture ends.
        db.execute_batch(
            "CREATE TEMP TABLE counters (
                id TEXT NOT NULL, created_ms INTEGER NOT NULL,
                sent INTEGER NOT NULL, received INTEGER NOT NULL,
                metadata TEXT NOT NULL, observed_ms INTEGER NOT NULL,
                PRIMARY KEY(id, created_ms)
             );
             CREATE TEMP TABLE destinations_seen (
                id TEXT NOT NULL, created_ms INTEGER NOT NULL,
                app_key TEXT NOT NULL, destination_key TEXT NOT NULL,
                PRIMARY KEY(id, created_ms, app_key, destination_key)
             );",
        )?;
        db.execute(
            "INSERT INTO sessions(started_ms, last_seen_ms, interface) VALUES (?1, ?1, ?2)",
            params![now_ms, interface],
        )?;
        let session = db.last_insert_rowid();
        let mut store = Self {
            db,
            session,
            previous: None,
            last_pruned: now_ms,
        };
        store.prune(now_ms)?;
        Ok(store)
    }

    /// Ingest a complete snapshot once. Sequence gaps and long intervals establish new baselines.
    /// Bytes are assigned to the minute in which their increment was observed.
    pub fn ingest(&mut self, json: &str, sequence: u64) -> Result<bool> {
        let snapshot: Snapshot = serde_json::from_str(json)?;
        let now = snapshot.timestamp.timestamp_millis();
        if snapshot.schema_version != 1 || snapshot.kind != "snapshot" || now < 0 {
            return Err("Unsupported traffic history snapshot".into());
        }
        if self
            .previous
            .is_some_and(|(time, seq, _)| now < time || sequence <= seq)
        {
            return Ok(false);
        }
        let mut identities = HashSet::new();
        for flow in &snapshot.connections {
            if !identities.insert(&flow.id)
                || flow.traffic.bytes_sent < 0
                || flow.traffic.bytes_received < 0
                || flow.traffic.packets_sent.is_some_and(|v| v < 0)
                || flow.traffic.packets_received.is_some_and(|v| v < 0)
                || flow.created_at > flow.last_activity
                || flow.last_activity > snapshot.timestamp
            {
                return Err("Invalid connection in traffic history snapshot".into());
            }
        }
        let previous_time = self.previous.map(|p| p.0);
        let continuous = self
            .previous
            .is_some_and(|(time, seq, _)| now - time <= MAX_INTERVAL && sequence == seq + 1);
        let dropped = snapshot.stats.dropped();
        let mut incomplete = !continuous
            || snapshot.runtime.capture_error.is_some()
            || snapshot.runtime.process_detection.degraded
            || self.previous.is_some_and(|(_, _, old)| old != dropped);
        let tx = self.db.transaction()?;
        for flow in &snapshot.connections {
            incomplete |= ingest_flow(&tx, self.session, flow, now, previous_time, continuous)?;
        }
        series::ingest(
            &tx,
            self.session,
            &snapshot,
            sequence,
            previous_time,
            continuous,
            incomplete,
        )?;
        let minute = now / MINUTE * MINUTE;
        observation(&tx, self.session, minute, 0, 1, incomplete)?;
        if continuous {
            let mut start = previous_time.unwrap();
            while start < now {
                let bucket = start / MINUTE * MINUTE;
                let end = now.min(bucket + MINUTE);
                observation(&tx, self.session, bucket, end - start, 0, incomplete)?;
                start = end;
            }
        }
        tx.execute(
            "UPDATE sessions SET last_seen_ms = ?1, runtime_status = ?3, capture_error = COALESCE(?4, capture_error) WHERE id = ?2",
            params![now, self.session, snapshot.runtime.status, snapshot.runtime.capture_error],
        )?;
        tx.commit()?;
        self.previous = Some((now, sequence, dropped));
        if now - self.last_pruned >= 60 * MINUTE {
            self.prune(now)?;
            self.last_pruned = now;
        }
        Ok(true)
    }

    /// Called after the final queued snapshot has been processed.
    pub fn finish(&mut self, dropped_snapshots: u64, error: Option<&str>) -> Result<()> {
        let dropped_snapshots = i64::try_from(dropped_snapshots)?;
        let tx = self.db.transaction()?;
        series::finish(&tx)?;
        tx.execute(
            "UPDATE sessions SET ended_ms = last_seen_ms, dropped_snapshots = ?2, error = ?3 WHERE id = ?1",
            params![self.session, dropped_snapshots, error],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn prune(&mut self, now: i64) -> Result<()> {
        let cutoff = now - RETENTION;
        let tx = self.db.transaction()?;
        tx.execute("DELETE FROM flow_samples WHERE timestamp_ms < ?1", [cutoff])?;
        tx.execute("DELETE FROM flow_pending WHERE flow_id IN (SELECT id FROM flow_records WHERE last_seen_ms < ?1)", [cutoff])?;
        tx.execute("DELETE FROM flow_records WHERE last_seen_ms < ?1", [cutoff])?;
        tx.execute(
            "DELETE FROM capture_intervals WHERE bucket_ms < ?1",
            [cutoff],
        )?;
        tx.execute("DELETE FROM traffic_buckets WHERE minute_ms < ?1", [cutoff])?;
        tx.execute("DELETE FROM counters WHERE observed_ms < ?1", [cutoff])?;
        tx.execute("DELETE FROM destinations_seen WHERE NOT EXISTS (SELECT 1 FROM counters WHERE counters.id = destinations_seen.id AND counters.created_ms = destinations_seen.created_ms)", [])?;
        tx.execute(
            "DELETE FROM observation_buckets WHERE minute_ms < ?1",
            [cutoff],
        )?;
        tx.execute(
            "DELETE FROM sessions WHERE last_seen_ms < ?1 AND id != ?2",
            params![cutoff, self.session],
        )?;
        tx.execute("DELETE FROM destinations WHERE last_seen_ms < ?1", [cutoff])?;
        tx.execute("DELETE FROM applications WHERE key NOT IN (SELECT app_key FROM destinations) AND key NOT IN (SELECT app_key FROM traffic_buckets) AND key NOT IN (SELECT app_key FROM flow_records)", [])?;
        tx.commit()?;
        Ok(())
    }
}

fn observation(
    tx: &Transaction<'_>,
    session: i64,
    minute: i64,
    duration: i64,
    samples: i64,
    incomplete: bool,
) -> Result<()> {
    tx.execute(
        "INSERT INTO observation_buckets VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(session_id, minute_ms) DO UPDATE SET
           observed_ms = observed_ms + excluded.observed_ms,
           snapshots = snapshots + excluded.snapshots,
           incomplete = MAX(incomplete, excluded.incomplete)",
        params![session, minute, duration, samples, incomplete],
    )?;
    Ok(())
}

fn ingest_flow(
    tx: &Transaction<'_>,
    session: i64,
    flow: &Flow,
    now: i64,
    previous: Option<i64>,
    continuous: bool,
) -> Result<bool> {
    let created = flow.created_at.timestamp_millis();
    let metadata = serde_json::to_string(flow)?;
    let old: Option<(i64, i64, String, i64)> = tx
        .prepare_cached("SELECT sent, received, metadata, observed_ms FROM counters WHERE id = ?1 AND created_ms = ?2")?
        .query_row(
            params![flow.id, created],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let sent = flow.traffic.bytes_sent;
    let received = flow.traffic.bytes_received;
    let reset = old
        .as_ref()
        .is_some_and(|(s, r, _, _)| sent < *s || received < *r);
    let missing = old
        .as_ref()
        .is_some_and(|(_, _, _, time)| Some(*time) != previous);
    let continuous = continuous && !missing;
    if old
        .as_ref()
        .is_some_and(|(_, _, data, _)| data == &metadata)
    {
        tx.prepare_cached(
            "UPDATE counters SET observed_ms = ?3 WHERE id = ?1 AND created_ms = ?2",
        )?
        .execute(params![flow.id, created, now])?;
        return Ok(missing);
    }
    let (delta_sent, delta_received) = if continuous && !reset {
        match &old {
            Some((s, r, _, _)) => (sent - s, received - r),
            None if previous.is_some_and(|time| created >= time) => (sent, received),
            None => (0, 0),
        }
    } else {
        (0, 0)
    };
    tx.prepare_cached(
        "INSERT INTO counters VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id, created_ms) DO UPDATE SET sent = excluded.sent, received = excluded.received, metadata = excluded.metadata, observed_ms = excluded.observed_ms"
    )?.execute(
        params![flow.id, created, sent, received, metadata, now]
    )?;
    let process = flow.process.as_ref();
    let executable = process
        .and_then(|p| p.executable.as_deref())
        .filter(|s| !s.is_empty());
    let name = process
        .and_then(|p| p.name.as_deref())
        .filter(|s| !s.is_empty())
        .unwrap_or("Unattributed");
    let app_key = serde_json::to_string(&match executable {
        Some(path) => ["executable", path],
        None if name != "Unattributed" => ["name", name],
        None => ["unattributed", ""],
    })?;
    tx.prepare_cached(
        "INSERT INTO applications VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET name = excluded.name, executable = excluded.executable",
    )?
    .execute(params![app_key, name, executable])?;
    let hostname = flow
        .hostname
        .as_deref()
        .map(|h| h.trim_end_matches('.').to_lowercase())
        .filter(|h| !h.is_empty());
    let (kind, destination) = match &hostname {
        Some(h) => ("hostname", h.clone()),
        None => (
            "ip",
            flow.remote.ip.parse::<std::net::IpAddr>()?.to_string(),
        ),
    };
    let destination_key = serde_json::to_string(&[kind, &destination])?;
    let new_destination = tx
        .prepare_cached("INSERT OR IGNORE INTO destinations_seen VALUES (?1, ?2, ?3, ?4)")?
        .execute(params![flow.id, created, app_key, destination_key])?;
    let activity = flow.last_activity.timestamp_millis();
    tx.prepare_cached(
        "INSERT INTO destinations VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)
         ON CONFLICT(app_key, key) DO UPDATE SET
           last_ip = CASE WHEN excluded.last_seen_ms >= last_seen_ms THEN excluded.last_ip ELSE last_ip END,
           first_seen_ms = MIN(first_seen_ms, excluded.first_seen_ms),
           last_seen_ms = MAX(last_seen_ms, excluded.last_seen_ms),
           connections = connections + excluded.connections"
    )?.execute(
        params![app_key, destination_key, kind, destination, flow.remote.ip, activity, new_destination as i64]
    )?;
    // A newly observed old connection is useful inventory, but is not a new connection burst.
    let new_flow = old.is_none() && continuous && previous.is_some_and(|time| created >= time);
    if delta_sent > 0 || delta_received > 0 || new_flow {
        tx.prepare_cached(
            "INSERT INTO traffic_buckets VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(session_id, minute_ms, app_key, destination_key, protocol, port) DO UPDATE SET
               bytes_sent = bytes_sent + excluded.bytes_sent,
               bytes_received = bytes_received + excluded.bytes_received,
               connections = connections + excluded.connections"
    )?.execute(
            params![session, now / MINUTE * MINUTE, app_key, destination_key, flow.protocol,
                flow.remote.port, delta_sent, delta_received, i64::from(new_flow)]
    )?;
    }
    Ok(reset || missing)
}
