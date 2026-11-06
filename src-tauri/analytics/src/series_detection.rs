//! Anomaly baselines derived from complete ten-second connection sample intervals.
use crate::{HistoryQuery, MINUTE, Result, series::STEP, timeline::DELTAS};
use rusqlite::{Transaction, params};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
const REQUIRED: usize = 180;
const WINDOW: usize = 720;
pub(crate) const WEEK: i64 = 7 * 24 * 60 * MINUTE;
pub(crate) const LIMIT: usize = 100_000;

#[derive(Clone, Default, Serialize)]
pub struct Analysis {
    pub findings: Vec<Finding>,
    pub ready_profiles: usize,
    pub learning_profiles: usize,
    pub eligible_intervals: usize,
    pub limited: bool,
    pub findings_limited: bool,
}
#[derive(Clone, Serialize)]
pub struct Finding {
    pub kind: &'static str,
    pub app_key: String,
    pub name: String,
    pub interface: String,
    pub timestamp_ms: i64,
    pub observed: f64,
    pub baseline: f64,
    pub threshold: f64,
    pub prior_intervals: usize,
    pub destination: Option<String>,
}
#[derive(Clone, PartialEq)]
pub(crate) struct Sample {
    pub(crate) key: String,
    name: String,
    pub(crate) interface: String,
    pub(crate) time: i64,
    sent: f64,
    received: f64,
    connections: f64,
    destinations: i64,
    destination: Option<String>,
}
fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    let n = values.len();
    if n.is_multiple_of(2) {
        (values[n / 2 - 1] + values[n / 2]) / 2.0
    } else {
        values[n / 2]
    }
}
fn threshold(values: impl Iterator<Item = f64>, floor: f64, margin: f64) -> (f64, f64) {
    let mut values: Vec<_> = values.collect();
    let center = median(&mut values);
    let mut deviations: Vec<_> = values.iter().map(|n| (n - center).abs()).collect();
    (
        center,
        floor
            .max(center * 5.0)
            .max(center + 6.0 * median(&mut deviations) + margin),
    )
}

pub(crate) fn read(
    tx: &Transaction<'_>,
    query: &HistoryQuery,
    connection: Option<i64>,
) -> Result<Analysis> {
    let mut samples = read_samples(tx, query, connection, (query.from_ms - WEEK).max(0))?;
    let limited = samples.len() > LIMIT;
    samples.truncate(LIMIT);
    samples.reverse();
    Ok(analyze(samples, query.from_ms, query.to_ms, limited))
}

