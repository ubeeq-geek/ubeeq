use avif_rust::{NativeDecodeLimits, decode_frame_bytes_strict_with_limits};
use image::{DynamicImage, RgbaImage, metadata::Orientation};

use crate::render::{DecodeLimits, Error};

/// Recognize AVIF file-type brands without interpreting or allocating image data.
pub fn is_avif(source: &[u8]) -> bool {
    file_type(source).is_some_and(|(major, compatible)| {
        avif_brand(major) || compatible.chunks_exact(4).any(avif_brand)
    })
}

fn avif_brand(brand: &[u8]) -> bool {
    matches!(brand, b"avif" | b"avis" | b"avio")
}

fn file_type(source: &[u8]) -> Option<(&[u8], &[u8])> {
    if source.get(4..8)? != b"ftyp" {
        return None;
    }
    let (size, header) = match u32::from_be_bytes(source.get(..4)?.try_into().ok()?) {
        1 => (u64::from_be_bytes(source.get(8..16)?.try_into().ok()?), 16),
        size => (u64::from(size), 8),
    };
    // File type has two fixed 4-byte fields and a byte-aligned brand table.
    if size > 1024 {
        return None;
    }
    let payload = source.get(header..usize::try_from(size).ok()?)?;
    if payload.len() < 8 || payload.len() % 4 != 0 {
        return None;
    }
    Some((&payload[..4], &payload[8..]))
}

