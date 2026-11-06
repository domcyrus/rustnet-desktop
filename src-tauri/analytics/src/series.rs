//! Durable per-connection counters; temporary state follows every delivered snapshot.
use crate::{Flow, Result, Snapshot};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

pub(crate) const STEP: i64 = 10_000;

pub(crate) fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TEMP TABLE flow_pending (
        flow_id INTEGER PRIMARY KEY, observed_ms INTEGER NOT NULL,
        sent INTEGER NOT NULL, received INTEGER NOT NULL, packets_sent INTEGER, packets_received INTEGER,
        segment INTEGER NOT NULL, sampled_ms INTEGER NOT NULL, sequence INTEGER NOT NULL,
        closed INTEGER NOT NULL
    );")?;
    Ok(())
}

struct Pending {
    id: i64,
    time: i64,
    sent: i64,
    received: i64,
    packets_sent: Option<i64>,
    packets_received: Option<i64>,
    segment: i64,
    sampled: i64,
    closed: bool,
}
impl Pending {
    fn read(r: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            time: r.get(1)?,
            sent: r.get(2)?,
            received: r.get(3)?,
            packets_sent: r.get(4)?,
            packets_received: r.get(5)?,
            segment: r.get(6)?,
            sampled: r.get(7)?,
            closed: r.get(9)?,
        })
    }
    fn sample(&self, tx: &Transaction<'_>, kind: &str) -> Result<()> {
        tx.prepare_cached(
            "INSERT INTO flow_samples VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
            ON CONFLICT(flow_id,timestamp_ms) DO UPDATE SET segment=excluded.segment,
            bytes_sent=excluded.bytes_sent, bytes_received=excluded.bytes_received,
            packets_sent=excluded.packets_sent, packets_received=excluded.packets_received,
            kind=CASE WHEN flow_samples.kind IN ('gap','reset') OR excluded.kind='boundary'
                THEN flow_samples.kind ELSE excluded.kind END",
        )?
        .execute(params![
            self.id,
            self.time,
            self.segment,
            self.sent,
            self.received,
            self.packets_sent,
            self.packets_received,
            kind
        ])?;
        tx.prepare_cached("UPDATE flow_records SET last_seen_ms=?2 WHERE id=?1")?
            .execute(params![self.id, self.time])?;
        Ok(())
    }
}

fn app_key(flow: &Flow) -> Result<String> {
    let process = flow.process.as_ref();
    let executable = process
        .and_then(|p| p.executable.as_deref())
        .filter(|s| !s.is_empty());
    let name = process
        .and_then(|p| p.name.as_deref())
        .filter(|s| !s.is_empty())
        .unwrap_or("Unattributed");
    Ok(serde_json::to_string(&match executable {
        Some(path) => ["executable", path],
        None if name != "Unattributed" => ["name", name],
        None => ["unattributed", ""],
    })?)
}

