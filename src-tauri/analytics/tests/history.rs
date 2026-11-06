use chrono::{DateTime, Utc};
use rusqlite::Connection;
use rustnet_analytics::Store;
use serde_json::{Value, json};

const START: i64 = 1_800_000_000_000;

fn timestamp(offset: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(START + offset)
        .unwrap()
        .to_rfc3339()
}

fn flow(id: &str, created: i64, activity: i64, sent: i64) -> Value {
    json!({
        "id": id, "created_at": timestamp(created), "last_activity": timestamp(activity),
        "process": {"name": "Browser", "executable": "/apps/browser", "pid": 123},
        "hostname": "Example.COM.", "remote": {"ip": "203.0.113.1", "port": 443},
        "protocol": "TCP", "traffic": {"bytes_sent": sent, "bytes_received": sent * 2},
        "historic": false
    })
}

fn snapshot(time: i64, flows: Vec<Value>) -> Value {
    json!({
        "schema_version": 1, "type": "snapshot", "timestamp": timestamp(time),
        "runtime": {"status": "running", "process_detection": {"degraded": false}},
        "stats": {"packets_dropped": 0, "capture_packets_dropped": 0, "interface_packets_dropped": 0},
        "connections": flows
    })
}

fn ingest(store: &mut Store, seq: u64, time: i64, flows: Vec<Value>) {
    store
        .ingest(&snapshot(time, flows).to_string(), seq)
        .unwrap();
}

fn scalar(db: &Connection, sql: &str) -> i64 {
    db.query_row(sql, [], |r| r.get(0)).unwrap()
}

#[test]
fn counts_deltas_and_closed_flows_once_even_after_disappearance() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let mut store = Store::open(&path, "en0", START).unwrap();
    ingest(&mut store, 1, 0, vec![flow("old", -1000, 0, 100)]);
    let mut closed = flow("short", 500, 900, 30);
    closed["historic"] = json!(true);
    ingest(
        &mut store,
        2,
        1000,
        vec![flow("old", -1000, 1000, 150), closed.clone()],
    );
    // Duplicate sequence, then a repeated historical record in a fresh snapshot.
    ingest(
        &mut store,
        2,
        1000,
        vec![flow("old", -1000, 1000, 150), closed.clone()],
    );
    ingest(
        &mut store,
        3,
        2000,
        vec![flow("old", -1000, 1000, 150), closed.clone()],
    );
    ingest(&mut store, 4, 3000, vec![]);
    ingest(&mut store, 5, 4000, vec![closed]);
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        scalar(&db, "SELECT SUM(bytes_sent) FROM traffic_buckets"),
        80
    );
    assert_eq!(
        scalar(&db, "SELECT SUM(bytes_received) FROM traffic_buckets"),
        160
    );
    assert_eq!(
        scalar(&db, "SELECT SUM(connections) FROM traffic_buckets"),
        1
    );
    assert_eq!(scalar(&db, "SELECT SUM(connections) FROM destinations"), 2);
    assert_eq!(
        scalar(&db, "SELECT SUM(snapshots) FROM observation_buckets"),
        5
    );
    assert_eq!(
        scalar(&db, "SELECT last_seen_ms FROM destinations"),
        START + 1000
    );
    let host: String = db
        .query_row("SELECT value FROM destinations", [], |r| r.get(0))
        .unwrap();
    assert_eq!(host, "example.com");
    store.finish(0, None).unwrap();
    assert_eq!(scalar(&db, "SELECT ended_ms FROM sessions"), START + 4000);
}

#[test]
fn skipped_frames_sleep_and_counter_resets_do_not_create_spikes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let mut store = Store::open(&path, "en0", START).unwrap();
    ingest(&mut store, 1, 0, vec![flow("a", 0, 0, 100)]);
    ingest(&mut store, 3, 2000, vec![flow("a", 0, 2000, 900)]);
    ingest(&mut store, 4, 3000, vec![flow("a", 0, 3000, 910)]);
    ingest(&mut store, 5, 60_000, vec![flow("a", 0, 60_000, 10000)]);
    ingest(&mut store, 6, 61_000, vec![flow("a", 0, 61_000, 10)]);
    ingest(&mut store, 7, 62_000, vec![flow("a", 0, 62_000, 30)]);
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        scalar(&db, "SELECT SUM(bytes_sent) FROM traffic_buckets"),
        30
    );
    assert_eq!(
        scalar(&db, "SELECT SUM(observed_ms) FROM observation_buckets"),
        3000
    );
    assert_eq!(
        scalar(&db, "SELECT MIN(incomplete) FROM observation_buckets"),
        1
    );
    store.finish(1, Some("Final snapshot missing")).unwrap();
    assert_eq!(scalar(&db, "SELECT dropped_snapshots FROM sessions"), 1);
}

#[test]
fn sessions_survive_reopening_and_reused_connection_ids_are_independent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    for offset in [0, 60_000] {
        let mut store = Store::open(&path, "en0", START + offset).unwrap();
        ingest(&mut store, 1, offset, vec![]);
        ingest(
            &mut store,
            2,
            offset + 1000,
            vec![flow("a", offset + 500, offset + 1000, 25)],
        );
        store.finish(0, None).unwrap();
    }
    let db = Connection::open(&path).unwrap();
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM sessions"), 2);
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM applications"), 1);
    assert_eq!(
        scalar(&db, "SELECT SUM(bytes_sent) FROM traffic_buckets"),
        50
    );
    assert_eq!(scalar(&db, "SELECT connections FROM destinations"), 2);
}

