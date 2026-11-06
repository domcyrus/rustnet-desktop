use crate::{HistoryQuery, Result, query, series::STEP, series_detection};
use rusqlite::{Connection, OpenFlags, params};
use serde::Serialize;
use std::{collections::BTreeMap, path::Path, time::Duration};

#[derive(Clone, Default, Serialize)]
pub struct SeriesReport {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh: Option<Refresh>,
    pub available: bool,
    pub from_ms: i64,
    pub to_ms: i64,
    pub resolution_ms: i64,
    pub bytes_sent: i64,
    pub bytes_received: i64,
    pub uncertain_samples: i64,
    pub points: Vec<Point>,
    pub connections: Vec<SavedConnection>,
    pub connection_count: i64,
    pub samples: Vec<SavedSample>,
    pub applications: Vec<SavedApplication>,
    pub application_count: i64,
    pub analysis: series_detection::Analysis,
    pub sample_count: i64,
}
#[derive(Clone, Default, Serialize)]
pub struct Point {
    pub timestamp_ms: i64,
    pub bytes_sent: i64,
    pub bytes_received: i64,
    pub samples: i64,
    pub uncertain_samples: i64,
    pub observed_ms: i64,
    pub incomplete: bool,
    pub active_connections: i64,
    pub counter_resets: i64,
    pub findings: usize,
}
#[derive(Clone, Serialize)]
pub struct SavedApplication {
    pub key: String,
    pub name: String,
    pub executable: Option<String>,
    pub connections: i64,
    pub bytes_sent: i64,
    pub bytes_received: i64,
}
#[derive(Clone, Serialize)]
pub struct SavedConnection {
    #[serde(skip)]
    pub(crate) app_key: String,
    pub id: i64,
    pub name: String,
    pub executable: Option<String>,
    pub pid: Option<i64>,
    pub local_ip: Option<String>,
    pub local_port: Option<u16>,
    pub remote_ip: String,
    pub remote_port: u16,
    pub hostname: Option<String>,
    pub protocol: String,
    pub interface: String,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
    pub ended_ms: Option<i64>,
    pub end_reason: Option<String>,
    pub bytes_sent: i64,
    pub bytes_received: i64,
    pub uncertain_samples: i64,
}
#[derive(Clone, Serialize)]
pub struct SavedSample {
    pub timestamp_ms: i64,
    pub interval_start_ms: Option<i64>,
    pub bytes_sent: i64,
    pub bytes_received: i64,
    pub packets_sent: Option<i64>,
    pub packets_received: Option<i64>,
    pub delta_sent: Option<i64>,
    pub delta_received: Option<i64>,
    pub kind: String,
}

#[derive(Clone, Serialize)]
pub struct Refresh {
    pub cursor: Option<u64>,
    pub incremental: bool,
    pub samples_read: usize,
}

// Include one predecessor per connection so a range boundary does not discard its first delta.
// A segment change explicitly breaks subtraction across gaps, resets and reconnects.
pub(crate) const DELTAS: &str = "WITH selected AS (
    SELECT f.* FROM flow_records f JOIN sessions s ON s.id=f.session_id
    WHERE (?3 IS NULL OR f.app_key=?3) AND (?4 IS NULL OR s.interface=?4) AND (?5 IS NULL OR f.id=?5)
      AND f.first_seen_ms < ?2 AND f.last_seen_ms >= ?1
), relevant AS (
    SELECT p.* FROM selected f JOIN flow_samples p ON p.flow_id=f.id
    WHERE p.timestamp_ms>=?1 AND p.timestamp_ms<?2
    UNION ALL
    SELECT p.* FROM selected f JOIN flow_samples p ON p.flow_id=f.id AND p.timestamp_ms=
        (SELECT MAX(b.timestamp_ms) FROM flow_samples b WHERE b.flow_id=f.id AND b.timestamp_ms<?1)
), raw AS (
    SELECT p.*, LAG(timestamp_ms) OVER w AS previous_ms,
        LAG(segment) OVER w AS previous_segment,
        LAG(bytes_sent) OVER w AS previous_sent, LAG(bytes_received) OVER w AS previous_received
    FROM relevant p
    WINDOW w AS (PARTITION BY p.flow_id ORDER BY p.timestamp_ms)
), deltas AS (
    SELECT *, CASE WHEN segment=previous_segment AND timestamp_ms>previous_ms AND bytes_sent>=previous_sent
        THEN bytes_sent-previous_sent END AS sent,
        CASE WHEN segment=previous_segment AND timestamp_ms>previous_ms AND bytes_received>=previous_received
        THEN bytes_received-previous_received END AS received
    FROM raw WHERE timestamp_ms>=?1
) ";

