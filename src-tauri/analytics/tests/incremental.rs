use chrono::{DateTime, Utc};
use rusqlite::Connection;
use rustnet_analytics::{HistoryQuery, SeriesCache, SeriesReport, Store, read_series};
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
fn cursor(r: &SeriesReport) -> Option<u64> {
    r.refresh.as_ref().and_then(|r| r.cursor)
}
fn equal(
    actual: &SeriesReport,
    path: &std::path::Path,
    q: &HistoryQuery,
    id: Option<i64>,
    now: i64,
) {
    let expected = read_series(path, q, id, now).unwrap();
    let mut actual = serde_json::to_value(actual).unwrap();
    actual.as_object_mut().unwrap().remove("refresh");
    assert_eq!(actual, serde_json::to_value(expected).unwrap());
}
#[test]
fn incremental_refresh_matches_full_reads_and_reads_only_the_changed_tail() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let mut store = Store::open(&path, "en0", START).unwrap();
    let mut cache = SeriesCache::default();
    let mut token = None;
    for i in 0..=430 {
        let sent = i * 1000 + if i >= 405 { 30_000_000 } else { 0 };
        ingest(
            &mut store,
            i as u64 + 1,
            i * 5000,
            vec![flow("one", -1000, i * 5000, sent, false)],
        );
        if i < 400 || i % 6 != 0 {
            continue;
        }
        let q = query((i * 5000 - 2_000_000).max(0), i * 5000 + 1);
        let r = cache.read(&path, &q, None, token, q.to_ms).unwrap();
        equal(&r, &path, &q, None, q.to_ms);
        if token.is_some() {
            assert!(r.refresh.as_ref().unwrap().incremental);
            assert!(r.refresh.as_ref().unwrap().samples_read < 10);
        }
        token = cursor(&r);
    }
    let q = query(140000, 2150001);
    let r = cache.read(&path, &q, None, token, q.to_ms).unwrap();
    equal(&r, &path, &q, None, q.to_ms);
    let again = cache.read(&path, &q, None, cursor(&r), q.to_ms).unwrap();
    assert_eq!(again.refresh.as_ref().unwrap().samples_read, 0);
    equal(&again, &path, &q, None, q.to_ms);
}
#[test]
fn corrections_late_writes_and_same_timestamp_final_samples_replace_cached_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let mut store = Store::open(&path, "en0", START).unwrap();
    for i in 0..=30 {
        ingest(
            &mut store,
            i as u64 + 1,
            i * 1000,
            vec![flow("one", -1000, i * 1000, i * 100, false)],
        );
    }
    let mut cache = SeriesCache::default();
    let q = query(0, 31000);
    let first = cache.read(&path, &q, None, None, q.to_ms).unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute(
        "UPDATE flow_samples SET bytes_sent=900 WHERE timestamp_ms=?1",
        [START + 10000],
    )
    .unwrap();
    db.execute("INSERT INTO flow_samples SELECT flow_id,?1,segment,1500,3000,150,300,'boundary' FROM flow_samples LIMIT 1",[START+15000]).unwrap();
    db.execute(
        "UPDATE capture_intervals SET incomplete=1 WHERE bucket_ms=?1",
        [START + 10000],
    )
    .unwrap();
    let second = cache
        .read(&path, &q, None, cursor(&first), q.to_ms)
        .unwrap();
    assert!(second.refresh.as_ref().unwrap().incremental);
    equal(&second, &path, &q, None, q.to_ms);
    store.finish(0, None).unwrap();
    let third = cache
        .read(&path, &q, None, cursor(&second), q.to_ms)
        .unwrap();
    equal(&third, &path, &q, None, q.to_ms);
    let selected = cache
        .read(&path, &q, Some(1), cursor(&third), q.to_ms)
        .unwrap();
    equal(&selected, &path, &q, Some(1), q.to_ms);
    let selected = cache
        .read(&path, &q, Some(1), cursor(&selected), q.to_ms)
        .unwrap();
    assert_eq!(selected.refresh.as_ref().unwrap().samples_read, 0);
}
#[test]
fn metadata_deletion_stale_cursors_and_expired_journals_rebuild_safely() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let mut store = Store::open(&path, "en0", START).unwrap();
    for i in 0..=20 {
        ingest(
            &mut store,
            i as u64 + 1,
            i * 1000,
            vec![flow("one", -1000, i * 1000, i * 100, false)],
        );
    }
    let db = Connection::open(&path).unwrap();
    let q = query(0, 21000);
    let mut cache = SeriesCache::default();
    let mut r = cache.read(&path, &q, None, None, q.to_ms).unwrap();
    for sql in [
        "UPDATE flow_records SET hostname='new.example'",
        "DELETE FROM flow_samples WHERE timestamp_ms=(SELECT MIN(timestamp_ms) FROM flow_samples)",
        "UPDATE history_clock SET revision=revision+100001",
        "UPDATE sessions SET capture_error='lost capture'",
        "UPDATE applications SET name='Renamed'",
    ] {
        db.execute(sql, []).unwrap();
        r = cache.read(&path, &q, None, cursor(&r), q.to_ms).unwrap();
        assert!(!r.refresh.as_ref().unwrap().incremental);
        equal(&r, &path, &q, None, q.to_ms);
    }
    r = cache.read(&path, &q, None, Some(999999), q.to_ms).unwrap();
    assert!(!r.refresh.as_ref().unwrap().incremental);
    let mut paged = q.clone();
    paged.offset = 50;
    let p = cache
        .read(&path, &paged, None, cursor(&r), q.to_ms)
        .unwrap();
    equal(&p, &path, &paged, None, q.to_ms);
    assert_eq!(p.refresh.as_ref().unwrap().samples_read, 0);
}
#[test]
fn legacy_database_is_read_without_migration_until_capture_starts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(include_str!("../src/schema.sql")).unwrap();
    db.execute_batch(include_str!("../src/series.sql")).unwrap();
    let q = query(0, 10000);
    let mut cache = SeriesCache::default();
    assert!(
        cache
            .read(&path, &q, None, None, q.to_ms)
            .unwrap()
            .refresh
            .is_none()
    );
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    let _store = Store::open(&path, "en0", START).unwrap();
    assert!(
        cache
            .read(&path, &q, None, None, q.to_ms)
            .unwrap()
            .refresh
            .is_some()
    );
}

