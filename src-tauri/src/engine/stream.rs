//! Reconstruct the engine stream before the UI's lossy, latest-view polling.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, OnceLock};

use serde::{Deserialize, de::DeserializeOwned};
use serde_json::value::RawValue;

// Full initial, periodic and terminal records can exceed the delta baseline's
// 16 MiB cache budget. Bound both input and reconstructed output separately.
pub(super) const MAX_RECORD_BYTES: u64 = 128 * 1024 * 1024;
const MAX_CONNECTIONS: usize = 100_000;
pub(super) const STALE_ERROR: &str = "Capture stream is out of sync. Waiting for a full snapshot.";

pub(crate) struct Snapshot {
    json: OnceLock<String>,
    reconstructed: Option<Reconstructed>,
    pub(super) sequence: Option<u64>,
    pub(super) status: String,
    pub(super) error: Option<String>,
}

struct Reconstructed {
    prefix: String,
    records: Arc<BTreeMap<String, Arc<RawValue>>>,
    bytes: usize,
}

impl Snapshot {
    // Do not rebuild full JSON for skipped polls or frozen/hidden windows.
    pub(crate) fn json(&self) -> &str {
        self.json.get_or_init(|| {
            let data = self.reconstructed.as_ref().expect("snapshot data");
            let mut json = String::with_capacity(data.bytes);
            json.push_str(&data.prefix);
            for (index, record) in data.records.values().enumerate() {
                if index != 0 {
                    json.push(',');
                }
                json.push_str(record.get());
            }
            json.push_str("]}");
            json
        })
    }
}

#[derive(Deserialize)]
struct Runtime {
    status: String,
    capture_error: Option<String>,
}

pub(super) fn decode_snapshot(bytes: Vec<u8>) -> Result<Snapshot, String> {
    let json = String::from_utf8(bytes).map_err(|e| format!("Invalid capture snapshot: {e}"))?;
    let (status, error) = validate_snapshot(&json)?;
    Ok(Snapshot {
        json: OnceLock::from(json),
        reconstructed: None,
        sequence: None,
        status,
        error,
    })
}

pub(super) fn validate_snapshot(json: &str) -> Result<(String, Option<String>), String> {
    if !json.trim_start().starts_with('{') {
        return Err("Invalid capture snapshot: expected an object".into());
    }
    #[derive(Deserialize)]
    struct Header<'a> {
        schema_version: u64,
        #[serde(rename = "type")]
        kind: String,
        #[serde(borrow)]
        connections: &'a RawValue,
        runtime: Runtime,
    }
    let value: Header<'_> =
        serde_json::from_str(json).map_err(|e| format!("Invalid capture snapshot: {e}"))?;
    if value.schema_version != 1
        || value.kind != "snapshot"
        || !value.connections.get().starts_with('[')
    {
        return Err(
            "Unsupported capture schema. Rebuild the desktop's bundled RustNet engine.".into(),
        );
    }
    Ok((value.runtime.status, value.runtime.capture_error))
}

struct Record {
    schema_version: u64,
    kind: String,
    sequence: u64,
    base_sequence: Option<u64>,
    removed_connection_ids: Vec<String>,
    connection_count: usize,
    connections: Vec<Box<RawValue>>,
    runtime: Box<RawValue>,
    envelope: BTreeMap<String, Box<RawValue>>,
}

impl Record {
    fn parse(mut envelope: BTreeMap<String, &RawValue>) -> Option<Self> {
        fn field<T: DeserializeOwned>(
            envelope: &mut BTreeMap<String, &RawValue>,
            name: &str,
        ) -> Option<T> {
            serde_json::from_str(envelope.remove(name)?.get()).ok()
        }
        // Borrow the envelope first. Serde flatten buffers values and cannot
        // preserve RawValue; parsing fields directly keeps exact JSON numbers.
        Some(Self {
            schema_version: field(&mut envelope, "schema_version")?,
            kind: field(&mut envelope, "type")?,
            sequence: field(&mut envelope, "sequence")?,
            base_sequence: field(&mut envelope, "base_sequence")?,
            removed_connection_ids: field(&mut envelope, "removed_connection_ids")?,
            connection_count: field(&mut envelope, "connection_count")?,
            connections: field(&mut envelope, "connections")?,
            runtime: envelope.remove("runtime")?.to_owned(),
            envelope: envelope
                .into_iter()
                .map(|(key, value)| (key, value.to_owned()))
                .collect(),
        })
    }
}

pub(super) enum Update {
    Snapshot(Snapshot),
    Stale,
}

#[derive(Default)]
pub(super) struct Decoder {
    sequence: Option<u64>,
    last_applied: u64,
    records: Arc<BTreeMap<String, Arc<RawValue>>>,
    record_bytes: usize,
    pub(super) stale: bool,
}

impl Decoder {
    fn invalidate(&mut self) -> Update {
        self.sequence = None;
        self.records = Arc::default();
        self.record_bytes = 0;
        self.stale = true;
        Update::Stale
    }

