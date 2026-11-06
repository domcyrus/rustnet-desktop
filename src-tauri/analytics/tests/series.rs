use chrono::{DateTime, Utc};
use rusqlite::Connection;
use rustnet_analytics::{HistoryQuery, Store, read_history, read_series};
use serde_json::{Value, json};
const START: i64 = 1_800_000_000_000;
fn stamp(t: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(START + t)
        .unwrap()
        .to_rfc3339()
}
fn flow(id: &str, created: i64, time: i64, sent: i64, closed: bool) -> Value {
    json!({"id":id,"created_at":stamp(created),"last_activity":stamp(time),"historic":closed,
        "process":{"name":"Browser","executable":"/apps/browser","pid":42},
        "local":{"ip":"192.0.2.1","port":1234},"remote":{"ip":"203.0.113.1","port":443},
        "hostname":null,"protocol":"TCP","traffic":{"bytes_sent":sent,"bytes_received":sent*2,"packets_sent":sent/10,"packets_received":sent/5}})
}
fn ingest(store: &mut Store, seq: u64, time: i64, flows: Vec<Value>) {
    store.ingest(&json!({"schema_version":1,"type":"snapshot","timestamp":stamp(time),
        "runtime":{"status":"running","process_detection":{"degraded":false}},
        "stats":{"packets_dropped":0,"capture_packets_dropped":0,"interface_packets_dropped":0},"connections":flows}).to_string(),seq).unwrap();
}
fn query(from: i64, to: i64) -> HistoryQuery {
    HistoryQuery {
        from_ms: START + from,
        to_ms: START + to,
        app_key: None,
        interface: None,
        offset: 0,
    }
}
fn scalar(db: &Connection, sql: &str) -> i64 {
    db.query_row(sql, [], |r| r.get(0)).unwrap()
}

#[test]
fn stores_ten_second_counters_first_final_and_metadata_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let mut store = Store::open(&path, "en0", START).unwrap();
    for i in 0..=25 {
        let mut f = flow("one", -1000, i * 1000, 100 + i * 10, i == 25);
        if i >= 12 {
            f["hostname"] = json!("Example.COM.");
        }
        ingest(&mut store, i as u64 + 1, i * 1000, vec![f]);
    }
    ingest(
        &mut store,
        27,
        26000,
        vec![flow("one", -1000, 25000, 350, true)],
    );
    store.finish(0, None).unwrap();
    let db = Connection::open(&path).unwrap();
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM flow_records"), 1);
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM flow_samples"), 4);
    assert_eq!(
        scalar(
            &db,
            "SELECT MAX(timestamp_ms)-MIN(timestamp_ms) FROM flow_samples"
        ),
        25000
    );
    let report = read_series(&path, &query(0, 30000), None, START + 30000).unwrap();
    assert_eq!(report.bytes_sent, 250);
    assert_eq!(report.bytes_received, 500);
    assert_eq!(
        report.connections[0].hostname.as_deref(),
        Some("example.com")
    );
    assert_eq!(report.connections[0].local_port, Some(1234));
    let detail = read_series(
        &path,
        &query(10000, 26000),
        Some(report.connections[0].id),
        START + 30000,
    )
    .unwrap();
    assert_eq!(detail.samples.len(), 3);
    assert_eq!(detail.samples[0].delta_sent, Some(100));
    assert_eq!(detail.samples[0].packets_sent, Some(20));
    assert_eq!(detail.samples[2].kind, "final");
    assert_eq!(detail.resolution_ms, 10000);
    assert!(detail.points.len() <= 181);
}

#[test]
fn keeps_short_flows_and_flushes_disappearing_and_stopped_connections() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let mut store = Store::open(&path, "en0", START).unwrap();
    ingest(&mut store, 1, 0, vec![]);
    let short = flow("short", 200, 700, 50, true);
    ingest(
        &mut store,
        2,
        1000,
        vec![short.clone(), flow("live", 300, 1000, 20, false)],
    );
    ingest(
        &mut store,
        3,
        2000,
        vec![short.clone(), flow("live", 300, 2000, 40, false)],
    );
    ingest(&mut store, 4, 3000, vec![short.clone()]);
    ingest(
        &mut store,
        5,
        4000,
        vec![short, flow("ending", 3500, 4000, 10, false)],
    );
    ingest(
        &mut store,
        6,
        5000,
        vec![flow("ending", 3500, 5000, 30, false)],
    );
    store.finish(0, None).unwrap();
    let report = read_series(&path, &query(0, 6000), None, START + 6000).unwrap();
    assert_eq!(report.bytes_sent, 120);
    assert_eq!(report.connection_count, 3);
    assert!(
        report
            .connections
            .iter()
            .any(|c| c.end_reason.as_deref() == Some("disappeared"))
    );
    assert!(
        report
            .connections
            .iter()
            .any(|c| c.end_reason.as_deref() == Some("capture-ended"))
    );
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        scalar(&db, "SELECT COUNT(*) FROM flow_samples WHERE flow_id=1"),
        2
    );
}