#[test]
fn grouped_counts_filters_pagination_and_counter_boundaries_match_full_queries() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let mut store = Store::open(&path, "en0", START).unwrap();
    let mut cache = SeriesCache::default();
    let q = query(0, 20001);
    for i in 0..=20 {
        let flows = (0..55)
            .map(|id| {
                let sent = if id == 3 && i >= 15 {
                    i * 10
                } else {
                    (id + 1) * i * 100
                };
                let mut f = flow(&id.to_string(), -1000, i * 1000, sent, false);
                if id % 2 == 0 {
                    f["process"]["executable"] = json!("/apps/other");
                }
                f
            })
            .collect();
        ingest(&mut store, i as u64 + 1, i * 1000, flows);
    }
    let first = cache.read(&path, &q, None, None, q.to_ms).unwrap();
    equal(&first, &path, &q, None, q.to_ms);
    let mut next = flow("0", -1000, 30000, 4000, false);
    next["process"]["executable"] = json!("/apps/other");
    ingest(&mut store, 22, 30000, vec![next]);
    let mut q = query(9500, 30001);
    let mut r = cache
        .read(&path, &q, None, cursor(&first), q.to_ms)
        .unwrap();
    assert!(r.refresh.as_ref().unwrap().incremental);
    equal(&r, &path, &q, None, q.to_ms);
    q.offset = 50;
    r = cache.read(&path, &q, None, cursor(&r), q.to_ms).unwrap();
    equal(&r, &path, &q, None, q.to_ms);
    q.offset = 0;
    q.app_key = Some(serde_json::to_string(&["executable", "/apps/other"]).unwrap());
    r = cache.read(&path, &q, None, cursor(&r), q.to_ms).unwrap();
    assert!(!r.refresh.as_ref().unwrap().incremental);
    equal(&r, &path, &q, None, q.to_ms);
    q.interface = Some("missing-interface".into());
    r = cache.read(&path, &q, None, cursor(&r), q.to_ms).unwrap();
    equal(&r, &path, &q, None, q.to_ms);
}
