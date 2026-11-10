//! Rasterize the shared SVG with resvg; output does not depend on a desktop or installed fonts.
use std::path::Path;

use resvg::{tiny_skia, usvg};

const SIZES: [u32; 10] = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512];

fn generate(svg: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let tree = usvg::Tree::from_data(svg, &usvg::Options::default()).map_err(|error| error.to_string())?;
    let mut frames = Vec::new();
    for size in SIZES {
        let mut pixmap = tiny_skia::Pixmap::new(size, size).ok_or("Could not allocate an icon.")?;
        let scale = size as f32 / tree.size().width();
        resvg::render(
            &tree,
            tiny_skia::Transform::from_scale(scale, scale),
            &mut pixmap.as_mut(),
        );
        frames.push(pixmap.encode_png().map_err(|error| error.to_string())?);
    }
    let png = frames.pop().expect("512px frame");
    // ICO directory followed by PNG frames, matching the sizes used by the Electron build.
    let mut ico = Vec::new();
    for value in [0u16, 1, frames.len() as u16] {
        ico.extend_from_slice(&value.to_le_bytes());
    }
    let mut offset = 6 + frames.len() * 16;
    for (&size, frame) in SIZES.iter().zip(&frames) {
        ico.extend_from_slice(&[size as u8, size as u8, 0, 0]);
        ico.extend_from_slice(&1u16.to_le_bytes());
        ico.extend_from_slice(&32u16.to_le_bytes());
        ico.extend_from_slice(&(frame.len() as u32).to_le_bytes());
        ico.extend_from_slice(&(offset as u32).to_le_bytes());
        offset += frame.len();
    }
    for frame in frames {
        ico.extend(frame);
    }
    Ok((png, ico))
}

pub fn run(root: &Path, check: bool) -> Result<(), String> {
    let assets = root.join("src/assets");
    let svg = std::fs::read(assets.join("logo.svg")).map_err(|error| error.to_string())?;
    let (png, ico) = generate(&svg)?;
    for (name, bytes) in [("icon.png", png), ("icon.ico", ico)] {
        let file = assets.join(name);
        if check {
            if std::fs::read(&file).map_err(|error| error.to_string())? != bytes {
                return Err(format!("{name} differs from logo.svg; run cargo xtask icons."));
            }
        } else {
            std::fs::write(file, bytes).map_err(|error| error.to_string())?;
        }
    }
    println!(
        "{} native icons from logo.svg.",
        if check { "Verified" } else { "Generated" }
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generates_a_512px_png_and_all_nine_windows_icon_sizes() {
        let svg = include_bytes!("../../src/assets/logo.svg");
        let (png, ico) = generate(svg).unwrap();
        let pixmap = tiny_skia::Pixmap::decode_png(&png).unwrap();
        assert_eq!((pixmap.width(), pixmap.height()), (512, 512));
        assert_eq!(&ico[..6], &[0, 0, 1, 0, 9, 0]);
        let mut expected_offset = 6 + 9 * 16;
        for (index, size) in SIZES[..9].iter().enumerate() {
            let entry = &ico[6 + index * 16..6 + (index + 1) * 16];
            assert_eq!(entry[0], *size as u8);
            assert_eq!(entry[1], *size as u8);
            let length = u32::from_le_bytes(entry[8..12].try_into().unwrap()) as usize;
            let offset = u32::from_le_bytes(entry[12..16].try_into().unwrap()) as usize;
            assert_eq!(offset, expected_offset);
            let frame = tiny_skia::Pixmap::decode_png(&ico[offset..offset + length]).unwrap();
            assert_eq!((frame.width(), frame.height()), (*size, *size));
            expected_offset += length;
        }
        assert_eq!(expected_offset, ico.len());
        assert_eq!(generate(svg).unwrap(), (png, ico));
    }
}