pub(crate) fn read_samples(
    tx: &Transaction<'_>,
    query: &HistoryQuery,
    connection: Option<i64>,
    from: i64,
) -> Result<Vec<Sample>> {
    // A selected connection retains its application's baseline across connections and sessions.
    let scope: Option<(String, String)> = if let Some(id) = connection {
        use rusqlite::OptionalExtension;
        tx.query_row("SELECT f.app_key,s.interface FROM flow_records f JOIN sessions s ON s.id=f.session_id WHERE f.id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?
    } else {
        None
    };
    if connection.is_some() && scope.is_none() {
        return Ok(Vec::new());
    }
    let app = scope
        .as_ref()
        .map(|s| s.0.as_str())
        .or(query.app_key.as_deref());
    let interface = scope
        .as_ref()
        .map(|s| s.1.as_str())
        .or(query.interface.as_deref());
    // Endpoint assignment matches the timeline; origins carry no traffic. A bucket with an
    // unknown delta, overlong interval, incomplete coverage or overlapping sessions cannot train.
    let sql=format!("{DELTAS}, destination_first AS (
        SELECT f.app_key,s.interface,COALESCE(NULLIF(f.hostname,''),f.remote_ip) AS destination,
            MIN(f.first_seen_ms) AS first_ms
        FROM flow_records f JOIN sessions s ON s.id=f.session_id
        WHERE (?3 IS NULL OR f.app_key=?3) AND (?4 IS NULL OR s.interface=?4)
        GROUP BY f.app_key,s.interface,destination
    ), eligible AS (
        SELECT f.app_key,a.name,s.interface,d.timestamp_ms/10000*10000 AS bucket,
            SUM(COALESCE(d.sent,0)) AS sent,SUM(COALESCE(d.received,0)) AS received,
            COUNT(DISTINCT CASE WHEN f.created_ms>=f.first_seen_ms-5000 AND f.first_seen_ms>=d.timestamp_ms/10000*10000
                AND f.first_seen_ms<d.timestamp_ms/10000*10000+10000 THEN f.id END) AS connections,
            COUNT(DISTINCT CASE WHEN n.first_ms>=d.timestamp_ms/10000*10000 AND n.first_ms<d.timestamp_ms/10000*10000+10000 THEN n.destination END) AS destinations,
            MIN(CASE WHEN n.first_ms>=d.timestamp_ms/10000*10000 AND n.first_ms<d.timestamp_ms/10000*10000+10000 THEN n.destination END) AS destination
        FROM deltas d JOIN flow_records f ON f.id=d.flow_id JOIN applications a ON a.key=f.app_key
        JOIN sessions s ON s.id=f.session_id
        LEFT JOIN capture_intervals c ON c.session_id=s.id AND c.bucket_ms=d.timestamp_ms/10000*10000
        LEFT JOIN destination_first n ON n.app_key=f.app_key AND n.interface=s.interface
            AND n.destination=COALESCE(NULLIF(f.hostname,''),f.remote_ip)
        WHERE a.executable IS NOT NULL AND d.timestamp_ms/10000*10000+10000<=?2
        GROUP BY f.app_key,s.interface,bucket
        HAVING COUNT(DISTINCT s.id)=1 AND SUM(d.sent IS NOT NULL)>0
            AND MIN(COALESCE(c.observed_ms,0))=10000 AND MAX(COALESCE(c.incomplete,1))=0
            AND MAX(s.error IS NOT NULL OR s.capture_error IS NOT NULL)=0
            AND SUM(CASE WHEN d.kind='origin' THEN 0
                WHEN d.sent IS NULL OR d.received IS NULL OR d.timestamp_ms-d.previous_ms>15000
                    OR EXISTS (SELECT 1 FROM capture_intervals bad WHERE bad.session_id=s.id
                        AND bad.bucket_ms>=d.previous_ms/10000*10000 AND bad.bucket_ms<=d.timestamp_ms/10000*10000
                        AND (bad.incomplete!=0 OR bad.observed_ms!=10000)) THEN 1 ELSE 0 END)=0
    ) SELECT app_key,name,interface,bucket,sent,received,connections,destinations,destination
      FROM eligible ORDER BY bucket DESC,app_key,interface LIMIT ?6");
    let samples = tx
        .prepare(&sql)?
        .query_map(
            params![
                from,
                query.to_ms,
                app,
                interface,
                None::<i64>,
                LIMIT as i64 + 1
            ],
            |r| {
                Ok(Sample {
                    key: r.get(0)?,
                    name: r.get(1)?,
                    interface: r.get(2)?,
                    time: r.get(3)?,
                    sent: r.get::<_, i64>(4)? as f64,
                    received: r.get::<_, i64>(5)? as f64,
                    connections: r.get::<_, i64>(6)? as f64,
                    destinations: r.get(7)?,
                    destination: r.get(8)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(samples)
}
#[derive(Default)]
pub(crate) struct Detector {
    profiles: HashMap<(String, String), VecDeque<Sample>>,
    findings: Vec<Finding>,
    last_discarded: Option<i64>,
}
impl Detector {
    pub(crate) fn push(&mut self, sample: Sample) {
        let profile = self
            .profiles
            .entry((sample.key.clone(), sample.interface.clone()))
            .or_default();
        while profile.front().is_some_and(|p| p.time < sample.time - WEEK) {
            profile.pop_front();
        }
        let mut unusual = false;
        if profile.len() >= REQUIRED {
            let upload = threshold(
                profile.iter().map(|p| p.sent),
                2.0 * 1024.0 * 1024.0,
                256.0 * 1024.0,
            );
            let download = threshold(
                profile.iter().map(|p| p.received),
                10.0 * 1024.0 * 1024.0,
                1024.0 * 1024.0,
            );
            let connections = threshold(profile.iter().map(|p| p.connections), 20.0, 4.0);
            for (kind, observed, (baseline, threshold)) in [
                ("upload", sample.sent, upload),
                ("download", sample.received, download),
                ("connections", sample.connections, connections),
                ("destination", sample.destinations as f64, (0.0, 0.0)),
            ] {
                if observed <= threshold {
                    continue;
                }
                unusual |= kind != "destination";
                if self.findings.len() == 100 {
                    self.last_discarded = Some(self.findings.remove(0).timestamp_ms);
                }
                self.findings.push(Finding {
                    kind,
                    app_key: sample.key.clone(),
                    name: sample.name.clone(),
                    interface: sample.interface.clone(),
                    timestamp_ms: sample.time,
                    observed,
                    baseline,
                    threshold,
                    prior_intervals: profile.len(),
                    destination: if kind == "destination" {
                        sample.destination.clone()
                    } else {
                        None
                    },
                });
            }
        }
        if !unusual {
            profile.push_back(sample);
            if profile.len() > WINDOW {
                profile.pop_front();
            }
        }
    }
    pub(crate) fn report(&self, from: i64, to: i64, eligible: usize, limited: bool) -> Analysis {
        let mut report = Analysis {
            eligible_intervals: eligible,
            limited,
            findings_limited: self.last_discarded.is_some_and(|t| t >= from),
            findings: self
                .findings
                .iter()
                .filter(|f| f.timestamp_ms >= from && f.timestamp_ms < to)
                .cloned()
                .collect(),
            ..Default::default()
        };
        for profile in self.profiles.values() {
            let count = profile
                .iter()
                .filter(|p| p.time >= to - STEP - WEEK)
                .count();
            if count >= REQUIRED {
                report.ready_profiles += 1;
            } else if count > 0 {
                report.learning_profiles += 1;
            }
        }
        report.findings.sort_by(|a, b| {
            b.timestamp_ms
                .cmp(&a.timestamp_ms)
                .then_with(|| a.app_key.cmp(&b.app_key))
                .then_with(|| a.interface.cmp(&b.interface))
                .then_with(|| a.kind.cmp(b.kind))
        });
        report
    }
}
pub(crate) fn analyze(samples: Vec<Sample>, from: i64, to: i64, limited: bool) -> Analysis {
    let count = samples.len();
    let mut detector = Detector::default();
    for sample in samples {
        detector.push(sample);
    }
    detector.report(from, to, count, limited)
}
