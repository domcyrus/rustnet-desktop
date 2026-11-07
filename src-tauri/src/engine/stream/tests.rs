use super::*;
use serde_json::{Value, json};

fn record(
    sequence: u64,
    base: Option<u64>,
    connections: Value,
    removed: Value,
    count: usize,
) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "schema_version": 2, "type": if base.is_some() { "delta" } else { "snapshot" },
        "sequence": sequence, "base_sequence": base, "removed_connection_ids": removed,
        "connection_count": count, "connections": connections, "timestamp": "2026-11-06T00:00:00Z",
        "runtime": {"status": "running", "capture_error": null},
        "stats": {"capture_accounting": {"captured": sequence}},
        "sandbox": {"status": "enforced"}, "filter": null, "future": {"counter": u64::MAX}
    }))
    .unwrap()
}
fn snapshot(update: Update) -> Snapshot {
    match update {
        Update::Snapshot(snapshot) => snapshot,
        Update::Stale => panic!("unexpected stale record"),
    }
}
fn value(snapshot: &Snapshot) -> Value {
    serde_json::from_str(snapshot.json()).unwrap()
}

#[test]
fn reconstructs_complete_records_removals_and_envelopes_without_losing_metadata() {
    let mut decoder = Decoder::default();
    let a = json!({"id":"a", "historic":false, "protocol_details":[{"label":"TLS", "value":"1.3"}], "process":{"user_group":"user:group"}, "traffic":{"bytes_received":u64::MAX}});
    let b = json!({"id":"b", "network_context":{"remote_hostname":"example.org"},"lifecycle":{"observed":true}});
    let first = snapshot(
        decoder
            .push(record(1, None, json!([b.clone(), a.clone()]), json!([]), 2))
            .unwrap(),
    );
    let next = snapshot(
        decoder
            .push(record(2, Some(1), json!([]), json!([]), 2))
            .unwrap(),
    );
    assert!(first.json.get().is_none());
    assert!(next.json.get().is_none());
    assert!(Arc::ptr_eq(
        &first.reconstructed.as_ref().unwrap().records["a"],
        &next.reconstructed.as_ref().unwrap().records["a"]
    ));
    let mut updated = a.clone();
    updated["historic"] = true.into();
    updated["process"]["user_group"] = "late:owner".into();
    let final_snapshot = snapshot(
        decoder
            .push(record(
                3,
                Some(2),
                json!([updated.clone()]),
                json!(["b"]),
                1,
            ))
            .unwrap(),
    );
    let rebuilt = value(&final_snapshot);
    assert_eq!(rebuilt["connections"], json!([updated]));
    assert_eq!(rebuilt["stats"]["capture_accounting"]["captured"], 3);
    assert_eq!(rebuilt["future"]["counter"], u64::MAX);
    assert_eq!(rebuilt["schema_version"], 1);
    assert_eq!(rebuilt["type"], "snapshot");
    assert!(rebuilt.get("sequence").is_none());
    assert_eq!(value(&first)["connections"], json!([a, b]));
    assert_eq!(value(&next)["connection_count"], 2);
}

#[test]
fn gaps_duplicates_reordering_and_invalid_batches_wait_for_full_recovery() {
    let full = || record(1, None, json!([{"id":"a"}]), json!([]), 1);
    let mut invalid_runtime: Value = serde_json::from_slice(&full()).unwrap();
    invalid_runtime["sequence"] = 2.into();
    invalid_runtime["runtime"] = json!(["running", null]);
    let invalid = [
        serde_json::to_vec(&invalid_runtime).unwrap(),
        record(3, Some(2), json!([]), json!([]), 1),
        record(1, Some(0), json!([]), json!([]), 1),
        record(2, Some(1), json!([]), json!(["missing"]), 0),
        record(2, Some(1), json!([]), json!(["a", "a"]), 0),
        record(2, Some(1), json!([{"id":"a"},{"id":"a"}]), json!([]), 1),
        record(2, Some(1), json!([{"missing":"id"}]), json!([]), 1),
        record(2, Some(1), json!([]), json!([]), 42),
        record(2, Some(1), json!([["a"]]), json!([]), 1),
        full(),
        b"{malformed\n".to_vec(),
    ];
    for bad in invalid {
        let mut decoder = Decoder::default();
        let original = snapshot(decoder.push(full()).unwrap());
        assert!(matches!(decoder.push(bad).unwrap(), Update::Stale));
        assert!(decoder.stale);
        assert!(decoder.records.is_empty());
        assert!(matches!(
            decoder
                .push(record(2, Some(1), json!([]), json!([]), 1))
                .unwrap(),
            Update::Stale
        ));
        assert_eq!(value(&original)["connections"], json!([{"id":"a"}]));
        let recovered = snapshot(
            decoder
                .push(record(60, None, json!([{"id":"new"}]), json!([]), 1))
                .unwrap(),
        );
        assert!(!decoder.stale);
        assert_eq!(value(&recovered)["connections"], json!([{"id":"new"}]));
        snapshot(
            decoder
                .push(record(61, Some(60), json!([]), json!(["new"]), 0))
                .unwrap(),
        );
    }
}

