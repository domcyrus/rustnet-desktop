use crate::{
    MINUTE, RETENTION, Result,
    detection::{self, Analysis, Sample},
};
use rusqlite::{Connection, OpenFlags, params};
use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};

const PAGE_SIZE: i64 = 50;
const MAX_SAMPLES: usize = 100_000;

#[derive(Clone, Deserialize)]
pub struct HistoryQuery {
    pub from_ms: i64,
    pub to_ms: i64,
    pub app_key: Option<String>,
    pub interface: Option<String>,
    pub offset: i64,
}

#[derive(Default, Serialize)]
pub struct Totals {
    pub bytes_sent: i64,
    pub bytes_received: i64,
    pub connections: i64,
    pub observed_ms: i64,
    pub incomplete_minutes: i64,
}

#[derive(Serialize)]
pub struct SavedApplication {
    pub key: String,
    pub name: String,
    pub executable: Option<String>,
}

#[derive(Serialize)]
pub struct TrafficRow {
    pub app_key: String,
    pub name: String,
    pub executable: Option<String>,
    pub destination: String,
    pub protocol: String,
    pub port: u16,
    pub interface: String,
    pub first_ms: i64,
    pub last_ms: i64,
    pub bytes_sent: i64,
    pub bytes_received: i64,
    pub connections: i64,
}

#[derive(Serialize)]
pub struct Session {
    pub id: i64,
    pub started_ms: i64,
    pub last_seen_ms: i64,
    pub ended_ms: Option<i64>,
    pub interface: String,
    pub runtime_status: String,
    pub dropped_snapshots: i64,
    pub error: Option<String>,
    pub capture_error: Option<String>,
}

#[derive(Default, Serialize)]
pub struct HistoryReport {
    pub exists: bool,
    pub last_saved_ms: Option<i64>,
    pub applications: Vec<SavedApplication>,
    pub interfaces: Vec<String>,
    pub totals: Totals,
    pub rows: Vec<TrafficRow>,
    pub row_count: i64,
    pub sessions: Vec<Session>,
    pub analysis: Analysis,
}

/// Read-only, parameterized queries over one consistent SQLite snapshot.
/// The caller supplies wall time so an unfinished minute cannot become a finding.
pub(crate) fn validate(query: &HistoryQuery, now_ms: i64) -> Result<()> {
    if query.from_ms < 0
        || query.to_ms <= query.from_ms
        || query.to_ms - query.from_ms > RETENTION
        || query.to_ms > now_ms
        || !(0..=1_000_000).contains(&query.offset)
        || query.app_key.as_ref().is_some_and(|s| s.len() > 8192)
        || query.interface.as_ref().is_some_and(|s| s.len() > 1024)
    {
        return Err("Choose a valid time range of at most 30 days".into());
    }
    Ok(())
}

