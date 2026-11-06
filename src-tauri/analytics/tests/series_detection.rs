use rusqlite::{Connection, params};
use rustnet_analytics::{HistoryQuery, Store, read_series};
use std::path::Path;
const START: i64 = 1_800_000_000_000;
const STEP: i64 = 10000;
fn query(from: i64, to: i64) -> HistoryQuery {
    HistoryQuery {
        from_ms: START + from * STEP,
        to_ms: START + to * STEP,
        app_key: None,
        interface: None,
        offset: 0,
    }
}
fn setup(path: &Path) -> Connection {
    drop(Store::open(path, "en0", START).unwrap());
    let db = Connection::open(path).unwrap();
    db.execute(
        "INSERT INTO applications VALUES ('app','Browser','/browser')",
        [],
    )
    .unwrap();
    db.execute("INSERT INTO flow_records(id,session_id,engine_id,created_ms,app_key,remote_ip,remote_port,protocol,hostname,first_seen_ms,last_seen_ms)
        VALUES (1,1,'one',?1,'app','203.0.113.1',443,'TCP','known.test',?1,?2)",params![START,START+184*STEP]).unwrap();
    for i in 0..184 {
        db.execute(
            "INSERT INTO capture_intervals VALUES (1,?1,10000,0)",
            [START + i * STEP],
        )
        .unwrap();
        let sent = i * 1000
            + if i >= 181 {
                4 * 1024 * 1024 * (i - 180).min(2)
            } else {
                0
            };
        let received = i * 2000
            + if i >= 181 {
                20 * 1024 * 1024 * (i - 180).min(2)
            } else {
                0
            };
        db.execute(
            "INSERT INTO flow_samples VALUES (1,?1,0,?2,?3,NULL,NULL,?4)",
            params![
                START + i * STEP,
                sent,
                received,
                if i == 0 { "first" } else { "periodic" }
            ],
        )
        .unwrap();
    }
    db
}
#[test]
fn detects_ten_second_bursts_without_minute_summaries_and_marks_their_bins() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let _db = setup(&path);
    let report = read_series(&path, &query(181, 183), None, START + 184 * STEP).unwrap();
    assert_eq!(report.analysis.findings.len(), 4);
    assert_eq!(report.analysis.ready_profiles, 1);
    for f in &report.analysis.findings {
        assert_eq!(f.prior_intervals, 180);
        assert!(f.observed > f.threshold);
        assert!(f.timestamp_ms >= START + 181 * STEP);
        assert_eq!(f.baseline, if f.kind == "upload" { 1000.0 } else { 2000.0 });
    }
    assert_eq!(report.points.iter().map(|p| p.findings).sum::<usize>(), 4);
    let detail = read_series(&path, &query(181, 183), Some(1), START + 184 * STEP).unwrap();
    assert_eq!(detail.analysis.findings.len(), 4);
    assert_eq!(detail.applications[0].connections, 1);
    assert_eq!(detail.applications[0].bytes_sent, report.bytes_sent);
    let earlier = read_series(&path, &query(0, 180), None, START + 184 * STEP).unwrap();
    assert!(earlier.analysis.findings.is_empty());
    assert_eq!(earlier.analysis.learning_profiles, 1);
}
#[test]
fn partial_reset_unfinished_and_overlapping_intervals_do_not_become_findings() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let db = setup(&path);
    db.execute(
        "UPDATE capture_intervals SET incomplete=1 WHERE bucket_ms=?1",
        [START + 181 * STEP],
    )
    .unwrap();
    db.execute(
        "UPDATE flow_samples SET segment=1,kind='reset' WHERE timestamp_ms>=?1",
        [START + 182 * STEP],
    )
    .unwrap();
    let report = read_series(&path, &query(181, 183), None, START + 184 * STEP).unwrap();
    assert!(report.analysis.findings.is_empty());
    assert!(report.points.iter().any(|p| p.counter_resets > 0));
    db.execute("UPDATE capture_intervals SET incomplete=0", [])
        .unwrap();
    let unfinished = read_series(&path, &query(181, 181 + 1), None, START + 184 * STEP).unwrap();
    assert_eq!(unfinished.analysis.findings.len(), 2);
    let mut partial = query(181, 182);
    partial.to_ms -= 1;
    assert!(
        read_series(&path, &partial, None, START + 184 * STEP)
            .unwrap()
            .analysis
            .findings
            .is_empty()
    );
    db.execute(
        "INSERT INTO sessions(id,started_ms,last_seen_ms,interface) VALUES (2,?1,?2,'en0')",
        params![START, START + 184 * STEP],
    )
    .unwrap();
    db.execute("INSERT INTO flow_records(id,session_id,engine_id,created_ms,app_key,remote_ip,remote_port,protocol,first_seen_ms,last_seen_ms)
        SELECT 2,2,'two',created_ms,app_key,remote_ip,remote_port,protocol,first_seen_ms,last_seen_ms FROM flow_records WHERE id=1",[]).unwrap();
    db.execute("INSERT INTO flow_samples SELECT 2,timestamp_ms,segment,bytes_sent,bytes_received,packets_sent,packets_received,kind FROM flow_samples WHERE flow_id=1",[]).unwrap();
    db.execute("INSERT INTO capture_intervals SELECT 2,bucket_ms,observed_ms,incomplete FROM capture_intervals WHERE session_id=1",[]).unwrap();
    assert!(
        read_series(&path, &query(181, 183), None, START + 184 * STEP)
            .unwrap()
            .analysis
            .findings
            .is_empty()
    );
}
#[test]
fn detects_connection_and_destination_changes_and_scopes_baselines_by_app_and_interface() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let db = setup(&path);
    for i in 2..=26 {
        let time = START + 181 * STEP;
        db.execute("INSERT INTO flow_records(id,session_id,engine_id,created_ms,app_key,remote_ip,remote_port,protocol,hostname,first_seen_ms,last_seen_ms)
            VALUES (?1,1,?2,?3,'app','203.0.113.2',443,'TCP','new.test',?4,?4)",params![i,format!("new{i}"),time-100,time]).unwrap();
        db.execute(
            "INSERT INTO flow_samples VALUES (?1,?2,0,0,0,NULL,NULL,'origin')",
            params![i, time - 100],
        )
        .unwrap();
        db.execute(
            "INSERT INTO flow_samples VALUES (?1,?2,0,10,20,NULL,NULL,'final')",
            params![i, time],
        )
        .unwrap();
    }
    let report = read_series(&path, &query(181, 182), None, START + 184 * STEP).unwrap();
    let connection = report
        .analysis
        .findings
        .iter()
        .find(|f| f.kind == "connections")
        .unwrap();
    assert_eq!(connection.observed, 25.0);
    assert_eq!(
        report
            .analysis
            .findings
            .iter()
            .find(|f| f.kind == "destination")
            .unwrap()
            .destination
            .as_deref(),
        Some("new.test")
    );
    let mut filtered = query(181, 182);
    filtered.interface = Some("en1".into());
    assert!(
        read_series(&path, &filtered, None, START + 184 * STEP)
            .unwrap()
            .analysis
            .findings
            .is_empty()
    );
    db.execute(
        "INSERT INTO applications VALUES ('other','Browser','/other/browser')",
        [],
    )
    .unwrap();
    db.execute("UPDATE flow_records SET app_key='other' WHERE id>1", [])
        .unwrap();
    let report = read_series(&path, &query(181, 182), None, START + 184 * STEP).unwrap();
    assert_eq!(report.application_count, 2);
    assert!(report.analysis.findings.iter().all(|f| f.app_key == "app"));
    assert_eq!(report.analysis.learning_profiles, 1);
}

