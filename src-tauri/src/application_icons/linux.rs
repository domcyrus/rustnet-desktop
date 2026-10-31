use gtk::{gio, glib, prelude::*};
use std::path::{Path, PathBuf};

pub fn find_icon(executable: Option<&str>, name: &str, pids: &[u32]) -> Option<String> {
    let executable = executable
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);
    let executable = executable.or_else(|| {
        pids.iter().find_map(|pid| {
            let path = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
            // Do not assign an unrelated process's icon after PID reuse.
            (path.file_name()?.to_str()? == name).then_some(path)
        })
    });
    // GIO applies XDG data directory precedence and Hidden desktop overrides.
    select_icon(&gio::AppInfo::all(), executable.as_deref(), name)
}

fn select_icon(apps: &[gio::AppInfo], executable: Option<&Path>, name: &str) -> Option<String> {
    let mut best = 0;
    let mut selected = None;
    let mut ambiguous = false;
    for app in apps {
        let Some(command) = app.commandline() else {
            continue;
        };
        let Some(program) = desktop_program(&command) else {
            continue;
        };
        let rank = match_rank(executable, name, &program);
        if rank == 0 || rank < best {
            continue;
        }
        let Some(icon) = app.icon().and_then(|icon| IconExt::to_string(&icon)) else {
            continue;
        };
        let icon = icon.to_string();
        if rank > best {
            best = rank;
            selected = Some(icon);
            ambiguous = false;
        } else if selected.as_ref() != Some(&icon) {
            ambiguous = true;
        }
    }
    if ambiguous { None } else { selected }
}

fn desktop_program(command: &Path) -> Option<PathBuf> {
    // Parse quoting without ever executing the desktop entry or its arguments.
    let args = glib::shell_parse_argv(command).ok()?;
    let mut args = args.iter();
    let mut program = args.next()?;
    if Path::new(program).file_name()? == "env" {
        program = args.find(|arg| !arg.to_string_lossy().contains('=') && *arg != "--")?;
        if program.to_string_lossy().starts_with('-') {
            return None;
        }
    }
    // Shared launchers do not identify the application they start.
    if matches!(
        Path::new(program).file_name()?.to_str()?,
        "flatpak" | "snap" | "sh" | "bash"
    ) {
        return None;
    }
    Some(PathBuf::from(program))
}

fn match_rank(executable: Option<&Path>, name: &str, program: &Path) -> u8 {
    let Some(executable) = executable else {
        return u8::from(program.file_name().is_some_and(|file| file == name));
    };
    let resolved = if program.is_absolute() {
        Some(program.to_path_buf())
    } else {
        glib::find_program_in_path(program)
    };
    if let Some(resolved) = resolved {
        if executable == resolved {
            return 3;
        }
        if let (Ok(left), Ok(right)) = (executable.canonicalize(), resolved.canonicalize()) {
            return if left == right { 3 } else { 0 };
        }
        return 0;
    }
    // A known absolute path must not match a different installation by name.
    if !program.is_absolute() && program.file_name() == executable.file_name() {
        1
    } else {
        0
    }
}

pub fn render_icon(serialized: &str) -> Option<String> {
    render_with_theme(&gtk::IconTheme::default()?, serialized)
}

fn render_with_theme(theme: &gtk::IconTheme, serialized: &str) -> Option<String> {
    let icon = gio::Icon::for_string(serialized).ok()?;
    // Resolves both themed icons (including SVG) and absolute file icons.
    let info = theme.lookup_by_gicon(&icon, 128, gtk::IconLookupFlags::FORCE_SIZE)?;
    let pixbuf = info.load_icon().ok()?;
    let png = pixbuf.save_to_bufferv("png", &[]).ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        glib::base64_encode(&png)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "rustnet-icons-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn app(&self, id: &str, exec: &str, icon: &str) -> gio::AppInfo {
            let path = self.0.join(format!("{id}.desktop"));
            fs::write(
                &path,
                format!("[Desktop Entry]\nType=Application\nName={id}\nExec={exec}\nIcon={icon}\n"),
            )
            .unwrap();
            gio::DesktopAppInfo::from_filename(path).unwrap().upcast()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn matches_desktop_entries_without_running_commands() {
        let fixture = Fixture::new();
        let app = fixture.app("browser", "/bin/sh %U", "browser");
        assert_eq!(select_icon(&[app], Some(Path::new("/bin/sh")), "sh"), None);
        assert_eq!(
            desktop_program(Path::new("env TEST=1 \"/opt/My Browser/browser\" %U")),
            Some(PathBuf::from("/opt/My Browser/browser"))
        );
        assert_eq!(desktop_program(Path::new("env -u TEST browser")), None);
        assert_eq!(
            desktop_program(Path::new("flatpak run org.example.Browser")),
            None
        );
        assert_eq!(desktop_program(Path::new("\"unterminated")), None);
    }

    #[test]
    fn matches_paths_and_symlinks_without_confusing_installations() {
        let fixture = Fixture::new();
        let executable = fixture.0.join("browser");
        fs::write(&executable, "").unwrap();
        let link = fixture.0.join("browser-link");
        std::os::unix::fs::symlink(&executable, &link).unwrap();
        assert_eq!(match_rank(Some(&executable), "browser", &link), 3);
        assert_eq!(
            match_rank(Some(&executable), "browser", Path::new("/another/browser")),
            0
        );
        assert_eq!(match_rank(None, "browser", &executable), 1);
        assert_eq!(match_rank(None, "browser-helper", &executable), 0);
    }

    #[test]
    fn returns_no_icon_for_ambiguous_or_missing_applications() {
        let fixture = Fixture::new();
        let apps = [
            fixture.app("one", "/bin/true", "one"),
            fixture.app("two", "/bin/true", "two"),
        ];
        assert_eq!(
            select_icon(&apps, Some(Path::new("/bin/true")), "true"),
            None
        );
        assert_eq!(select_icon(&apps, None, "missing"), None);
        assert_eq!(
            select_icon(&apps[..1], Some(Path::new("/bin/true")), "true"),
            Some("one".into())
        );
        assert_eq!(select_icon(&apps[..1], None, "true"), Some("one".into()));
    }

    #[test]
    #[ignore = "requires a GTK display; run through test:application-icons"]
    fn renders_linux_icons() {
        gtk::init().unwrap();
        let fixture = Fixture::new();
        fs::write(fixture.0.join("example.svg"),
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#ff0000"/></svg>"##).unwrap();
        let theme = gtk::IconTheme::new();
        theme.prepend_search_path(&fixture.0);
        let data = render_with_theme(&theme, "example").unwrap();
        let png = glib::base64_decode(data.strip_prefix("data:image/png;base64,").unwrap());
        let file = fixture.0.join("absolute.png");
        fs::write(&file, &png).unwrap();
        let pixbuf = gtk::gdk_pixbuf::Pixbuf::from_file(&file).unwrap();
        assert_eq!((pixbuf.width(), pixbuf.height()), (128, 128));
        assert_eq!(&pixbuf.read_pixel_bytes().as_ref()[..3], &[255, 0, 0]);
        assert!(render_with_theme(&theme, file.to_str().unwrap()).is_some());
        assert!(render_with_theme(&theme, "rustnet-missing-icon").is_none());
        let broken = fixture.0.join("broken.png");
        fs::write(&broken, "invalid image").unwrap();
        assert!(render_with_theme(&theme, broken.to_str().unwrap()).is_none());
        assert!(render_icon("rustnet-missing-icon").is_none());
        assert!(find_icon(Some("/rustnet/missing"), "missing", &[]).is_none());
    }
}
