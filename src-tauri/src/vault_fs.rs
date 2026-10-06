//! Filesystem access for a vault that lives in a real folder on disk.
//!
//! Everything here is plain `std` (no Tauri types) so it can be unit-tested on its own.
//! Every function takes the vault root plus a vault-relative path (`/`-separated, as in
//! `VaultAdapter`) and refuses any path that would leave the root. Errors are strings of the
//! form `"<code>: <path>"` where `<code>` is one of the `VaultError` codes on the TypeScript side.

use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Suffix of the temporary file used for atomic writes; never listed.
pub const TMP_SUFFIX: &str = ".yobsidian-tmp";

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Entry {
    pub path: String,
    pub kind: &'static str,
    pub size: u64,
    pub mtime: u64,
}

fn err(code: &str, path: &str) -> String {
    format!("{code}: {path}")
}

fn io_err(e: &io::Error, path: &str) -> String {
    let code = match e.kind() {
        io::ErrorKind::NotFound => "not-found",
        io::ErrorKind::AlreadyExists => "exists",
        _ => "io",
    };
    format!("{code}: {path} ({e})")
}

/// Turn a vault-relative path into an absolute one under `root`, rejecting `..`, absolute
/// paths, drive prefixes and NUL bytes.
pub fn resolve(root: &str, rel: &str) -> Result<PathBuf, String> {
    let mut out = PathBuf::from(root);
    for seg in rel.replace('\\', "/").split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." || seg.contains('\0') || (cfg!(windows) && seg.contains(':')) {
            return Err(err("invalid-path", rel));
        }
        out.push(seg);
    }
    Ok(out)
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn entry_of(path: &str, meta: &fs::Metadata) -> Entry {
    if meta.is_dir() {
        Entry { path: path.to_string(), kind: "folder", size: 0, mtime: mtime_ms(meta) }
    } else {
        Entry { path: path.to_string(), kind: "file", size: meta.len(), mtime: mtime_ms(meta) }
    }
}

fn check_root(root: &str) -> Result<(), String> {
    if Path::new(root).is_dir() {
        Ok(())
    } else {
        Err(err("not-found", root))
    }
}

/// Every file and folder under the root, recursively. Symlinked folders are not followed.
pub fn list(root: &str) -> Result<Vec<Entry>, String> {
    check_root(root)?;
    let mut out = Vec::new();
    walk(Path::new(root), "", &mut out)?;
    Ok(out)
}

fn walk(dir: &Path, prefix: &str, out: &mut Vec<Entry>) -> Result<(), String> {
    let rd = fs::read_dir(dir).map_err(|e| io_err(&e, prefix))?;
    for item in rd {
        let item = item.map_err(|e| io_err(&e, prefix))?;
        let Some(name) = item.file_name().to_str().map(str::to_string) else { continue };
        if name.ends_with(TMP_SUFFIX) {
            continue;
        }
        let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        let Ok(ft) = item.file_type() else { continue };
        if ft.is_symlink() {
            // Follow symlinks to files only; a symlinked folder could loop.
            if let Ok(meta) = fs::metadata(item.path()) {
                if meta.is_file() {
                    out.push(entry_of(&rel, &meta));
                }
            }
            continue;
        }
        let Ok(meta) = item.metadata() else { continue };
        out.push(entry_of(&rel, &meta));
        if ft.is_dir() {
            walk(&item.path(), &rel, out)?;
        }
    }
    Ok(())
}

pub fn stat(root: &str, rel: &str) -> Result<Option<Entry>, String> {
    check_root(root)?;
    let p = resolve(root, rel)?;
    match fs::metadata(&p) {
        Ok(meta) => Ok(Some(entry_of(rel.trim_matches('/'), &meta))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_err(&e, rel)),
    }
}

pub fn read(root: &str, rel: &str) -> Result<Vec<u8>, String> {
    let p = resolve(root, rel)?;
    if p.is_dir() {
        return Err(err("not-a-file", rel));
    }
    fs::read(&p).map_err(|e| io_err(&e, rel))
}

/// Write via a temporary file in the same folder and rename it into place, so a crash or a
/// sync running at the same moment never sees a half-written note.
pub fn write(root: &str, rel: &str, data: &[u8]) -> Result<(), String> {
    check_root(root)?;
    let p = resolve(root, rel)?;
    if p == Path::new(root) || p.is_dir() {
        return Err(err("not-a-file", rel));
    }
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|_| err("not-a-folder", rel))?;
    }
    let mut tmp = p.clone().into_os_string();
    tmp.push(TMP_SUFFIX);
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, data).map_err(|e| io_err(&e, rel))?;
    fs::rename(&tmp, &p).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        io_err(&e, rel)
    })
}