pub fn read_history(path: &Path, query: &HistoryQuery, now_ms: i64) -> Result<HistoryReport> {
    validate(query, now_ms)?;
    if !path.try_exists()? {
        return Ok(HistoryReport::default());
    }
    let mut db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(Duration::from_millis(250))?;
    let tx = db.transaction()?;
    let version: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if !(1..=3).contains(&version) {
        return Err(format!("Unsupported traffic history schema: {version}").into());
    }
    let mut report = HistoryReport {
        exists: true,
        ..HistoryReport::default()
    };
    report.last_saved_ms =
        tx.query_row("SELECT MAX(last_seen_ms) FROM sessions", [], |r| r.get(0))?;
    report.applications = tx
        .prepare("SELECT key, name, executable FROM applications ORDER BY name, key")?
        .query_map([], |r| {
            Ok(SavedApplication {
                key: r.get(0)?,
                name: r.get(1)?,
                executable: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    report.interfaces = tx
        .prepare("SELECT DISTINCT interface FROM sessions ORDER BY interface")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    // Include only whole stored buckets whose start falls in the selected range.
    let filter = "t.minute_ms >= ?1 AND t.minute_ms < ?2
        AND (?3 IS NULL OR t.app_key = ?3) AND (?4 IS NULL OR s.interface = ?4)";
    let values = params![query.from_ms, query.to_ms, query.app_key, query.interface];
    (report.totals.bytes_sent, report.totals.bytes_received, report.totals.connections) = tx.query_row(
        &format!("SELECT COALESCE(SUM(t.bytes_sent),0), COALESCE(SUM(t.bytes_received),0), COALESCE(SUM(t.connections),0)
                  FROM traffic_buckets t JOIN sessions s ON s.id = t.session_id WHERE {filter}"),
        values, |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    // Coverage describes capture time on the selected interfaces, not an app's lifetime.
    (report.totals.observed_ms, report.totals.incomplete_minutes) = tx.query_row(
        "SELECT COALESCE(SUM(o.observed_ms),0), COALESCE(SUM(CASE WHEN o.incomplete != 0 OR o.observed_ms != 60000 THEN 1 ELSE 0 END),0)
         FROM observation_buckets o JOIN sessions s ON s.id = o.session_id
         WHERE o.minute_ms >= ?1 AND o.minute_ms < ?2 AND (?3 IS NULL OR s.interface = ?3)",
        params![query.from_ms, query.to_ms, query.interface], |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let grouping = "t.app_key, t.destination_key, t.protocol, t.port, s.interface";
    report.row_count = tx.query_row(
        &format!("SELECT COUNT(*) FROM (SELECT 1 FROM traffic_buckets t JOIN sessions s ON s.id = t.session_id WHERE {filter} GROUP BY {grouping})"),
        values, |r| r.get(0),
    )?;
    report.rows = tx.prepare(&format!(
        "SELECT t.app_key, a.name, a.executable, COALESCE(d.value,t.destination_key), t.protocol, t.port, s.interface,
                MIN(t.minute_ms), MAX(t.minute_ms), SUM(t.bytes_sent), SUM(t.bytes_received), SUM(t.connections)
         FROM traffic_buckets t JOIN sessions s ON s.id = t.session_id JOIN applications a ON a.key = t.app_key
         LEFT JOIN destinations d ON d.app_key = t.app_key AND d.key = t.destination_key
         WHERE {filter} GROUP BY {grouping}
         ORDER BY MAX(t.minute_ms) DESC, t.app_key, t.destination_key, t.protocol, t.port, s.interface LIMIT ?5 OFFSET ?6"
    ))?.query_map(params![query.from_ms, query.to_ms, query.app_key, query.interface, PAGE_SIZE, query.offset], |r| {
        Ok(TrafficRow { app_key: r.get(0)?, name: r.get(1)?, executable: r.get(2)?, destination: r.get(3)?,
            protocol: r.get(4)?, port: r.get(5)?, interface: r.get(6)?, first_ms: r.get(7)?, last_ms: r.get(8)?,
            bytes_sent: r.get(9)?, bytes_received: r.get(10)?, connections: r.get(11)? })
    })?.collect::<rusqlite::Result<_>>()?;
    report.sessions = tx.prepare(
        "SELECT s.id, s.started_ms, s.last_seen_ms, s.ended_ms, s.interface, s.runtime_status, s.dropped_snapshots, s.error, s.capture_error
         FROM sessions s WHERE s.started_ms < ?2 AND s.last_seen_ms >= ?1 AND (?4 IS NULL OR s.interface = ?4)
         AND (?3 IS NULL OR EXISTS (SELECT 1 FROM traffic_buckets t WHERE t.session_id = s.id AND t.app_key = ?3 AND t.minute_ms >= ?1 AND t.minute_ms < ?2))
         ORDER BY s.started_ms DESC, s.id DESC LIMIT 20"
    )?.query_map(values, |r| Ok(Session { id: r.get(0)?, started_ms: r.get(1)?, last_seen_ms: r.get(2)?, ended_ms: r.get(3)?,
        interface: r.get(4)?, runtime_status: r.get(5)?, dropped_snapshots: r.get(6)?, error: r.get(7)?, capture_error: r.get(8)? }))?
        .collect::<rusqlite::Result<_>>()?;
    // Complete, unambiguous app-minutes only. Initial, partial and damaged data stays browsable above.
    let mut samples: Vec<Sample> = tx.prepare(
        "SELECT t.app_key, a.name, s.interface, t.minute_ms, SUM(t.bytes_sent), SUM(t.connections),
          COUNT(DISTINCT CASE WHEN d.first_seen_ms >= t.minute_ms AND d.first_seen_ms < t.minute_ms + 60000 THEN d.key END),
          MIN(CASE WHEN d.first_seen_ms >= t.minute_ms AND d.first_seen_ms < t.minute_ms + 60000 THEN d.value END)
         FROM traffic_buckets t JOIN applications a ON a.key = t.app_key JOIN sessions s ON s.id = t.session_id
         JOIN observation_buckets o ON o.session_id = t.session_id AND o.minute_ms = t.minute_ms
         LEFT JOIN destinations d ON d.app_key = t.app_key AND d.key = t.destination_key
         WHERE t.minute_ms >= ?1 AND t.minute_ms + 60000 <= ?2
           AND (?3 IS NULL OR t.app_key = ?3) AND (?4 IS NULL OR s.interface = ?4)
           AND a.executable IS NOT NULL AND o.incomplete = 0 AND o.observed_ms = 60000
           AND s.error IS NULL AND s.capture_error IS NULL AND s.dropped_snapshots = 0
         GROUP BY t.app_key, s.interface, t.minute_ms HAVING COUNT(DISTINCT t.session_id) = 1
         ORDER BY t.minute_ms DESC, t.app_key, s.interface LIMIT ?5"
    )?.query_map(params![(query.to_ms - RETENTION).max(0), query.to_ms, query.app_key, query.interface, MAX_SAMPLES as i64 + 1], |r| {
        Ok(Sample { app_key: r.get(0)?, name: r.get(1)?, interface: r.get(2)?, minute_ms: r.get(3)?, uploaded: r.get::<_, i64>(4)? as f64,
            connections: r.get::<_, i64>(5)? as f64, new_destinations: r.get(6)?, destination: r.get(7)? })
    })?.collect::<rusqlite::Result<_>>()?;
    let limited = samples.len() > MAX_SAMPLES;
    samples.truncate(MAX_SAMPLES);
    samples.reverse();
    report.analysis = detection::analyze(samples, query.from_ms, query.to_ms - MINUTE, limited);
    tx.commit()?;
    Ok(report)
}
