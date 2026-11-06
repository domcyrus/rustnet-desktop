use rusqlite::{Connection, params};
use rustnet_analytics::{HistoryQuery, Store, read_history};
use std::path::Path;

const START: i64 = 1_800_000_000_000;
const MINUTE: i64 = 60_000;

fn setup(path: &Path) -> Connection {
    drop(Store::open(path, "en0", START).unwrap());
    let db = Connection::open(path).unwrap();
    db.execute("UPDATE sessions SET runtime_status = 'running'", [])
        .unwrap();
    for (key, name, executable) in [
        ("app", "Browser", Some("/apps/browser")),
        ("other", "Browser", Some("/other/browser")),
        ("weak", "Unknown", None),
    ] {
        db.execute(
            "INSERT INTO applications VALUES (?1,?2,?3)",
            params![key, name, executable],
        )
        .unwrap();
    }
    db
}

fn minute(db: &Connection, session: i64, app: &str, index: i64, upload: i64, connections: i64) {
    let time = START + index * MINUTE;
    db.execute(
        "INSERT OR IGNORE INTO observation_buckets VALUES (?1,?2,60000,120,0)",
        params![session, time],
    )
    .unwrap();
    db.execute(
        "INSERT INTO traffic_buckets VALUES (?1,?2,?3,'known.example','TCP',443,?4,20,?5)",
        params![session, time, app, upload, connections],
    )
    .unwrap();
    db.execute("INSERT INTO destinations VALUES (?1,'known.example','hostname','known.example','203.0.113.1',?2,?3,1)
        ON CONFLICT(app_key,key) DO UPDATE SET last_seen_ms = excluded.last_seen_ms", params![app,START,time]).unwrap();
    db.execute(
        "UPDATE sessions SET last_seen_ms = MAX(last_seen_ms,?1) WHERE id = ?2",
        params![time + MINUTE, session],
    )
    .unwrap();
}

fn query(start: i64, end: i64) -> HistoryQuery {
    HistoryQuery {
        from_ms: START + start * MINUTE,
        to_ms: START + end * MINUTE,
        app_key: None,
        interface: None,
        offset: 0,
    }
}

#[test]
fn absent_history_is_not_created_and_invalid_queries_fail() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing.db");
    assert!(
        !read_history(&path, &query(0, 1), START + MINUTE)
            .unwrap()
            .exists
    );
    assert!(!path.exists());
    assert!(read_history(&path, &query(1, 0), START + MINUTE).is_err());
    assert!(read_history(&path, &query(0, 2), START + MINUTE).is_err());
    assert!(
        read_history(
            &path,
            &query(0, 31 * 24 * 60),
            START + 31 * 24 * 60 * MINUTE
        )
        .is_err()
    );
}

#[test]
fn reports_totals_filters_and_stable_pages_without_mutating_history() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let db = setup(&path);
    minute(&db, 1, "app", 0, 10, 1);
    minute(&db, 1, "other", 0, 500, 1);
    for port in 1..=54 {
        db.execute(
            "INSERT INTO traffic_buckets VALUES (1,?1,'app','known.example','TCP',?2,10,20,1)",
            params![START, port],
        )
        .unwrap();
    }
    let mut request = query(0, 1);
    request.app_key = Some("app".into());
    let first = read_history(&path, &request, request.to_ms).unwrap();
    assert_eq!(first.row_count, 55);
    assert_eq!(first.rows.len(), 50);
    assert_eq!(first.totals.bytes_sent, 550);
    assert_eq!(first.totals.observed_ms, 60000); // Coverage is not multiplied by destination rows.
    request.offset = 50;
    let last = read_history(&path, &request, request.to_ms).unwrap();
    assert_eq!(last.rows.len(), 5);
    assert!(
        last.rows
            .iter()
            .all(|r| !first.rows.iter().any(|f| r.port == f.port))
    );
    request.interface = Some("not-an-interface".into());
    assert_eq!(
        read_history(&path, &request, request.to_ms)
            .unwrap()
            .row_count,
        0
    );
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn findings_use_only_earlier_minutes_and_group_repeated_bursts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let db = setup(&path);
    for i in 0..30 {
        minute(&db, 1, "app", i, 1024, 2);
    }
    minute(&db, 1, "app", 30, 20 * 1024 * 1024, 250);
    let request = query(30, 31);
    let report = read_history(&path, &request, request.to_ms).unwrap();
    assert_eq!(report.analysis.findings.len(), 2);
    let upload = report
        .analysis
        .findings
        .iter()
        .find(|f| f.kind == "upload")
        .unwrap();
    assert_eq!(upload.baseline, 1024.0);
    assert_eq!(upload.prior_minutes, 30);
    minute(&db, 1, "app", 31, 40 * 1024 * 1024, 300);
    let request = query(30, 32);
    let report = read_history(&path, &request, request.to_ms).unwrap();
    assert_eq!(report.analysis.findings.len(), 2);
    let upload = report
        .analysis
        .findings
        .iter()
        .find(|f| f.kind == "upload")
        .unwrap();
    assert_eq!(upload.first_ms, START + 30 * MINUTE);
    assert_eq!(upload.last_ms, START + 31 * MINUTE);
    assert_eq!(upload.baseline, 1024.0);
    assert_eq!(upload.prior_minutes, 30); // The previous burst did not train its own baseline.
    let request = query(0, 30);
    assert!(
        read_history(&path, &request, START + 32 * MINUTE)
            .unwrap()
            .analysis
            .findings
            .is_empty()
    );
}

