-- A bounded dirty-bucket index catches same-timestamp updates and late boundary writes.
CREATE TABLE history_clock (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, generation INTEGER NOT NULL, identity TEXT NOT NULL);
INSERT INTO history_clock VALUES(1,0,0,lower(hex(randomblob(16))));
CREATE TABLE history_changes (bucket_ms INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
CREATE INDEX history_change_revision ON history_changes(revision);
CREATE TRIGGER history_flow_samples_insert AFTER INSERT ON flow_samples BEGIN
  UPDATE history_clock SET revision=revision+1 WHERE id=1;
  INSERT INTO history_changes VALUES(NEW.timestamp_ms/10000*10000,(SELECT revision FROM history_clock WHERE id=1))
    ON CONFLICT(bucket_ms) DO UPDATE SET revision=excluded.revision;
  DELETE FROM history_changes WHERE revision < (SELECT revision-100000 FROM history_clock WHERE id=1);
END;
CREATE TRIGGER history_flow_samples_update AFTER UPDATE ON flow_samples BEGIN
  UPDATE history_clock SET revision=revision+1 WHERE id=1;
  INSERT INTO history_changes VALUES(NEW.timestamp_ms/10000*10000,(SELECT revision FROM history_clock WHERE id=1))
    ON CONFLICT(bucket_ms) DO UPDATE SET revision=excluded.revision;
  DELETE FROM history_changes WHERE revision < (SELECT revision-100000 FROM history_clock WHERE id=1);
END;
CREATE TRIGGER history_capture_intervals_insert AFTER INSERT ON capture_intervals BEGIN
  UPDATE history_clock SET revision=revision+1 WHERE id=1;
  INSERT INTO history_changes VALUES(NEW.bucket_ms/10000*10000,(SELECT revision FROM history_clock WHERE id=1))
    ON CONFLICT(bucket_ms) DO UPDATE SET revision=excluded.revision;
  DELETE FROM history_changes WHERE revision < (SELECT revision-100000 FROM history_clock WHERE id=1);
END;
CREATE TRIGGER history_capture_intervals_update AFTER UPDATE ON capture_intervals BEGIN
  UPDATE history_clock SET revision=revision+1 WHERE id=1;
  INSERT INTO history_changes VALUES(NEW.bucket_ms/10000*10000,(SELECT revision FROM history_clock WHERE id=1))
    ON CONFLICT(bucket_ms) DO UPDATE SET revision=excluded.revision;
  DELETE FROM history_changes WHERE revision < (SELECT revision-100000 FROM history_clock WHERE id=1);
END;
CREATE TRIGGER history_flow_records_metadata AFTER UPDATE ON flow_records WHEN OLD.app_key IS NOT NEW.app_key OR OLD.hostname IS NOT NEW.hostname OR OLD.pid IS NOT NEW.pid BEGIN
  UPDATE history_clock SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_applications_metadata AFTER UPDATE ON applications WHEN OLD.name IS NOT NEW.name OR OLD.executable IS NOT NEW.executable BEGIN
  UPDATE history_clock SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_sessions_metadata AFTER UPDATE ON sessions WHEN OLD.interface IS NOT NEW.interface OR OLD.error IS NOT NEW.error OR OLD.capture_error IS NOT NEW.capture_error BEGIN
  UPDATE history_clock SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_flow_samples_delete AFTER DELETE ON flow_samples BEGIN
  UPDATE history_clock SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_capture_intervals_delete AFTER DELETE ON capture_intervals BEGIN
  UPDATE history_clock SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_flow_records_delete AFTER DELETE ON flow_records BEGIN
  UPDATE history_clock SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_sessions_delete AFTER DELETE ON sessions BEGIN
  UPDATE history_clock SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_applications_delete AFTER DELETE ON applications BEGIN
  UPDATE history_clock SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_sample_key AFTER UPDATE ON flow_samples
WHEN OLD.flow_id!=NEW.flow_id OR OLD.timestamp_ms!=NEW.timestamp_ms BEGIN
  UPDATE history_clock SET generation=generation+1 WHERE id=1;
END;
CREATE TRIGGER history_coverage_key AFTER UPDATE ON capture_intervals
WHEN OLD.session_id!=NEW.session_id OR OLD.bucket_ms!=NEW.bucket_ms BEGIN
  UPDATE history_clock SET generation=generation+1 WHERE id=1;
END;
PRAGMA user_version = 3;
