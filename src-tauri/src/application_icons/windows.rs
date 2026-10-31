use base64::{Engine, engine::general_purpose::STANDARD};
use std::ffi::{OsString, c_void};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::ptr::null_mut;
use windows_sys::Win32::{
    Foundation::CloseHandle,
    Graphics::Gdi::{
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS,
        DeleteDC, DeleteObject, GdiFlush, HBITMAP, HDC, HGDIOBJ, SelectObject,
    },
    System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    },
    UI::{
        Shell::SHDefExtractIconW,
        WindowsAndMessaging::{DI_NORMAL, DestroyIcon, DrawIconEx, HICON},
    },
};

const SIZE: usize = 128;
const PIXEL_BYTES: usize = SIZE * SIZE * 4;

pub fn lookup(executable: Option<&str>, name: &str, pids: &[u32]) -> Option<String> {
    if let Some(executable) = executable.filter(|path| !path.is_empty()) {
        // A known path must not fall back to a different installation by name.
        return extract(Path::new(executable));
    }
    pids.iter().find_map(|&pid| {
        let path = process_executable(pid)?;
        // Reject a PID reused by a process with a different executable name.
        if !path.file_name()?.to_str()?.eq_ignore_ascii_case(name) {
            return None;
        }
        extract(&path)
    })
}

fn process_executable(pid: u32) -> Option<PathBuf> {
    // SAFETY: the handle is used synchronously and closed after the query.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        let success = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length);
        CloseHandle(process);
        (success != 0).then(|| PathBuf::from(OsString::from_wide(&buffer[..length as usize])))
    }
}

fn extract(path: &Path) -> Option<String> {
    // Do not search the working directory or PATH for a bare process name.
    if !path.is_absolute() {
        return None;
    }
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return None;
    }
    wide.push(0);
    let mut icon = Icon(null_mut());
    // SAFETY: the path is terminated and the output handle is owned by Icon.
    let result =
        unsafe { SHDefExtractIconW(wide.as_ptr(), 0, 0, &mut icon.0, null_mut(), SIZE as u32) };
    if result != 0 || icon.0.is_null() {
        return None;
    }
    encode_png(&render(&icon)?)
}

struct Icon(HICON);

impl Drop for Icon {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: this wrapper owns the extracted icon.
            unsafe { DestroyIcon(self.0) };
        }
    }
}

struct Surface {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut c_void,
}

impl Surface {
    fn new() -> Option<Self> {
        let mut surface = Self {
            dc: null_mut(),
            bitmap: null_mut(),
            previous: null_mut(),
            bits: null_mut(),
        };
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: SIZE as i32,
                biHeight: -(SIZE as i32), // Top-down BGRA pixels.
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..Default::default()
            },
            ..Default::default()
        };
        // SAFETY: all handles remain owned by this surface, including on failure.
        unsafe {
            surface.dc = CreateCompatibleDC(null_mut());
            if surface.dc.is_null() {
                return None;
            }
            surface.bitmap = CreateDIBSection(
                surface.dc,
                &info,
                DIB_RGB_COLORS,
                &mut surface.bits,
                null_mut(),
                0,
            );
            if surface.bitmap.is_null() || surface.bits.is_null() {
                return None;
            }
            let previous = SelectObject(surface.dc, surface.bitmap);
            if previous.is_null() || previous as isize == -1 {
                return None;
            }
            surface.previous = previous;
        }
        Some(surface)
    }

    fn draw(&mut self, icon: &Icon, background: u8) -> Option<Vec<u8>> {
        // SAFETY: the DIB owns PIXEL_BYTES bytes. No Rust reference to its memory
        // survives a GDI call, and GdiFlush completes drawing before CPU access.
        unsafe {
            std::ptr::write_bytes(self.bits.cast::<u8>(), background, PIXEL_BYTES);
            let drawn = DrawIconEx(
                self.dc,
                0,
                0,
                icon.0,
                SIZE as i32,
                SIZE as i32,
                0,
                null_mut(),
                DI_NORMAL,
            );
            let flushed = GdiFlush();
            if drawn == 0 || flushed == 0 {
                return None;
            }
            Some(std::slice::from_raw_parts(self.bits.cast::<u8>(), PIXEL_BYTES).to_vec())
        }
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        // SAFETY: deselect the bitmap before releasing the owned GDI objects.
        unsafe {
            if !self.previous.is_null() {
                SelectObject(self.dc, self.previous);
            }
            if !self.bitmap.is_null() {
                DeleteObject(self.bitmap);
            }
            if !self.dc.is_null() {
                DeleteDC(self.dc);
            }
        }
    }
}