#[test]
fn partial_minutes_and_bad_sessions_are_browsable_but_not_detection_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let db = setup(&path);
    for i in 0..30 {
        minute(&db, 1, "app", i, 100, 1);
    }
    minute(&db, 1, "app", 30, 20 * 1024 * 1024, 250);
    let request = query(0, 31);
    for column in ["incomplete = 1", "observed_ms = 59000"] {
        db.execute(
            "UPDATE observation_buckets SET incomplete = 0, observed_ms = 60000",
            [],
        )
        .unwrap();
        db.execute(
            &format!("UPDATE observation_buckets SET {column} WHERE minute_ms = ?1"),
            [START],
        )
        .unwrap();
        let report = read_history(&path, &request, request.to_ms).unwrap();
        assert!(report.analysis.findings.is_empty());
        assert!(report.totals.bytes_sent > 20 * 1024 * 1024);
    }
    db.execute(
        "UPDATE observation_buckets SET incomplete = 0, observed_ms = 60000",
        [],
    )
    .unwrap();
    assert!(
        !read_history(&path, &request, request.to_ms)
            .unwrap()
            .analysis
            .findings
            .is_empty()
    );
    for column in [
        "error = 'writer failed'",
        "capture_error = 'capture failed'",
        "dropped_snapshots = 1",
    ] {
        db.execute(
            "UPDATE sessions SET error = NULL, capture_error = NULL, dropped_snapshots = 0",
            [],
        )
        .unwrap();
        db.execute(&format!("UPDATE sessions SET {column}"), [])
            .unwrap();
        assert!(
            read_history(&path, &request, request.to_ms)
                .unwrap()
                .analysis
                .findings
                .is_empty()
        );
    }
}

#[test]
fn learning_is_scoped_to_executable_and_interface_and_needs_thirty_prior_minutes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let db = setup(&path);
    db.execute(
        "INSERT INTO sessions(id,started_ms,last_seen_ms,interface) VALUES (2,?1,?1,'en1')",
        [START],
    )
    .unwrap();
    for i in 0..30 {
        minute(&db, 1, "app", i, 100, 1);
        minute(&db, 1, "weak", i, 100, 1);
    }
    minute(&db, 1, "other", 30, 20 * 1024 * 1024, 250);
    minute(&db, 2, "app", 30, 20 * 1024 * 1024, 250);
    minute(&db, 1, "weak", 30, 20 * 1024 * 1024, 250);
    let request = query(0, 31);
    let report = read_history(&path, &request, request.to_ms).unwrap();
    assert!(report.analysis.findings.is_empty());
    assert_eq!(report.analysis.ready_profiles, 1);
    assert_eq!(report.analysis.learning_profiles, 2);
}

#[test]
fn new_destinations_need_prior_activity_and_current_minutes_are_excluded() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let db = setup(&path);
    for i in 0..31 {
        minute(&db, 1, "app", i, 100, 1);
    }
    db.execute(
        "UPDATE traffic_buckets SET destination_key = 'new.example' WHERE minute_ms = ?1",
        [START + 30 * MINUTE],
    )
    .unwrap();
    db.execute("INSERT INTO destinations VALUES ('app','new.example','hostname','new.example','203.0.113.2',?1,?1,1)",[START+30*MINUTE]).unwrap();
    let mut request = query(0, 31);
    let report = read_history(&path, &request, request.to_ms).unwrap();
    assert_eq!(report.analysis.findings.len(), 1);
    assert_eq!(report.analysis.findings[0].kind, "destination");
    assert_eq!(
        report.analysis.findings[0].destination.as_deref(),
        Some("new.example")
    );
    request.to_ms -= 1;
    assert!(
        read_history(&path, &request, request.to_ms)
            .unwrap()
            .analysis
            .findings
            .is_empty()
    );
}

#[test]
fn zero_baselines_have_an_absolute_floor_and_overlaps_do_not_train_twice() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let db = setup(&path);
    for i in 0..30 {
        minute(&db, 1, "app", i, 0, 0);
    }
    minute(&db, 1, "app", 30, 10 * 1024 * 1024, 100);
    let request = query(0, 31);
    assert!(
        read_history(&path, &request, request.to_ms)
            .unwrap()
            .analysis
            .findings
            .is_empty()
    );
    db.execute(
        "UPDATE traffic_buckets SET bytes_sent = 20*1024*1024 WHERE minute_ms = ?1",
        [START + 30 * MINUTE],
    )
    .unwrap();
    assert_eq!(
        read_history(&path, &request, request.to_ms)
            .unwrap()
            .analysis
            .findings
            .len(),
        1
    );
    db.execute(
        "INSERT INTO sessions(id,started_ms,last_seen_ms,interface) VALUES (2,?1,?1,'en0')",
        [START],
    )
    .unwrap();
    minute(&db, 2, "app", 0, 0, 0);
    assert!(
        read_history(&path, &request, request.to_ms)
            .unwrap()
            .analysis
            .findings
            .is_empty()
    );
}
