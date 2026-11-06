//! Bounded metadata delivery to a SQLite writer outside capture and UI polling.
use crate::engine::Snapshot;
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{sync::mpsc, task::JoinHandle};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Status {
    pub path: String,
    pub active: bool,
    pub stored_snapshots: u64,
    pub dropped_snapshots: u64,
    pub error: Option<String>,
}
pub type SharedStatus = Arc<Mutex<Status>>;

#[derive(Clone)]
pub struct Sink {
    sender: mpsc::Sender<(u64, Arc<Snapshot>)>,
    status: SharedStatus,
}
impl Sink {
    pub fn submit(&self, sequence: u64, snapshot: Arc<Snapshot>) {
        // Never block the pipe reader or accumulate an unbounded snapshot queue.
        if self.sender.try_send((sequence, snapshot)).is_err() {
            self.status
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .dropped_snapshots += 1;
        }
    }
}

pub struct Writer {
    pub sink: Sink,
    pub status: SharedStatus,
    task: JoinHandle<()>,
}
impl Writer {
    pub async fn start(path: PathBuf, interface: String) -> Result<Self, String> {
        let display_path = path.display().to_string();
        let mut store = tokio::task::spawn_blocking(move || {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_millis() as i64;
            rustnet_analytics::Store::open(&path, &interface, now).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
        let status = Arc::new(Mutex::new(Status {
            path: display_path,
            active: true,
            stored_snapshots: 0,
            dropped_snapshots: 0,
            error: None,
        }));
        // Two pending records, each bounded by the engine's 16 MiB record limit.
        let (sender, mut receiver) = mpsc::channel::<(u64, Arc<Snapshot>)>(2);
        let sink = Sink {
            sender,
            status: status.clone(),
        };
        let progress = status.clone();
        let task = tokio::task::spawn_blocking(move || {
            let result = (|| {
                while let Some((sequence, snapshot)) = receiver.blocking_recv() {
                    if store
                        .ingest(&snapshot.json, sequence)
                        .map_err(|e| e.to_string())?
                    {
                        progress
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .stored_snapshots += 1;
                    }
                }
                Ok::<(), String>(())
            })();
            let mut error = result.err();
            let dropped = progress
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .dropped_snapshots;
            if let Err(finish_error) = store.finish(dropped, error.as_deref()) {
                error = Some(finish_error.to_string());
            }
            let mut status = progress.lock().unwrap_or_else(|e| e.into_inner());
            status.active = false;
            status.error = error;
        });
        Ok(Self { sink, status, task })
    }
    pub async fn finish(self) {
        drop(self.sink);
        if let Err(error) = self.task.await {
            let mut status = self.status.lock().unwrap_or_else(|e| e.into_inner());
            status.active = false;
            status.error = Some(error.to_string());
        }
    }
}