pub fn mkdir(root: &str, rel: &str) -> Result<(), String> {
    check_root(root)?;
    let p = resolve(root, rel)?;
    if p.is_file() {
        return Err(err("not-a-folder", rel));
    }
    fs::create_dir_all(&p).map_err(|e| io_err(&e, rel))
}

pub fn rename(root: &str, from: &str, to: &str) -> Result<(), String> {
    check_root(root)?;
    let src = resolve(root, from)?;
    let dst = resolve(root, to)?;
    if fs::symlink_metadata(&src).is_err() {
        return Err(err("not-found", from));
    }
    if fs::symlink_metadata(&dst).is_ok() {
        return Err(err("exists", to));
    }
    if dst.starts_with(&src) {
        return Err(err("invalid-path", to));
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|_| err("not-a-folder", to))?;
    }
    fs::rename(&src, &dst).map_err(|e| io_err(&e, from))
}

pub fn remove(root: &str, rel: &str) -> Result<(), String> {
    check_root(root)?;
    let p = resolve(root, rel)?;
    if p == Path::new(root) {
        return Err(err("invalid-path", rel));
    }
    let meta = fs::symlink_metadata(&p).map_err(|e| io_err(&e, rel))?;
    let res = if meta.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
    res.map_err(|e| io_err(&e, rel))
}

/// Decode `encodeURIComponent` output (used to pass non-ASCII paths through HTTP-style headers).
pub fn percent_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3).ok_or("bad percent escape")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "bad percent escape")?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "invalid utf-8".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(tag: &str) -> String {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("yobsidian-test-{tag}-{}-{n}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn rejects_escaping_paths() {
        let root = temp_root("escape");
        assert!(resolve(&root, "../x").is_err());
        assert!(resolve(&root, "a/../../x").is_err());
        assert!(write(&root, "../evil.md", b"x").is_err());
        assert_eq!(resolve(&root, "/a//b/./c").unwrap(), Path::new(&root).join("a").join("b").join("c"));
    }

    #[test]
    fn write_read_list_roundtrip_with_unicode_names() {
        let root = temp_root("rw");
        write(&root, "폴더/노트.md", "안녕 [[링크]]".as_bytes()).unwrap();
        write(&root, "a.md", b"A").unwrap();
        assert_eq!(read(&root, "폴더/노트.md").unwrap(), "안녕 [[링크]]".as_bytes());
        let mut paths: Vec<_> = list(&root).unwrap().into_iter().map(|e| (e.path, e.kind)).collect();
        paths.sort();
        assert_eq!(paths, vec![("a.md".into(), "file"), ("폴더".into(), "folder"), ("폴더/노트.md".into(), "file")]);
        // overwrite leaves no temp file behind
        write(&root, "a.md", b"B").unwrap();
        assert_eq!(read(&root, "a.md").unwrap(), b"B");
        assert!(!list(&root).unwrap().iter().any(|e| e.path.ends_with(TMP_SUFFIX)));
    }

    #[test]
    fn stat_rename_remove() {
        let root = temp_root("ops");
        write(&root, "x/y.md", b"1").unwrap();
        assert_eq!(stat(&root, "x/y.md").unwrap().unwrap().size, 1);
        assert!(stat(&root, "nope.md").unwrap().is_none());
        rename(&root, "x", "z/w").unwrap();
        assert!(stat(&root, "z/w/y.md").unwrap().is_some());
        write(&root, "other.md", b"2").unwrap();
        assert!(rename(&root, "other.md", "z/w/y.md").unwrap_err().starts_with("exists"));
        assert!(rename(&root, "z", "z/inside").unwrap_err().starts_with("invalid-path"));
        remove(&root, "z").unwrap();
        assert!(stat(&root, "z").unwrap().is_none());
        assert!(remove(&root, "z").unwrap_err().starts_with("not-found"));
        assert!(remove(&root, "").unwrap_err().starts_with("invalid-path"));
    }

    #[test]
    fn file_folder_conflicts() {
        let root = temp_root("kinds");
        write(&root, "f.md", b"1").unwrap();
        assert!(mkdir(&root, "f.md").unwrap_err().starts_with("not-a-folder"));
        mkdir(&root, "d").unwrap();
        assert!(write(&root, "d", b"1").unwrap_err().starts_with("not-a-file"));
        assert!(read(&root, "d").unwrap_err().starts_with("not-a-file"));
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("%ED%8F%B4%EB%8D%94%2F%EB%85%B8%ED%8A%B8.md").unwrap(), "폴더/노트.md");
        assert_eq!(percent_decode("plain-a_b.md").unwrap(), "plain-a_b.md");
        assert!(percent_decode("%zz").is_err());
        assert!(percent_decode("%4").is_err());
    }
}