fn render(icon: &Icon) -> Option<Vec<u8>> {
    let mut surface = Surface::new()?;
    let black = surface.draw(icon, 0)?;
    let white = surface.draw(icon, 255)?;
    // Drawing on both backgrounds recovers alpha for modern icons and legacy
    // AND masks alike. PNG expects straight RGBA, not premultiplied BGRA.
    let mut rgba = Vec::with_capacity(PIXEL_BYTES);
    for (black, white) in black
        .as_chunks::<4>()
        .0
        .iter()
        .zip(white.as_chunks::<4>().0)
    {
        let alpha = 255 - white[0].saturating_sub(black[0]);
        for channel in [2, 1, 0] {
            rgba.push(if alpha == 0 {
                0
            } else {
                ((u32::from(black[channel]) * 255 + u32::from(alpha) / 2) / u32::from(alpha))
                    .min(255) as u8
            });
        }
        rgba.push(alpha);
    }
    Some(rgba)
}

fn encode_png(rgba: &[u8]) -> Option<String> {
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, SIZE as u32, SIZE as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
        writer.finish().ok()?;
    }
    Some(format!("data:image/png;base64,{}", STANDARD.encode(png)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{CreateIcon, CreateIconFromResourceEx};

    #[test]
    fn preserves_png_icon_colors_and_partial_alpha() {
        let mut rgba = vec![0; PIXEL_BYTES];
        rgba[..4].copy_from_slice(&[255, 0, 0, 128]);
        rgba[4..8].copy_from_slice(&[0, 255, 0, 255]);
        let data = encode_png(&rgba).unwrap();
        let png = STANDARD
            .decode(data.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        // SAFETY: PNG is a complete icon resource; the returned handle is owned.
        let icon = Icon(unsafe {
            CreateIconFromResourceEx(
                png.as_ptr(),
                png.len() as u32,
                1,
                0x00030000,
                SIZE as i32,
                SIZE as i32,
                0,
            )
        });
        assert!(!icon.0.is_null());
        assert_eq!(render(&icon).unwrap(), rgba);
    }

    #[test]
    fn renders_legacy_mask_and_color_as_transparent_png() {
        // A 2x2 legacy icon: transparent, red, green, blue. AND rows are WORD-aligned.
        let mask = [0x80, 0, 0, 0];
        let color = [0, 0, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0];
        // SAFETY: the buffers contain a complete 2x2 mask and 32-bit color image.
        let icon =
            Icon(unsafe { CreateIcon(null_mut(), 2, 2, 1, 32, mask.as_ptr(), color.as_ptr()) });
        assert!(!icon.0.is_null());
        let rgba = render(&icon).unwrap();
        // Sample quadrant centers to avoid interpolation at scaled edges.
        let pixel = |x, y| &rgba[(y * SIZE + x) * 4..(y * SIZE + x) * 4 + 4];
        let samples = [pixel(32, 32), pixel(96, 32), pixel(32, 96), pixel(96, 96)];
        for expected in [
            [0, 0, 0, 0],
            [255, 0, 0, 255],
            [0, 255, 0, 255],
            [0, 0, 255, 255],
        ] {
            assert!(samples.contains(&expected.as_slice()));
        }
        let data = encode_png(&rgba).unwrap();
        let png = STANDARD
            .decode(data.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        let mut reader = png::Decoder::new(std::io::Cursor::new(png))
            .read_info()
            .unwrap();
        let mut decoded = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut decoded).unwrap();
        assert_eq!((info.width, info.height), (128, 128));
        assert_eq!(&decoded[..info.buffer_size()], rgba);
    }

    #[test]
    fn extracts_icon_files_and_rejects_missing_or_invalid_paths() {
        let icon = Path::new(env!("CARGO_MANIFEST_DIR")).join("icons/icon.ico");
        assert!(extract(&icon).is_some());
        assert!(extract(&icon.with_file_name("missing-rustnet-icon.exe")).is_none());
        assert!(extract(&icon.with_file_name("invalid\0.exe")).is_none());
        assert!(lookup(Some("relative.exe"), "relative.exe", &[]).is_none());
        assert!(lookup(None, "missing.exe", &[]).is_none());
    }

    #[test]
    fn resolves_process_paths_and_rejects_reused_or_unavailable_pids() {
        let pid = std::process::id();
        let path = process_executable(pid).unwrap();
        assert_eq!(path, std::env::current_exe().unwrap());
        assert!(process_executable(0).is_none());
        assert!(lookup(None, "unrelated-process.exe", &[pid]).is_none());
        let name = path.file_name().unwrap().to_str().unwrap().to_uppercase();
        assert_eq!(lookup(None, &name, &[0, pid]), extract(&path));
        assert!(lookup(Some("relative.exe"), &name, &[pid]).is_none());
    }
}