#[test]
fn new_stream_requires_a_baseline_and_terminal_full_snapshots_are_self_contained() {
    let mut decoder = Decoder::default();
    assert!(matches!(
        decoder
            .push(record(5, Some(4), json!([]), json!([]), 0))
            .unwrap(),
        Update::Stale
    ));
    let mut terminal: Value =
        serde_json::from_slice(&record(6, None, json!([{"id":"final"}]), json!([]), 1)).unwrap();
    terminal["runtime"] = json!({"status":"stopped", "shutdown":{"joined_workers":1}, "termination_reason":"shutdown_requested"});
    let terminal = snapshot(
        decoder
            .push(serde_json::to_vec(&terminal).unwrap())
            .unwrap(),
    );
    assert_eq!(terminal.status, "stopped");
    assert_eq!(value(&terminal)["connections"], json!([{"id":"final"}]));
    let mut restarted = Decoder::default();
    snapshot(
        restarted
            .push(record(1, None, json!([]), json!([]), 0))
            .unwrap(),
    );
    assert_eq!(restarted.sequence, Some(1));
}

#[test]
fn accepts_full_snapshots_above_the_old_limit_and_shares_unchanged_records() {
    let mut decoder = Decoder::default();
    let metadata = "x".repeat(25 * 1024 * 1024);
    let first = snapshot(
        decoder
            .push(record(
                1,
                None,
                json!([{"id":"large", "metadata":metadata}]),
                json!([]),
                1,
            ))
            .unwrap(),
    );
    let second = snapshot(
        decoder
            .push(record(2, Some(1), json!([]), json!([]), 1))
            .unwrap(),
    );
    assert!(second.json.get().is_none());
    assert!(Arc::ptr_eq(
        &first.reconstructed.as_ref().unwrap().records["large"],
        &second.reconstructed.as_ref().unwrap().records["large"]
    ));
    assert_eq!(
        value(&second)["connections"][0]["metadata"]
            .as_str()
            .unwrap()
            .len(),
        25 * 1024 * 1024
    );
}

#[test]
fn reconstruction_cannot_grow_past_its_budget_through_small_deltas() {
    let mut decoder = Decoder::default();
    snapshot(
        decoder
            .push(record(1, None, json!([{"id":"a"}]), json!([]), 1))
            .unwrap(),
    );
    // Exercise the accumulated-size calculation without allocating the budget.
    decoder.record_bytes = MAX_RECORD_BYTES as usize;
    let error = decoder.push(record(2, Some(1), json!([{"id":"b"}]), json!([]), 2));
    assert!(
        matches!(error, Err(error) if error.contains("Reconstructed capture snapshot exceeds"))
    );
    assert_eq!(decoder.sequence, Some(1));
    assert!(!decoder.records.contains_key("b"));
}

#[test]
fn removals_precede_upserts_and_connection_count_is_bounded() {
    let mut decoder = Decoder::default();
    snapshot(
        decoder
            .push(record(
                1,
                None,
                json!([{"id":"a", "old":true}]),
                json!([]),
                1,
            ))
            .unwrap(),
    );
    let replaced = snapshot(
        decoder
            .push(record(
                2,
                Some(1),
                json!([{"id":"a", "new":true}]),
                json!(["a"]),
                1,
            ))
            .unwrap(),
    );
    assert_eq!(
        value(&replaced)["connections"],
        json!([{"id":"a", "new":true}])
    );
    assert!(
        matches!(decoder.push(record(3, None, json!([]), json!([]), MAX_CONNECTIONS + 1)), Err(error) if error.contains("connections"))
    );
}
