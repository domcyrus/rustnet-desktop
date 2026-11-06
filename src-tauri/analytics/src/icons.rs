//! Optional, bounded icon cache. Executable references share content-addressed PNGs.
use crate::Result;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};
const MAX_ICONS: usize = 256;
const MAX_REFERENCES: usize = 2048;
const MAX_ICON_BYTES: usize = 128 * 1024;
const PREFIX: &str = "data:image/png;base64,";

pub struct IconCache {
    db: Connection,
}
impl IconCache {
    pub fn open(path: &Path) -> Result<Self> {
        let mut db = Connection::open(path)?;
        db.busy_timeout(Duration::from_millis(250))?;
        db.pragma_update(None, "foreign_keys", true)?;
        let tx = db.transaction()?;
        let version: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
        match version {
            0 => tx.execute_batch("CREATE TABLE IF NOT EXISTS icons (
                digest BLOB PRIMARY KEY, png TEXT NOT NULL, last_used_ms INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS icon_references (
                executable TEXT PRIMARY KEY, digest BLOB NOT NULL REFERENCES icons(digest) ON DELETE CASCADE,
                last_used_ms INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS icon_reference_digest ON icon_references(digest);
                PRAGMA user_version=1;")?,
            1 => {},
            _ => return Err(format!("Unsupported icon cache schema: {version}").into()),
        }
        tx.commit()?;
        Ok(Self { db })
    }
    pub fn get(&mut self, executable: &str, now: i64) -> Result<Option<String>> {
        if !valid_key(executable) {
            return Ok(None);
        }
        let tx = self.db.transaction()?;
        let icon: Option<String> = tx
            .query_row(
                "SELECT i.png FROM icons i JOIN icon_references r ON r.digest=i.digest
            WHERE r.executable=?1",
                [executable],
                |r| r.get(0),
            )
            .optional()?;
        if icon.as_deref().is_some_and(valid_png) {
            tx.execute(
                "UPDATE icon_references SET last_used_ms=?2 WHERE executable=?1",
                params![executable, now],
            )?;
            tx.execute("UPDATE icons SET last_used_ms=?2 WHERE digest=(SELECT digest FROM icon_references WHERE executable=?1)",params![executable,now])?;
            tx.commit()?;
            Ok(icon)
        } else {
            Ok(None)
        }
    }
    pub fn put(&mut self, executable: &str, png: &str, now: i64) -> Result<()> {
        self.put_bounded(executable, png, now, MAX_ICONS, MAX_REFERENCES)
    }
    fn put_bounded(
        &mut self,
        executable: &str,
        png: &str,
        now: i64,
        icons: usize,
        references: usize,
    ) -> Result<()> {
        if !valid_key(executable) || !valid_png(png) {
            return Ok(());
        }
        let digest = Sha256::digest(png.as_bytes());
        let tx = self.db.transaction()?;
        tx.execute("INSERT INTO icons VALUES(?1,?2,?3) ON CONFLICT(digest) DO UPDATE SET last_used_ms=excluded.last_used_ms",params![&digest[..],png,now])?;
        tx.execute("INSERT INTO icon_references VALUES(?1,?2,?3) ON CONFLICT(executable) DO UPDATE SET digest=excluded.digest,last_used_ms=excluded.last_used_ms",params![executable,&digest[..],now])?;
        tx.execute("DELETE FROM icon_references WHERE executable IN (SELECT executable FROM icon_references ORDER BY last_used_ms DESC,executable LIMIT -1 OFFSET ?1)",[references as i64])?;
        tx.execute("DELETE FROM icons WHERE NOT EXISTS (SELECT 1 FROM icon_references r WHERE r.digest=icons.digest)",[])?;
        tx.execute("DELETE FROM icons WHERE digest IN (SELECT digest FROM icons ORDER BY last_used_ms DESC,digest LIMIT -1 OFFSET ?1)",[icons as i64])?;
        tx.commit()?;
        Ok(())
    }
}
fn valid_key(executable: &str) -> bool {
    !executable.is_empty() && executable.len() <= 4096 && Path::new(executable).is_absolute()
}
fn valid_png(icon: &str) -> bool {
    icon.len() <= MAX_ICON_BYTES
        && icon.strip_prefix(PREFIX).is_some_and(|data| {
            data.starts_with("iVBORw0KGgo")
                && data
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    const PNG: &str = "data:image/png;base64,iVBORw0KGgo=";
    fn key(name: &str) -> String {
        std::env::temp_dir()
            .join(name)
            .to_string_lossy()
            .into_owned()
    }
    #[test]
    fn shares_one_png_across_executable_references_and_reopens_without_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("icons.db");
        let mut cache = IconCache::open(&path).unwrap();
        for name in ["missing-app", "missing-helper", "missing-app"] {
            cache.put(&key(name), PNG, 1).unwrap();
        }
        assert_eq!(
            cache
                .db
                .query_row("SELECT COUNT(*) FROM icons", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            cache
                .db
                .query_row("SELECT COUNT(*) FROM icon_references", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        drop(cache);
        let mut cache = IconCache::open(&path).unwrap();
        assert_eq!(
            cache.get(&key("missing-app"), 2).unwrap().as_deref(),
            Some(PNG)
        );
        cache
            .put(&key("missing-app"), &format!("{PNG}AA"), 3)
            .unwrap();
        assert_eq!(
            cache.get(&key("missing-helper"), 4).unwrap().as_deref(),
            Some(PNG)
        );
        cache
            .put(&key("missing-helper"), &format!("{PNG}AA"), 5)
            .unwrap();
        assert_eq!(
            cache
                .db
                .query_row("SELECT COUNT(*) FROM icons", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn evicts_old_icons_and_references_without_leaving_orphans() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = IconCache::open(&dir.path().join("icons.db")).unwrap();
        c.put_bounded(&key("a"), PNG, 1, 2, 3).unwrap();
        c.put_bounded(&key("b"), &format!("{PNG}AA"), 2, 2, 3)
            .unwrap();
        c.get(&key("a"), 3).unwrap();
        c.put_bounded(&key("c"), &format!("{PNG}BB"), 4, 2, 3)
            .unwrap();
        assert!(c.get(&key("b"), 5).unwrap().is_none());
        c.put_bounded(&key("d"), PNG, 6, 2, 2).unwrap();
        assert!(c.get(&key("a"), 7).unwrap().is_none());
        assert!(c.get(&key("d"), 8).unwrap().is_some());
        assert_eq!(c.db.query_row("SELECT COUNT(*) FROM icon_references r LEFT JOIN icons i USING(digest) WHERE i.digest IS NULL",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
    #[test]
    fn rejects_oversized_payloads_non_png_and_unstable_identities() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = IconCache::open(&dir.path().join("icons.db")).unwrap();
        for png in [
            "https://example.com/icon.png".to_string(),
            format!("{PREFIX}<svg/>"),
            format!("{PNG}{}", "A".repeat(MAX_ICON_BYTES)),
        ] {
            c.put(&key("a"), &png, 1).unwrap();
        }
        for path in ["", "1234", "Firefox"] {
            c.put(path, PNG, 1).unwrap();
        }
        assert_eq!(
            c.db.query_row("SELECT COUNT(*) FROM icons", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
