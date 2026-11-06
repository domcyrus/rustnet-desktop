//! One bounded, disposable query cache. SQLite remains the source of truth.
use crate::{
    HistoryQuery, Result, query, read_series,
    series::STEP,
    series_detection,
    timeline::{
        DELTAS, Point, Refresh, SavedApplication, SavedConnection, SavedSample, SeriesReport,
    },
};
use rusqlite::{Connection, OpenFlags, Transaction, params};
use std::{
    cmp::Reverse,
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    time::Duration,
};
const MAX_ROWS: usize = 500_000;
type Coverage = BTreeMap<(i64, i64), (i64, bool)>;
struct Delta {
    flow: i64,
    sample: SavedSample,
}
struct Window {
    path: PathBuf,
    identity: String,
    generation: i64,
    revision: i64,
    from: i64,
    to: i64,
    app: Option<String>,
    interface: Option<String>,
    connection: Option<i64>,
    rows: BTreeMap<(i64, i64), Delta>,
    flows: HashMap<i64, SavedConnection>,
    coverage: Coverage,
    detector: series_detection::Detector,
    eligible: BTreeMap<(i64, Reverse<String>, Reverse<String>), series_detection::Sample>,
}
#[derive(Default)]
pub struct SeriesCache {
    window: Option<Window>,
    token: u64,
    oversized: Option<(PathBuf, String)>,
}
impl SeriesCache {
    pub fn read(
        &mut self,
        path: &Path,
        query: &HistoryQuery,
        connection: Option<i64>,
        cursor: Option<u64>,
        now: i64,
    ) -> Result<SeriesReport> {
        query::validate(query, now)?;
        if connection.is_some_and(|id| id <= 0) {
            return Err("Invalid saved connection".into());
        }
        if !path.try_exists()? {
            self.window = None;
            self.oversized = None;
            return read_series(path, query, connection, now);
        }
        let scope = serde_json::to_string(&(
            query.to_ms - query.from_ms,
            &query.app_key,
            &query.interface,
            connection,
        ))?;
        if self
            .oversized
            .as_ref()
            .is_some_and(|(p, s)| p == path && s == &scope)
        {
            let mut report = read_series(path, query, connection, now)?;
            report.refresh = Some(Refresh {
                cursor: None,
                incremental: false,
                samples_read: report.sample_count as usize,
            });
            return Ok(report);
        }
        self.oversized = None;
        let mut db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        db.busy_timeout(Duration::from_millis(250))?;
        let tx = db.transaction()?;
        let version: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version != 3 {
            self.window = None;
            drop(tx);
            return read_series(path, query, connection, now);
        }
        let (revision, generation, identity): (i64, i64, String) = tx.query_row(
            "SELECT revision,generation,identity FROM history_clock WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let reuse = self.window.as_ref().filter(|w| {
            cursor == Some(self.token)
                && w.path == path
                && w.identity == identity
                && w.generation == generation
                && w.revision <= revision
                && w.revision >= revision - 100_000
                && w.app == query.app_key
                && w.interface == query.interface
                && w.connection == connection
                && query.from_ms >= w.from
                && query.to_ms >= w.to
                && query.from_ms < w.to
        });
        let incremental = reuse.is_some();
        let tail = if let Some(w) = reuse {
            let dirty: Option<i64> = tx.query_row(
                "SELECT MIN(bucket_ms) FROM history_changes WHERE revision>?1",
                [w.revision],
                |r| r.get(0),
            )?;
            // Revisit the last display-independent ten-second bucket, including newly complete intervals.
            dirty.unwrap_or(w.to / STEP * STEP).min(w.to / STEP * STEP)
        } else {
            query.from_ms
        };
        let unchanged = reuse.is_some_and(|w| w.revision == revision && w.to == query.to_ms);
        let from = tail.max(query.from_ms);
        let analysis_from = if incremental {
            tail.max((query.from_ms - series_detection::WEEK).max(0))
        } else {
            (query.from_ms - series_detection::WEEK).max(0)
        };
        let (rows, flows, coverage, eligible) = if unchanged {
            (Vec::new(), HashMap::new(), BTreeMap::new(), Vec::new())
        } else {
            let (rows, flows) = read_rows(&tx, query, connection, from)?;
            let coverage = read_coverage(&tx, query, connection, from)?;
            let eligible = series_detection::read_samples(&tx, query, connection, analysis_from)?;
            (rows, flows, coverage, eligible)
        };
        let samples_read = rows.len();
        let retained = reuse.map_or(0, |w| {
            w.rows
                .range((query.from_ms, i64::MIN)..(from, i64::MIN))
                .count()
        });
        let retained_coverage = reuse.map_or(0, |w| {
            w.coverage
                .range((query.from_ms / STEP * STEP, i64::MIN)..(from / STEP * STEP, i64::MIN))
                .count()
        });
        if samples_read + retained > MAX_ROWS || coverage.len() + retained_coverage > MAX_ROWS {
            self.oversized = Some((path.into(), scope));
            self.window = None;
            drop(tx);
            let mut report = read_series(path, query, connection, now)?;
            report.refresh = Some(Refresh {
                cursor: None,
                incremental: false,
                samples_read: report.sample_count as usize,
            });
            return Ok(report);
        }
        tx.commit()?;
        if !incremental {
            self.window = Some(Window {
                path: path.into(),
                identity,
                generation,
                revision,
                from: query.from_ms,
                to: query.to_ms,
                app: query.app_key.clone(),
                interface: query.interface.clone(),
                connection,
                rows: BTreeMap::new(),
                flows: HashMap::new(),
                coverage: BTreeMap::new(),
                detector: series_detection::Detector::default(),
                eligible: BTreeMap::new(),
            });
        }
        let w = self.window.as_mut().ok_or("Missing history cache")?;
        w.rows
            .retain(|(time, _), _| *time >= query.from_ms && (unchanged || *time < from));
        w.coverage.retain(|(time, _), _| {
            *time >= query.from_ms / STEP * STEP && (unchanged || *time < from / STEP * STEP)
        });
        let was_limited = w.eligible.len() > series_detection::LIMIT;
        let incoming: BTreeMap<_, _> = eligible
            .into_iter()
            .map(|s| {
                (
                    (s.time, Reverse(s.key.clone()), Reverse(s.interface.clone())),
                    s,
                )
            })
            .collect();
        let cutoff = (query.from_ms - series_detection::WEEK).max(0);
        let mut replay = !incremental
            || w.eligible.iter().any(|(key, s)| {
                key.0 < cutoff
                    || (!unchanged && key.0 >= analysis_from && incoming.get(key) != Some(s))
            });
        let last = w.eligible.last_key_value().map(|(k, _)| k.clone());
        let added: Vec<_> = incoming
            .iter()
            .filter(|(k, _)| !w.eligible.contains_key(*k))
            .map(|(k, s)| (k.clone(), s.clone()))
            .collect();
        replay |= added
            .iter()
            .any(|(k, _)| last.as_ref().is_some_and(|last| k <= last));
        w.eligible
            .retain(|(time, _, _), _| *time >= cutoff && (unchanged || *time < analysis_from));
        for row in rows {
            w.rows.insert((row.sample.timestamp_ms, row.flow), row);
        }
        w.flows.extend(flows);
        w.coverage.extend(coverage);
        w.eligible.extend(incoming);
        while w.eligible.len() > series_detection::LIMIT + 1 {
            w.eligible.pop_first();
            replay = true;
        }
        replay |= was_limited != (w.eligible.len() > series_detection::LIMIT);
        if replay {
            w.detector = series_detection::Detector::default();
            for s in w
                .eligible
                .values()
                .skip(usize::from(w.eligible.len() > series_detection::LIMIT))
            {
                w.detector.push(s.clone());
            }
        } else {
            for (_, s) in added {
                w.detector.push(s);
            }
        }
        let active: HashSet<_> = w.rows.values().map(|d| d.flow).collect();
        w.flows.retain(|id, _| active.contains(id));
        w.from = query.from_ms;
        w.to = query.to_ms;
        w.revision = revision;
        self.token = self
            .token
            .checked_add(1)
            .ok_or("History cursor exhausted")?;
        let mut report = assemble(w, query)?;
        report.refresh = Some(Refresh {
            cursor: Some(self.token),
            incremental,
            samples_read,
        });
        Ok(report)
    }
}
fn read_rows(
    tx: &Transaction<'_>,
    q: &HistoryQuery,
    connection: Option<i64>,
    from: i64,
) -> Result<(Vec<Delta>, HashMap<i64, SavedConnection>)> {
    let sql = format!("{DELTAS} SELECT d.flow_id,d.timestamp_ms,d.previous_ms,d.bytes_sent,d.bytes_received,
        d.packets_sent,d.packets_received,d.sent,d.received,d.kind,
        COALESCE(a.name,'Unattributed'),a.executable,f.pid,f.local_ip,f.local_port,f.remote_ip,f.remote_port,f.hostname,
        f.protocol,s.interface,f.first_seen_ms,f.last_seen_ms,f.ended_ms,f.end_reason,f.app_key
        FROM deltas d JOIN flow_records f ON f.id=d.flow_id JOIN sessions s ON s.id=f.session_id
        LEFT JOIN applications a ON a.key=f.app_key ORDER BY d.timestamp_ms,d.flow_id LIMIT ?6");
    let mut stmt = tx.prepare(&sql)?;
    let mut result = stmt.query(params![
        from,
        q.to_ms,
        q.app_key,
        q.interface,
        connection,
        MAX_ROWS as i64 + 1
    ])?;
    let mut rows = Vec::new();
    let mut flows = HashMap::new();
    while let Some(r) = result.next()? {
        let id = r.get(0)?;
        rows.push(Delta {
            flow: id,
            sample: SavedSample {
                timestamp_ms: r.get(1)?,
                interval_start_ms: r.get(2)?,
                bytes_sent: r.get(3)?,
                bytes_received: r.get(4)?,
                packets_sent: r.get(5)?,
                packets_received: r.get(6)?,
                delta_sent: r.get(7)?,
                delta_received: r.get(8)?,
                kind: r.get(9)?,
            },
        });
        flows.insert(
            id,
            SavedConnection {
                id,
                name: r.get(10)?,
                executable: r.get(11)?,
                pid: r.get(12)?,
                local_ip: r.get(13)?,
                local_port: r.get(14)?,
                remote_ip: r.get(15)?,
                remote_port: r.get(16)?,
                hostname: r.get(17)?,
                protocol: r.get(18)?,
                interface: r.get(19)?,
                first_seen_ms: r.get(20)?,
                last_seen_ms: r.get(21)?,
                ended_ms: r.get(22)?,
                end_reason: r.get(23)?,
                bytes_sent: 0,
                bytes_received: 0,
                uncertain_samples: 0,
                app_key: r.get(24)?,
            },
        );
    }
    Ok((rows, flows))
}
fn read_coverage(
    tx: &Transaction<'_>,
    q: &HistoryQuery,
    connection: Option<i64>,
    from: i64,
) -> Result<Coverage> {
    Ok(tx.prepare("SELECT c.bucket_ms,c.session_id,c.observed_ms,c.incomplete FROM capture_intervals c JOIN sessions s ON s.id=c.session_id
        WHERE c.bucket_ms>=?1 AND c.bucket_ms<?2 AND (?3 IS NULL OR s.interface=?3)
        AND (?4 IS NULL OR s.id=(SELECT session_id FROM flow_records WHERE id=?4)) LIMIT ?5")?
        .query_map(params![from/STEP*STEP,q.to_ms,q.interface,connection,MAX_ROWS as i64+1],|r|Ok(((r.get(0)?,r.get(1)?),(r.get(2)?,r.get(3)?))))?
        .collect::<rusqlite::Result<_>>()?)
}
fn assemble(w: &Window, q: &HistoryQuery) -> Result<SeriesReport> {
    let resolution = [STEP, 60_000, 300_000, 900_000, 3_600_000, 21_600_000]
        .into_iter()
        .find(|s| (q.to_ms - q.from_ms) / s <= 180)
        .unwrap_or(21_600_000);
    let mut report = SeriesReport {
        available: true,
        from_ms: q.from_ms,
        to_ms: q.to_ms,
        resolution_ms: resolution,
        ..Default::default()
    };
    let mut points: BTreeMap<_, _> = (q.from_ms / resolution..=(q.to_ms - 1) / resolution)
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
    let mut connections: HashMap<i64, SavedConnection> = HashMap::new();
    let mut counts: HashMap<i64, HashSet<i64>> = HashMap::new();
    for d in w.rows.values() {
        let sample = &d.sample;
        let sent = sample.delta_sent.unwrap_or(0);
        let received = sample.delta_received.unwrap_or(0);
        let uncertain = i64::from(sample.delta_sent.is_none() || sample.delta_received.is_none());
        report.bytes_sent = report
            .bytes_sent
            .checked_add(sent)
            .ok_or("History byte total overflow")?;
        report.bytes_received = report
            .bytes_received
            .checked_add(received)
            .ok_or("History byte total overflow")?;
        report.uncertain_samples += uncertain;
        report.sample_count += 1;
        let bucket = sample.timestamp_ms / resolution * resolution;
        if let Some(p) = points.get_mut(&bucket) {
            p.bytes_sent += sent;
            p.bytes_received += received;
            p.samples += 1;
            p.uncertain_samples += uncertain;
            p.counter_resets += i64::from(sample.kind == "reset");
            counts.entry(bucket).or_default().insert(d.flow);
        }
        if let Some(meta) = w.flows.get(&d.flow) {
            let c = connections.entry(d.flow).or_insert_with(|| meta.clone());
            c.bytes_sent += sent;
            c.bytes_received += received;
            c.uncertain_samples += uncertain;
        }
    }
    for ((time, _), (observed, incomplete)) in &w.coverage {
        if let Some(p) = points.get_mut(&(time / resolution * resolution)) {
            p.observed_ms += observed;
            p.incomplete |= incomplete;
        }
    }
    let limited = w.eligible.len() > series_detection::LIMIT;
    report.analysis = w.detector.report(
        q.from_ms,
        q.to_ms,
        w.eligible.len().min(series_detection::LIMIT),
        limited,
    );
    for f in &report.analysis.findings {
        if let Some(p) = points.get_mut(&(f.timestamp_ms / resolution * resolution)) {
            p.findings += 1;
        }
    }
    for (time, p) in &mut points {
        p.active_connections = counts.get(time).map_or(0, |s| s.len() as i64);
        p.incomplete |= p.observed_ms < resolution
            || p.uncertain_samples > 0
            || *time < q.from_ms
            || time + resolution > q.to_ms;
    }
    report.points = points.into_values().collect();
    let mut apps: HashMap<String, SavedApplication> = HashMap::new();
    for c in connections.values() {
        let a = apps
            .entry(c.app_key.clone())
            .or_insert_with(|| SavedApplication {
                key: c.app_key.clone(),
                name: c.name.clone(),
                executable: c.executable.clone(),
                connections: 0,
                bytes_sent: 0,
                bytes_received: 0,
            });
        a.connections += 1;
        a.bytes_sent += c.bytes_sent;
        a.bytes_received += c.bytes_received;
    }
    report.application_count = apps.len() as i64;
    report.applications = apps.into_values().collect();
    report.applications.sort_by(|a, b| {
        (i128::from(b.bytes_sent) + i128::from(b.bytes_received))
            .cmp(&(i128::from(a.bytes_sent) + i128::from(a.bytes_received)))
            .then_with(|| a.key.cmp(&b.key))
    });
    report.applications.truncate(200);
    report.connection_count = connections.len() as i64;
    let mut ordered: Vec<_> = connections.into_values().collect();
    ordered.sort_by(|a, b| {
        (i128::from(b.bytes_sent) + i128::from(b.bytes_received))
            .cmp(&(i128::from(a.bytes_sent) + i128::from(a.bytes_received)))
            .then_with(|| a.id.cmp(&b.id))
    });
    report.connections = ordered
        .into_iter()
        .skip(if w.connection.is_some() {
            0
        } else {
            q.offset as usize
        })
        .take(50)
        .collect();
    if w.connection.is_some() {
        report.samples = w
            .rows
            .values()
            .skip(q.offset as usize)
            .take(200)
            .map(|d| d.sample.clone())
            .collect();
    }
    Ok(report)
}
