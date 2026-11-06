use crate::MINUTE;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};

const REQUIRED: usize = 30;
const WINDOW: usize = 120;
const WEEK: i64 = 7 * 24 * 60 * MINUTE;

pub(crate) struct Sample {
    pub app_key: String,
    pub name: String,
    pub interface: String,
    pub minute_ms: i64,
    pub uploaded: f64,
    pub connections: f64,
    pub new_destinations: i64,
    pub destination: Option<String>,
}

#[derive(Serialize)]
pub struct Finding {
    pub kind: &'static str,
    pub app_key: String,
    pub name: String,
    pub interface: String,
    pub first_ms: i64,
    pub last_ms: i64,
    pub observed: f64,
    pub baseline: f64,
    pub threshold: f64,
    pub prior_minutes: usize,
    pub destination: Option<String>,
}

#[derive(Default, Serialize)]
pub struct Analysis {
    pub findings: Vec<Finding>,
    pub ready_profiles: usize,
    pub learning_profiles: usize,
    pub eligible_minutes: usize,
    pub limited: bool,
    pub findings_limited: bool,
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    if values.len().is_multiple_of(2) {
        (values[middle - 1] + values[middle]) / 2.0
    } else {
        values[middle]
    }
}

fn threshold(values: impl Iterator<Item = f64>, floor: f64, margin: f64) -> (f64, f64) {
    let mut values: Vec<_> = values.collect();
    let center = median(&mut values);
    let mut deviations: Vec<_> = values.iter().map(|v| (v - center).abs()).collect();
    (
        center,
        floor
            .max(center * 5.0)
            .max(center + 6.0 * median(&mut deviations) + margin),
    )
}

pub(crate) fn analyze(
    samples: Vec<Sample>,
    from: i64,
    last_complete: i64,
    limited: bool,
) -> Analysis {
    let mut report = Analysis {
        eligible_minutes: samples.len(),
        limited,
        ..Analysis::default()
    };
    let mut profiles: HashMap<(String, String), VecDeque<Sample>> = HashMap::new();
    let mut findings: HashMap<(&'static str, String, String), Vec<Finding>> = HashMap::new();
    for sample in samples {
        let profile = profiles
            .entry((sample.app_key.clone(), sample.interface.clone()))
            .or_default();
        while profile
            .front()
            .is_some_and(|s| s.minute_ms < sample.minute_ms - WEEK)
        {
            profile.pop_front();
        }
        let mut unusual = false;
        if profile.len() >= REQUIRED {
            let (upload_baseline, upload_threshold) = threshold(
                profile.iter().map(|s| s.uploaded),
                10.0 * 1024.0 * 1024.0,
                1024.0 * 1024.0,
            );
            let (connection_baseline, connection_threshold) =
                threshold(profile.iter().map(|s| s.connections), 100.0, 20.0);
            let signals = [
                ("upload", sample.uploaded, upload_baseline, upload_threshold),
                (
                    "connections",
                    sample.connections,
                    connection_baseline,
                    connection_threshold,
                ),
                ("destination", sample.new_destinations as f64, 0.0, 0.0),
            ];
            for (kind, observed, baseline, threshold) in signals {
                if observed <= threshold {
                    continue;
                }
                // Quantitative outliers do not immediately redefine the baseline.
                unusual |= kind != "destination";
                if sample.minute_ms < from {
                    continue;
                }
                let group = findings
                    .entry((kind, sample.app_key.clone(), sample.interface.clone()))
                    .or_default();
                if let Some(last) = group
                    .last_mut()
                    .filter(|f| sample.minute_ms - f.last_ms <= 5 * MINUTE && kind != "destination")
                {
                    last.last_ms = sample.minute_ms;
                    if observed > last.observed {
                        last.observed = observed;
                        last.baseline = baseline;
                        last.threshold = threshold;
                        last.prior_minutes = profile.len();
                    }
                } else {
                    group.push(Finding {
                        kind,
                        app_key: sample.app_key.clone(),
                        name: sample.name.clone(),
                        interface: sample.interface.clone(),
                        first_ms: sample.minute_ms,
                        last_ms: sample.minute_ms,
                        observed,
                        baseline,
                        threshold,
                        prior_minutes: profile.len(),
                        destination: if kind == "destination" {
                            sample.destination.clone()
                        } else {
                            None
                        },
                    });
                }
            }
        }
        if !unusual {
            profile.push_back(sample);
            if profile.len() > WINDOW {
                profile.pop_front();
            }
        }
    }
    for profile in profiles.values_mut() {
        while profile
            .front()
            .is_some_and(|s| s.minute_ms < last_complete - WEEK)
        {
            profile.pop_front();
        }
        if profile.len() >= REQUIRED {
            report.ready_profiles += 1;
        } else if !profile.is_empty() {
            report.learning_profiles += 1;
        }
    }
    report.findings = findings.into_values().flatten().collect();
    report.findings.sort_by(|a, b| {
        b.last_ms
            .cmp(&a.last_ms)
            .then_with(|| a.app_key.cmp(&b.app_key))
            .then_with(|| a.interface.cmp(&b.interface))
            .then_with(|| a.kind.cmp(b.kind))
    });
    report.findings_limited = report.findings.len() > 100;
    report.findings.truncate(100);
    report
}