pub(crate) fn ingest(
    tx: &Transaction<'_>,
    session: i64,
    snapshot: &Snapshot,
    sequence: u64,
    previous: Option<i64>,
    continuous: bool,
    incomplete: bool,
) -> Result<()> {
    let now = snapshot.timestamp.timestamp_millis();
    let sequence = i64::try_from(sequence)?;
    for flow in &snapshot.connections {
        let created = flow.created_at.timestamp_millis();
        let key = app_key(flow)?;
        let hostname = flow
            .hostname
            .as_deref()
            .map(|s| s.trim_end_matches('.').to_lowercase());
        tx.prepare_cached("INSERT INTO flow_records(session_id,engine_id,created_ms,app_key,local_ip,local_port,
            remote_ip,remote_port,protocol,hostname,pid,first_seen_ms,last_seen_ms)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12)
            ON CONFLICT(session_id,engine_id,created_ms) DO UPDATE SET
            app_key=excluded.app_key, hostname=COALESCE(excluded.hostname,flow_records.hostname),
            pid=COALESCE(excluded.pid,flow_records.pid)
            WHERE app_key != excluded.app_key OR hostname IS NOT COALESCE(excluded.hostname,hostname)
                OR pid IS NOT COALESCE(excluded.pid,pid)")?
            .execute(params![session,flow.id,created,key,flow.local.as_ref().map(|p| &p.ip),
                flow.local.as_ref().map(|p| p.port),flow.remote.ip,flow.remote.port,flow.protocol,
                hostname,flow.process.as_ref().and_then(|p| p.pid),now])?;
        let id: i64 = tx.prepare_cached("SELECT id FROM flow_records WHERE session_id=?1 AND engine_id=?2 AND created_ms=?3")?
            .query_row(params![session,flow.id,created], |r| r.get(0))?;
        let old = tx
            .prepare_cached("SELECT * FROM flow_pending WHERE flow_id=?1")?
            .query_row([id], Pending::read)
            .optional()?;
        let mut next = Pending {
            id,
            time: now,
            sent: flow.traffic.bytes_sent,
            received: flow.traffic.bytes_received,
            packets_sent: flow.traffic.packets_sent,
            packets_received: flow.traffic.packets_received,
            segment: old.as_ref().map_or(0, |p| p.segment),
            sampled: now,
            closed: flow.historic,
        };
        if let Some(old) = old {
            let reset = next.sent < old.sent
                || next.received < old.received
                || next
                    .packets_sent
                    .zip(old.packets_sent)
                    .is_some_and(|(n, p)| n < p)
                || next
                    .packets_received
                    .zip(old.packets_received)
                    .is_some_and(|(n, p)| n < p);
            let changed = next.sent != old.sent
                || next.received != old.received
                || next.packets_sent != old.packets_sent
                || next.packets_received != old.packets_received;
            let gap = !continuous || Some(old.time) != previous;
            // Retained historical connections are not sampled repeatedly.
            if old.closed && flow.historic && !changed {
                continue;
            }
            if gap || reset || old.closed {
                old.sample(tx, "boundary")?;
                next.segment += 1;
                next.sample(tx, if reset { "reset" } else { "gap" })?;
            } else if now - old.sampled >= STEP || flow.historic {
                next.sample(tx, if flow.historic { "final" } else { "periodic" })?;
            } else {
                next.sampled = old.sampled;
            }
        } else {
            // A newly created short flow has a known zero origin only during continuous capture.
            if continuous && !incomplete && previous.is_some_and(|p| created >= p) && created < now
            {
                let origin = Pending {
                    id,
                    time: created,
                    sent: 0,
                    received: 0,
                    packets_sent: next.packets_sent.map(|_| 0),
                    packets_received: next.packets_received.map(|_| 0),
                    segment: 0,
                    sampled: created,
                    closed: false,
                };
                origin.sample(tx, "origin")?;
            }
            next.sample(tx, if flow.historic { "final" } else { "first" })?;
        }
        tx.prepare_cached("INSERT INTO flow_pending VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
            ON CONFLICT(flow_id) DO UPDATE SET observed_ms=excluded.observed_ms,sent=excluded.sent,
            received=excluded.received,packets_sent=excluded.packets_sent,packets_received=excluded.packets_received,
            segment=excluded.segment,sampled_ms=excluded.sampled_ms,sequence=excluded.sequence,closed=excluded.closed")?
            .execute(params![id,now,next.sent,next.received,next.packets_sent,next.packets_received,next.segment,next.sampled,sequence,flow.historic])?;
        if flow.historic {
            tx.prepare_cached(
                "UPDATE flow_records SET ended_ms=?2,end_reason='closed' WHERE id=?1",
            )?
            .execute(params![
                id,
                flow.closed_at
                    .as_ref()
                    .map_or(now, |d| d.timestamp_millis())
            ])?;
        } else {
            tx.prepare_cached("UPDATE flow_records SET ended_ms=NULL,end_reason=NULL WHERE id=?1 AND end_reason IS NOT NULL")?.execute([id])?;
        }
    }
    let missing = tx
        .prepare("SELECT * FROM flow_pending WHERE sequence != ?1 AND closed=0")?
        .query_map([sequence], Pending::read)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for p in missing {
        p.sample(tx, "last-seen")?;
        tx.execute("UPDATE flow_pending SET closed=1 WHERE flow_id=?1", [p.id])?;
        tx.execute(
            "UPDATE flow_records SET end_reason='disappeared' WHERE id=?1",
            [p.id],
        )?;
    }
    // Coverage is independent of individual flows and distinguishes silence from missing capture.
    let mut start = previous.filter(|_| continuous).unwrap_or(now);
    loop {
        let bucket = start / STEP * STEP;
        let end = now.min(bucket + STEP);
        tx.prepare_cached("INSERT INTO capture_intervals VALUES (?1,?2,?3,?4)
            ON CONFLICT(session_id,bucket_ms) DO UPDATE SET observed_ms=observed_ms+excluded.observed_ms,
            incomplete=MAX(incomplete,excluded.incomplete)")?
            .execute(params![session,bucket,end-start,incomplete])?;
        if end >= now {
            break;
        }
        start = end;
    }
    Ok(())
}

pub(crate) fn finish(tx: &Transaction<'_>) -> Result<()> {
    let pending = tx
        .prepare("SELECT * FROM flow_pending WHERE closed=0")?
        .query_map([], Pending::read)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for p in pending {
        p.sample(tx, "capture-ended")?;
        tx.execute(
            "UPDATE flow_records SET end_reason='capture-ended' WHERE id=?1",
            [p.id],
        )?;
        tx.execute("UPDATE flow_pending SET closed=1 WHERE flow_id=?1", [p.id])?;
    }
    Ok(())
}