/// Decode a bounded still AVIF item and apply its container orientation.
pub fn decode_oriented_still(source: &[u8], budget: DecodeLimits) -> Result<DynamicImage, Error> {
    if source.is_empty() || source.len() > budget.bytes {
        return Err("Image source exceeds the input byte limit".into());
    }
    if let Some((major, compatible)) = file_type(source)
        && (major == b"avis" || compatible.chunks_exact(4).any(|brand| brand == b"avis"))
    {
        return Err("A still AVIF image is required".into());
    }
    let allocation = usize::try_from(budget.allocation_bytes)?;
    // Reserve room for high-bit-depth planes, the RGBA conversion and orientation.
    let pixels = usize::try_from(budget.pixels)?.min(allocation / 32);
    if pixels == 0 {
        return Err("AVIF image exceeds the allocation limit".into());
    }
    let limits = NativeDecodeLimits::new(
        budget.bytes,
        8192,
        8192,
        pixels,
        allocation / 4,
        allocation.min(8 * 1024 * 1024),
        allocation.min(1024 * 1024),
        128,
        256,
        1,
        0,
        1,
    )
    .with_max_live_allocation_bytes(allocation)?;
    let (frame, metadata) = decode_frame_bytes_strict_with_limits(source, &limits)?.into_parts();
    let info = metadata.info();
    if info.major_brand == *b"avis" || info.compatible_brands.contains(b"avis") {
        return Err("A still AVIF image is required".into());
    }
    if info.clean_aperture.is_some() {
        return Err("AVIF clean apertures are unsupported".into());
    }
    let rgba = frame.to_rgba8()?;
    let mut pixels = DynamicImage::ImageRgba8(
        RgbaImage::from_raw(rgba.width.try_into()?, rgba.height.try_into()?, rgba.rgba)
            .ok_or("AVIF decoder returned invalid dimensions")?,
    );
    if let Some(mirror) = info.mirror {
        let orientation = match mirror.axis {
            0 => Orientation::FlipHorizontal,
            1 => Orientation::FlipVertical,
            _ => return Err("Invalid AVIF mirror axis".into()),
        };
        pixels.apply_orientation(orientation);
    }
    if let Some(rotation) = info.rotation {
        let orientation = match rotation.angle {
            0 => Orientation::NoTransforms,
            1 => Orientation::Rotate270,
            2 => Orientation::Rotate180,
            3 => Orientation::Rotate90,
            _ => return Err("Invalid AVIF rotation angle".into()),
        };
        pixels.apply_orientation(orientation);
    }
    Ok(pixels)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 8×6 red still AVIF generated with libaom.
    const STILL: &[u8] = &[
        0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0x00, 0x00, 0x00,
        0x00, 0x61, 0x76, 0x69, 0x66, 0x6d, 0x69, 0x66, 0x31, 0x6d, 0x69, 0x61, 0x66, 0x4d, 0x41,
        0x31, 0x42, 0x00, 0x00, 0x00, 0xf9, 0x6d, 0x65, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x2f, 0x68, 0x64, 0x6c, 0x72, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x70, 0x69, 0x63, 0x74, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x50, 0x69, 0x63, 0x74, 0x75, 0x72, 0x65, 0x48, 0x61, 0x6e, 0x64, 0x6c, 0x65, 0x72,
        0x00, 0x00, 0x00, 0x00, 0x0e, 0x70, 0x69, 0x74, 0x6d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
        0x00, 0x00, 0x00, 0x1e, 0x69, 0x6c, 0x6f, 0x63, 0x00, 0x00, 0x00, 0x00, 0x44, 0x00, 0x00,
        0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x01, 0x21, 0x00, 0x00, 0x00, 0x1b,
        0x00, 0x00, 0x00, 0x28, 0x69, 0x69, 0x6e, 0x66, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00,
        0x00, 0x00, 0x1a, 0x69, 0x6e, 0x66, 0x65, 0x02, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
        0x61, 0x76, 0x30, 0x31, 0x43, 0x6f, 0x6c, 0x6f, 0x72, 0x00, 0x00, 0x00, 0x00, 0x6a, 0x69,
        0x70, 0x72, 0x70, 0x00, 0x00, 0x00, 0x4b, 0x69, 0x70, 0x63, 0x6f, 0x00, 0x00, 0x00, 0x14,
        0x69, 0x73, 0x70, 0x65, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00,
        0x06, 0x00, 0x00, 0x00, 0x10, 0x70, 0x69, 0x78, 0x69, 0x00, 0x00, 0x00, 0x00, 0x03, 0x08,
        0x08, 0x08, 0x00, 0x00, 0x00, 0x0c, 0x61, 0x76, 0x31, 0x43, 0x81, 0x00, 0x0c, 0x00, 0x00,
        0x00, 0x00, 0x13, 0x63, 0x6f, 0x6c, 0x72, 0x6e, 0x63, 0x6c, 0x78, 0x00, 0x02, 0x00, 0x02,
        0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x17, 0x69, 0x70, 0x6d, 0x61, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x04, 0x01, 0x02, 0x83, 0x04, 0x00, 0x00, 0x00, 0x23,
        0x6d, 0x64, 0x61, 0x74, 0x0a, 0x05, 0x18, 0x08, 0xbd, 0x6c, 0x02, 0x32, 0x12, 0x18, 0x00,
        0x00, 0x00, 0x50, 0x00, 0x00, 0x40, 0x03, 0x52, 0xed, 0xe7, 0x17, 0xf4, 0xf3, 0x45, 0xa6,
        0x20,
    ];

    #[test]
    fn decodes_a_still_avif_and_rejects_unbounded_inputs() {
        let budget = DecodeLimits {
            bytes: 1024,
            pixels: 64,
            allocation_bytes: 64 * 1024 * 1024,
        };
        let mut compatible = STILL.to_vec();
        compatible[8..12].copy_from_slice(b"mif1");
        assert!(is_avif(&compatible));
        assert!(decode_oriented_still(&compatible, budget).is_ok());
        compatible[8..12].copy_from_slice(b"avis");
        assert!(is_avif(&compatible));
        assert_eq!(
            decode_oriented_still(&compatible, budget)
                .unwrap_err()
                .to_string(),
            "A still AVIF image is required"
        );
        assert!(!is_avif(&STILL[..16]));
        let pixels = decode_oriented_still(STILL, budget).unwrap().into_rgba8();
        assert_eq!(pixels.dimensions(), (8, 6));
        let [r, g, b, a] = pixels.get_pixel(0, 0).0;
        assert!(r > 220 && g < 35 && b < 35 && a == 255);
        let limited = DecodeLimits {
            pixels: 63,
            ..budget
        };
        assert!(decode_oriented_still(STILL, limited).is_err());
        assert!(decode_oriented_still(&STILL[..STILL.len() - 1], budget).is_err());
    }
}