#[test]
fn gaps_and_resets_break_deltas_and_sessions_do_not_share_flow_ids() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let mut store = Store::open(&path, "en0", START).unwrap();
    ingest(&mut store, 1, 0, vec![flow("a", -1000, 0, 100, false)]);
    ingest(
        &mut store,
        2,
        1000,
        vec![flow("a", -1000, 1000, 120, false)],
    );
    ingest(
        &mut store,
        4,
        3000,
        vec![flow("a", -1000, 3000, 9999, false)],
    );
    ingest(&mut store, 5, 4000, vec![flow("a", -1000, 4000, 10, false)]);
    ingest(&mut store, 6, 5000, vec![flow("a", -1000, 5000, 20, false)]);
    store.finish(1, None).unwrap();
    drop(store);
    let mut second = Store::open(&path, "en1", START + 6000).unwrap();
    ingest(
        &mut second,
        1,
        6000,
        vec![flow("a", -1000, 6000, 500, false)],
    );
    second.finish(0, None).unwrap();
    let report = read_series(&path, &query(0, 7000), None, START + 7000).unwrap();
    assert_eq!(report.bytes_sent, 30);
    assert_eq!(report.connection_count, 2);
    assert!(report.points.iter().any(|p| p.incomplete));
    let detail = read_series(
        &path,
        &query(0, 7000),
        Some(report.connections[0].id),
        START + 7000,
    )
    .unwrap();
    assert!(
        detail
            .samples
            .iter()
            .any(|s| s.kind == "gap" && s.delta_sent.is_none())
    );
    assert!(
        detail
            .samples
            .iter()
            .any(|s| s.kind == "reset" && s.delta_sent.is_none())
    );
    let mut filtered = query(0, 7000);
    filtered.interface = Some("en1".into());
    assert_eq!(
        read_series(&path, &filtered, None, START + 7000)
            .unwrap()
            .connection_count,
        1
    );
    filtered.app_key = Some("missing".into());
    assert_eq!(
        read_series(&path, &filtered, None, START + 7000)
            .unwrap()
            .connection_count,
        0
    );
}

#[test]
fn migrates_legacy_history_without_fabricating_samples_and_rejects_invalid_queries() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(include_str!("../src/schema.sql")).unwrap();
    db.execute(
        "INSERT INTO sessions(id,started_ms,last_seen_ms,interface) VALUES (1,?1,?1,'en0')",
        [START],
    )
    .unwrap();
    assert!(
        !read_series(&path, &query(0, 10000), None, START + 10000)
            .unwrap()
            .available
    );
    drop(Store::open(&path, "en0", START + 1000).unwrap());
    assert_eq!(scalar(&db, "PRAGMA user_version"), 3);
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM sessions"), 2);
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM flow_samples"), 0);
    assert!(
        read_history(&path, &query(0, 10000), START + 10000)
            .unwrap()
            .exists
    );
    assert!(read_series(&path, &query(0, 10000), Some(-1), START + 10000).is_err());
    assert!(read_series(&path, &query(0, 10000), None, START + 100).is_err());
    assert!(read_series(&path, &query(10000, 0), None, START + 10000).is_err());
}

#[test]
fn retained_samples_are_pruned_with_their_connections() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let mut store = Store::open(&path, "en0", START).unwrap();
    ingest(&mut store, 1, 0, vec![flow("old", -1000, 0, 10, true)]);
    store.finish(0, None).unwrap();
    drop(store);
    drop(Store::open(&path, "en0", START + 31 * 86400000).unwrap());
    let db = Connection::open(&path).unwrap();
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM flow_samples"), 0);
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM flow_records"), 0);
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM capture_intervals"), 0);
}