    pub(super) fn push(&mut self, bytes: Vec<u8>) -> Result<Update, String> {
        let envelope: BTreeMap<String, &RawValue> = match serde_json::from_slice(&bytes) {
            Ok(envelope) => envelope,
            Err(_) => return Ok(self.invalidate()),
        };
        let version = match envelope
            .get("schema_version")
            .and_then(|raw| serde_json::from_str::<u64>(raw.get()).ok())
        {
            Some(version) => version,
            None => return Ok(self.invalidate()),
        };
        if version == 1 {
            let snapshot = decode_snapshot(bytes)?;
            *self = Self::default();
            return Ok(Update::Snapshot(snapshot));
        }
        if version != 2 {
            return Err(format!("Unsupported capture schema version {version}"));
        }
        let record = match Record::parse(envelope) {
            Some(record) => record,
            None => return Ok(self.invalidate()),
        };
        if !record.runtime.get().starts_with('{') {
            return Ok(self.invalidate());
        }
        // Unknown additive fields remain raw, including exact integer values.
        let runtime = match serde_json::from_str::<Runtime>(record.runtime.get()) {
            Ok(runtime) => runtime,
            Err(_) => return Ok(self.invalidate()),
        };
        let full = record.kind == "snapshot";
        if record.schema_version != 2
            || record.sequence == 0
            || (!full && record.kind != "delta")
            || (full
                && (record.sequence <= self.last_applied
                    || record.base_sequence.is_some()
                    || !record.removed_connection_ids.is_empty()))
            || (!full
                && (self.sequence.is_none()
                    || record.base_sequence != self.sequence
                    || self.sequence.and_then(|n| n.checked_add(1)) != Some(record.sequence)))
            || !["timestamp", "stats", "sandbox", "filter"]
                .iter()
                .all(|key| record.envelope.contains_key(*key))
        {
            return Ok(self.invalidate());
        }
        if record.connection_count > MAX_CONNECTIONS
            || record.connections.len() > MAX_CONNECTIONS
            || record.removed_connection_ids.len() > MAX_CONNECTIONS
        {
            return Err(format!(
                "Capture snapshot exceeds {MAX_CONNECTIONS} connections"
            ));
        }
        let mut removals = BTreeSet::new();
        for id in record.removed_connection_ids {
            if !removals.insert(id.clone()) || !self.records.contains_key(&id) {
                return Ok(self.invalidate());
            }
        }
        let mut updates = BTreeMap::new();
        for connection in record.connections {
            if !connection.get().starts_with('{') {
                return Ok(self.invalidate());
            }
            #[derive(Deserialize)]
            struct Identity {
                id: String,
            }
            let id = match serde_json::from_str::<Identity>(connection.get()) {
                Ok(identity) if !identity.id.is_empty() => identity.id,
                _ => return Ok(self.invalidate()),
            };
            if updates
                .insert(id, Arc::<RawValue>::from(connection))
                .is_some()
            {
                return Ok(self.invalidate());
            }
        }
        let mut records = if full {
            BTreeMap::new()
        } else {
            (*self.records).clone()
        };
        let mut size = if full { 0 } else { self.record_bytes };
        for id in removals {
            size -= records.remove(&id).expect("validated removal").get().len();
        }
        for (id, connection) in updates {
            size += connection.get().len();
            if let Some(old) = records.insert(id, connection) {
                size -= old.get().len();
            }
        }
        if records.len() != record.connection_count {
            return Ok(self.invalidate());
        }
        let mut envelope = record.envelope;
        envelope.insert(
            "schema_version".into(),
            serde_json::value::to_raw_value(&1).unwrap(),
        );
        envelope.insert(
            "type".into(),
            serde_json::value::to_raw_value("snapshot").unwrap(),
        );
        envelope.insert(
            "connection_count".into(),
            serde_json::value::to_raw_value(&records.len()).unwrap(),
        );
        envelope.insert("runtime".into(), record.runtime);
        let mut prefix = serde_json::to_string(&envelope).map_err(|e| e.to_string())?;
        prefix.pop();
        prefix.push_str(",\"connections\":[");
        let output_bytes = prefix.len() + size + records.len().saturating_sub(1) + 2;
        if output_bytes as u64 > MAX_RECORD_BYTES {
            return Err("Reconstructed capture snapshot exceeds 128 MiB. Reduce retained history or capture scope.".into());
        }
        let records = Arc::new(records);
        self.records = records.clone();
        self.record_bytes = size;
        self.sequence = Some(record.sequence);
        self.last_applied = record.sequence;
        self.stale = false;
        Ok(Update::Snapshot(Snapshot {
            json: OnceLock::new(),
            sequence: Some(record.sequence),
            reconstructed: Some(Reconstructed {
                prefix,
                records,
                bytes: output_bytes,
            }),
            status: runtime.status,
            error: runtime.capture_error,
        }))
    }
}

#[cfg(test)]
mod tests;