#[test]
fn late_metadata_only_attributes_future_bytes_and_preserves_distinct_executables() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let mut store = Store::open(&path, "en0", START).unwrap();
    let mut unknown = flow("a", 0, 0, 10);
    unknown["process"] = Value::Null;
    unknown["hostname"] = Value::Null;
    ingest(&mut store, 1, 0, vec![unknown.clone()]);
    unknown["traffic"]["bytes_sent"] = json!(30);
    unknown["last_activity"] = json!(timestamp(1000));
    ingest(&mut store, 2, 1000, vec![unknown]);
    ingest(&mut store, 3, 2000, vec![flow("a", 0, 2000, 50)]);
    let mut other = flow("b", 2500, 3000, 15);
    other["process"]["executable"] = json!("/other/browser");
    ingest(&mut store, 4, 3000, vec![other]);
    let db = Connection::open(&path).unwrap();
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM applications"), 3);
    assert_eq!(
        scalar(&db, "SELECT SUM(bytes_sent) FROM traffic_buckets"),
        55
    );
    assert_eq!(
        scalar(&db, "SELECT COUNT(*) FROM destinations WHERE kind = 'ip'"),
        1
    );
}

#[test]
fn invalid_frames_roll_back_and_can_be_retried() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let mut store = Store::open(&path, "en0", START).unwrap();
    ingest(&mut store, 1, 0, vec![]);
    let good = flow("a", 500, 1000, 10);
    let mut bad = flow("b", 500, 1000, 20);
    bad["hostname"] = Value::Null;
    bad["remote"]["ip"] = json!("not an address");
    assert!(
        store
            .ingest(&snapshot(1000, vec![good.clone(), bad]).to_string(), 2)
            .is_err()
    );
    let db = Connection::open(&path).unwrap();
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM traffic_buckets"), 0);
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM applications"), 0);
    assert!(
        store
            .ingest(
                &snapshot(1000, vec![good.clone(), good.clone()]).to_string(),
                2
            )
            .is_err()
    );
    ingest(&mut store, 2, 1000, vec![good]);
    assert_eq!(
        scalar(&db, "SELECT SUM(bytes_sent) FROM traffic_buckets"),
        10
    );
}

#[test]
fn coverage_splits_minutes_and_marks_packet_loss() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let mut store = Store::open(&path, "en0", START).unwrap();
    ingest(&mut store, 1, 59_000, vec![]);
    ingest(&mut store, 2, 61_000, vec![]);
    let mut loss = snapshot(62_000, vec![]);
    loss["stats"]["capture_packets_dropped"] = json!(1);
    store.ingest(&loss.to_string(), 3).unwrap();
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        scalar(&db, "SELECT MIN(observed_ms) FROM observation_buckets"),
        1000
    );
    assert_eq!(
        scalar(&db, "SELECT MAX(observed_ms) FROM observation_buckets"),
        2000
    );
    assert_eq!(
        scalar(&db, "SELECT MIN(incomplete) FROM observation_buckets"),
        1
    );
}

#[test]
fn retention_removes_old_history_and_inventory_when_opened_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    {
        let mut store = Store::open(&path, "en0", START).unwrap();
        ingest(&mut store, 1, 0, vec![]);
        ingest(&mut store, 2, 1000, vec![flow("a", 500, 1000, 10)]);
        store.finish(0, None).unwrap();
    }
    let _store = Store::open(&path, "en0", START + 31 * 86_400_000).unwrap();
    let db = Connection::open(&path).unwrap();
    for table in [
        "traffic_buckets",
        "observation_buckets",
        "applications",
        "destinations",
    ] {
        assert_eq!(scalar(&db, &format!("SELECT COUNT(*) FROM {table}")), 0);
    }
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM sessions"), 1);
}

#[test]
fn unknown_database_versions_are_rejected_without_overwriting_them() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let db = Connection::open(&path).unwrap();
    db.pragma_update(None, "user_version", 99).unwrap();
    assert!(Store::open(&path, "en0", START).is_err());
    assert_eq!(scalar(&db, "PRAGMA user_version"), 99);
}

#[test]
fn out_of_order_frames_and_capture_errors_remain_distinguishable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let mut store = Store::open(&path, "en0", START).unwrap();
    ingest(&mut store, 1, 1000, vec![]);
    assert!(!store.ingest(&snapshot(0, vec![]).to_string(), 2).unwrap());
    let mut terminal = snapshot(2000, vec![]);
    terminal["runtime"]["status"] = json!("stopped");
    terminal["runtime"]["capture_error"] = json!("Capture lost interface");
    store.ingest(&terminal.to_string(), 3).unwrap();
    store.finish(0, None).unwrap();
    let db = Connection::open(&path).unwrap();
    let (status, error): (String, String) = db
        .query_row(
            "SELECT runtime_status, capture_error FROM sessions",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "stopped");
    assert_eq!(error, "Capture lost interface");
    assert_eq!(
        scalar(&db, "SELECT SUM(snapshots) FROM observation_buckets"),
        2
    );
    assert_eq!(
        scalar(&db, "SELECT SUM(observed_ms) FROM observation_buckets"),
        0
    );
}

#[test]
#[ignore = "manual ingestion benchmark; run with --ignored --nocapture"]
fn benchmark_retained_connections() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("history.db"), "en0", START).unwrap();
    let flows: Vec<_> = (0..10_000)
        .map(|i| flow(&i.to_string(), -1000, 0, 100))
        .collect();
    ingest(&mut store, 1, 0, flows.clone());
    let frames: Vec<_> = (1..=10)
        .map(|i| snapshot(i * 500, flows.clone()).to_string())
        .collect();
    let start = std::time::Instant::now();
    for (i, frame) in frames.iter().enumerate() {
        store.ingest(frame, i as u64 + 2).unwrap();
    }
    eprintln!(
        "10 snapshots of 10,000 unchanged retained connections: {:?}",
        start.elapsed()
    );
    store.finish(0, None).unwrap();
}