#[test]
fn uses_absolute_floors_and_keeps_only_the_latest_hundred_findings() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let db = setup(&path);
    db.execute("UPDATE flow_samples SET bytes_sent=CASE WHEN timestamp_ms>=?1 THEN 1048576 ELSE 0 END,bytes_received=0",[START+181*STEP]).unwrap();
    assert!(
        read_series(&path, &query(181, 183), None, START + 184 * STEP)
            .unwrap()
            .analysis
            .findings
            .is_empty()
    );
    for i in 184..400 {
        db.execute(
            "INSERT INTO capture_intervals VALUES (1,?1,10000,0)",
            [START + i * STEP],
        )
        .unwrap();
        db.execute(
            "INSERT INTO flow_samples VALUES (1,?1,0,?2,0,NULL,NULL,'periodic')",
            params![START + i * STEP, 1048576 + (i - 183) * 4 * 1024 * 1024],
        )
        .unwrap();
    }
    db.execute(
        "UPDATE flow_records SET last_seen_ms=?1",
        [START + 400 * STEP],
    )
    .unwrap();
    let report = read_series(&path, &query(184, 400), None, START + 400 * STEP).unwrap();
    assert_eq!(report.analysis.findings.len(), 100);
    assert!(report.analysis.findings_limited);
    assert_eq!(
        report.analysis.findings.first().unwrap().timestamp_ms,
        START + 399 * STEP
    );
    assert_eq!(
        report.analysis.findings.last().unwrap().timestamp_ms,
        START + 300 * STEP
    );
    assert_eq!(report.points.iter().map(|p| p.findings).sum::<usize>(), 100);
    db.execute("UPDATE applications SET executable=NULL", [])
        .unwrap();
    assert!(
        read_series(&path, &query(184, 400), None, START + 400 * STEP)
            .unwrap()
            .analysis
            .findings
            .is_empty()
    );
}