pub fn read_series(
    path: &Path,
    query: &HistoryQuery,
    connection_id: Option<i64>,
    now_ms: i64,
) -> Result<SeriesReport> {
    query::validate(query, now_ms)?;
    if connection_id.is_some_and(|id| id <= 0) {
        return Err("Invalid saved connection".into());
    }
    let resolution = [STEP, 60_000, 300_000, 900_000, 3_600_000, 21_600_000]
        .into_iter()
        .find(|step| (query.to_ms - query.from_ms) / step <= 180)
        .unwrap_or(21_600_000);
    let mut report = SeriesReport {
        from_ms: query.from_ms,
        to_ms: query.to_ms,
        resolution_ms: resolution,
        ..Default::default()
    };
    if !path.try_exists()? {
        return Ok(report);
    }
    let mut db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(Duration::from_millis(250))?;
    let tx = db.transaction()?;
    let version: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version == 1 {
        return Ok(report);
    }
    if version != 2 && version != 3 {
        return Err(format!("Unsupported traffic history schema: {version}").into());
    }
    report.available = true;
    let args = params![
        query.from_ms,
        query.to_ms,
        query.app_key,
        query.interface,
        connection_id
    ];
    (report.bytes_sent,report.bytes_received,report.uncertain_samples,report.connection_count,report.sample_count) =
        tx.query_row(&format!("{DELTAS} SELECT COALESCE(SUM(sent),0),COALESCE(SUM(received),0),
            COALESCE(SUM(sent IS NULL OR received IS NULL),0),COUNT(DISTINCT flow_id),COUNT(*) FROM deltas"), args,
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
    let mut points: BTreeMap<i64, Point> = (query.from_ms / resolution
        ..=(query.to_ms - 1) / resolution)
        .map(|i| {
            (
                i * resolution,
                Point {
                    timestamp_ms: i * resolution,
                    ..Default::default()
                },
            )
        })
        .collect();
    let data = tx
        .prepare(&format!(
            "{DELTAS} SELECT timestamp_ms/?6*?6,COALESCE(SUM(sent),0),COALESCE(SUM(received),0),
        COUNT(*),SUM(sent IS NULL OR received IS NULL),COUNT(DISTINCT flow_id),SUM(kind='reset') FROM deltas GROUP BY 1"
        ))?
        .query_map(
            params![
                query.from_ms,
                query.to_ms,
                query.app_key,
                query.interface,
                connection_id,
                resolution
            ],
            |r| {
                Ok(Point {
                    timestamp_ms: r.get(0)?,
                    bytes_sent: r.get(1)?,
                    bytes_received: r.get(2)?,
                    samples: r.get(3)?,
                    uncertain_samples: r.get(4)?,
                    active_connections: r.get(5)?,
                    counter_resets: r.get(6)?,
                    ..Default::default()
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for p in data {
        points.insert(p.timestamp_ms, p);
    }
    let coverage = tx
        .prepare(
            "SELECT c.bucket_ms/?3*?3,SUM(c.observed_ms),MAX(c.incomplete)
        FROM capture_intervals c JOIN sessions s ON s.id=c.session_id
        WHERE c.bucket_ms>=?1 AND c.bucket_ms<?2 AND (?4 IS NULL OR s.interface=?4)
          AND (?5 IS NULL OR s.id=(SELECT session_id FROM flow_records WHERE id=?5)) GROUP BY 1",
        )?
        .query_map(
            params![
                query.from_ms / STEP * STEP,
                query.to_ms,
                resolution,
                query.interface,
                connection_id
            ],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, bool>(2)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (time, observed, incomplete) in coverage {
        if let Some(p) = points.get_mut(&time) {
            p.observed_ms = observed;
            p.incomplete = incomplete;
        }
    }
    for p in points.values_mut() {
        // A partial edge bucket is not a complete observation of the requested interval.
        p.incomplete |= p.observed_ms < resolution
            || p.uncertain_samples > 0
            || p.timestamp_ms < query.from_ms
            || p.timestamp_ms + resolution > query.to_ms;
    }
    report.analysis = series_detection::read(&tx, query, connection_id)?;
    for finding in &report.analysis.findings {
        if let Some(p) = points.get_mut(&(finding.timestamp_ms / resolution * resolution)) {
            p.findings += 1;
        }
    }
    report.points = points.into_values().collect();
    report.application_count = tx.query_row(&format!("{DELTAS} SELECT COUNT(DISTINCT f.app_key) FROM deltas d JOIN flow_records f ON f.id=d.flow_id"), args, |r|r.get(0))?;
    report.applications = tx.prepare(&format!("{DELTAS} SELECT f.app_key,COALESCE(a.name,'Unattributed'),a.executable,
        COUNT(DISTINCT f.id),COALESCE(SUM(d.sent),0),COALESCE(SUM(d.received),0)
        FROM deltas d JOIN flow_records f ON f.id=d.flow_id LEFT JOIN applications a ON a.key=f.app_key
        GROUP BY f.app_key ORDER BY SUM(COALESCE(d.sent,0)+COALESCE(d.received,0)) DESC,f.app_key LIMIT 200"))?
        .query_map(args, |r|Ok(SavedApplication {key:r.get(0)?,name:r.get(1)?,executable:r.get(2)?,connections:r.get(3)?,bytes_sent:r.get(4)?,bytes_received:r.get(5)?}))?
        .collect::<rusqlite::Result<_>>()?;
    report.connections = tx.prepare(&format!("{DELTAS} SELECT f.id,COALESCE(a.name,'Unattributed'),a.executable,f.pid,
        f.local_ip,f.local_port,f.remote_ip,f.remote_port,f.hostname,f.protocol,s.interface,
        f.first_seen_ms,f.last_seen_ms,f.ended_ms,f.end_reason,COALESCE(SUM(d.sent),0),COALESCE(SUM(d.received),0),
        SUM(d.sent IS NULL OR d.received IS NULL)
        FROM deltas d JOIN flow_records f ON f.id=d.flow_id JOIN sessions s ON s.id=f.session_id
        LEFT JOIN applications a ON a.key=f.app_key GROUP BY f.id
        ORDER BY SUM(COALESCE(d.sent,0)+COALESCE(d.received,0)) DESC,f.id LIMIT 50 OFFSET ?6"))?
        .query_map(params![query.from_ms,query.to_ms,query.app_key,query.interface,connection_id,if connection_id.is_some() {0} else {query.offset}], |r|
            Ok(SavedConnection {app_key:String::new(),id:r.get(0)?,name:r.get(1)?,executable:r.get(2)?,pid:r.get(3)?,local_ip:r.get(4)?,local_port:r.get(5)?,
                remote_ip:r.get(6)?,remote_port:r.get(7)?,hostname:r.get(8)?,protocol:r.get(9)?,interface:r.get(10)?,
                first_seen_ms:r.get(11)?,last_seen_ms:r.get(12)?,ended_ms:r.get(13)?,end_reason:r.get(14)?,
                bytes_sent:r.get(15)?,bytes_received:r.get(16)?,uncertain_samples:r.get(17)?}))?
        .collect::<rusqlite::Result<_>>()?;
    if connection_id.is_some() {
        report.samples = tx.prepare(&format!("{DELTAS} SELECT timestamp_ms,previous_ms,bytes_sent,bytes_received,
            packets_sent,packets_received,sent,received,kind FROM deltas ORDER BY timestamp_ms LIMIT 200 OFFSET ?6"))?
            .query_map(params![query.from_ms,query.to_ms,query.app_key,query.interface,connection_id,query.offset], |r|
                Ok(SavedSample {timestamp_ms:r.get(0)?,interval_start_ms:r.get(1)?,bytes_sent:r.get(2)?,bytes_received:r.get(3)?,
                    packets_sent:r.get(4)?,packets_received:r.get(5)?,delta_sent:r.get(6)?,delta_received:r.get(7)?,kind:r.get(8)?}))?
            .collect::<rusqlite::Result<_>>()?;
    }
    tx.commit()?;
    Ok(report)
}
