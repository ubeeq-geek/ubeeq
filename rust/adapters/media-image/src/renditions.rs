use std::collections::HashSet;

use serde_json::{Value, json};

use crate::{
    crops::{ImageSize, square},
    render::{DecodeLimits, Error, decode_rendition_source},
};

const RECIPES: [(&str, u32, bool); 7] = [
    ("w320", 320, false),
    ("w640", 640, false),
    ("w1280", 1280, false),
    ("w1920", 1920, false),
    ("square256", 256, true),
    ("square512", 512, true),
    ("square1024", 1024, true),
];

pub struct ImageProfile<'a> {
    pub names: Option<&'a [&'a str]>,
    pub oriented: bool,
    pub decode_limits: DecodeLimits,
    pub max_output_bytes: usize,
}

pub struct ImageInput<'a> {
    pub asset_id: &'a str,
    pub source_version: &'a str,
    pub mime: &'a str,
    pub bytes: &'a [u8],
    pub square_crop: Option<[f64; 3]>,
}

pub struct Rendition {
    pub lineage: Value,
    pub bytes: Vec<u8>,
}

pub struct RenditionSet {
    pub metadata: Value,
    pub renditions: Vec<Rendition>,
}

pub fn render(input: ImageInput<'_>, profile: ImageProfile<'_>) -> Result<RenditionSet, Error> {
    if input.asset_id.is_empty() || input.source_version.is_empty() || profile.max_output_bytes == 0
    {
        return Err("Image processing requires an asset, source version and output budget".into());
    }
    let selected = profile
        .names
        .map(|names| -> Result<HashSet<_>, Error> {
            let selected: HashSet<_> = names.iter().copied().collect();
            if selected.is_empty()
                || selected.len() != names.len()
                || !selected
                    .iter()
                    .all(|name| RECIPES.iter().any(|recipe| recipe.0 == *name))
            {
                return Err("Invalid image rendition selection".into());
            }
            Ok(selected)
        })
        .transpose()?;
    let crop_request = match input.square_crop {
        Some([x, y, size]) if [x, y, size].into_iter().all(f64::is_finite) => {
            json!({"x":x,"y":y,"size":size.max(1.0)})
        }
        Some(_) => return Err("Invalid square crop".into()),
        None => Value::Null,
    };
    let (source, raw, orientation, format) = decode_rendition_source(
        input.bytes,
        input.mime,
        profile.decode_limits,
        profile.oriented,
    )?;
    let format = match format {
        "image/jpeg" => "jpeg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => return Err("Unsupported source image format".into()),
    };
    let width = source.size.width.get();
    let height = source.size.height.get();
    let square = square(source.size, &crop_request);
    let mut renditions = Vec::new();
    let mut output_bytes = 0usize;
    for (name, size, cropped) in RECIPES {
        if selected.as_ref().is_some_and(|names| !names.contains(name)) {
            continue;
        }
        let bytes = if cropped {
            let edge = size.try_into()?;
            source.jpeg(
                square,
                ImageSize {
                    width: edge,
                    height: edge,
                },
                82,
            )?
        } else {
            source.jpeg_fitted(fitted(width, height, size)?, 82)?
        };
        output_bytes = output_bytes
            .checked_add(bytes.len())
            .filter(|bytes| *bytes <= profile.max_output_bytes)
            .ok_or("Image renditions exceed output byte budget")?;
        let label = if name == "w320" { "preview" } else { name };
        let lineage = json!({"id":format!("{label}:{}:{}",input.asset_id,input.source_version),
            "sourceVersionId":input.source_version,"contentType":"image/jpeg","role":"preview","byteLength":bytes.len()});
        renditions.push(Rendition { lineage, bytes });
    }
    let mut metadata = json!({"contentType":input.mime, "byteLength":input.bytes.len(), "width":width,"height":height,
        "decodedFormat":format,"aspectRatio":(f64::from(width)/f64::from(height)*100_000.0).round()/100_000.0,
        "squareCropX":square.x,"squareCropY":square.y,"squareCropSize":square.width});
    if profile.oriented {
        metadata["coordinateSpace"] = json!("oriented");
        metadata["rawSourceWidth"] = json!(raw.width.get());
        metadata["rawSourceHeight"] = json!(raw.height.get());
        metadata["sourceOrientation"] = json!(orientation);
    }
    Ok(RenditionSet {
        metadata,
        renditions,
    })
}

fn fitted(width: u32, height: u32, size: u32) -> Result<ImageSize, Error> {
    let scale = (f64::from(size) / f64::from(width.max(height))).min(1.0);
    let edge = |pixels| (f64::from(pixels) * scale).round().max(1.0) as u32;
    Ok(ImageSize {
        width: edge(width).try_into()?,
        height: edge(height).try_into()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
    use std::io::Cursor;

    #[test]
    fn exif_orientation_is_applied_only_to_the_oriented_profile() {
        let source = DynamicImage::ImageRgb8(RgbImage::from_pixel(11, 7, Rgb([10, 50, 90])));
        let mut bytes = Cursor::new(Vec::new());
        source.write_to(&mut bytes, ImageFormat::Jpeg).unwrap();
        let mut bytes = bytes.into_inner();
        let exif = [
            0xff, 0xe1, 0x00, 0x22, b'E', b'x', b'i', b'f', 0, 0, b'I', b'I', 42, 0, 8, 0, 0, 0, 1,
            0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
        ];
        bytes.splice(2..2, exif);
        let input = || ImageInput {
            asset_id: "asset",
            source_version: "version",
            mime: "image/jpeg",
            bytes: &bytes,
            square_crop: None,
        };
        let profile = |oriented| ImageProfile {
            names: Some(&["w320"]),
            oriented,
            decode_limits: DecodeLimits {
                bytes: 4096,
                pixels: 77,
                allocation_bytes: 4096,
            },
            max_output_bytes: 4096,
        };
        let raw = render(input(), profile(false)).unwrap();
        assert_eq!(raw.metadata["width"], 11);
        assert_eq!(raw.metadata["height"], 7);
        assert!(raw.metadata.get("sourceOrientation").is_none());
        let oriented = render(input(), profile(true)).unwrap();
        assert_eq!(oriented.metadata["width"], 7);
        assert_eq!(oriented.metadata["height"], 11);
        assert_eq!(oriented.metadata["sourceOrientation"], 6);
        assert_eq!(
            image::load_from_memory(&oriented.renditions[0].bytes)
                .unwrap()
                .height(),
            11
        );
    }

    #[test]
    fn renders_selected_recipes_in_contract_order_and_without_upscaling_width() {
        let source = DynamicImage::ImageRgb8(RgbImage::from_pixel(11, 7, Rgb([10, 50, 90])));
        let mut bytes = Cursor::new(Vec::new());
        source.write_to(&mut bytes, ImageFormat::Png).unwrap();
        let input = || ImageInput {
            asset_id: "asset",
            source_version: "source",
            mime: "image/png",
            bytes: bytes.get_ref(),
            square_crop: Some([3.4, 1.9, 0.0]),
        };
        let profile = |max_output_bytes| ImageProfile {
            names: Some(&["square256", "w320"]),
            oriented: true,
            decode_limits: DecodeLimits {
                bytes: 4096,
                pixels: 77,
                allocation_bytes: 4096,
            },
            max_output_bytes,
        };
        let set = render(input(), profile(1_000_000)).unwrap();
        assert_eq!(set.metadata["width"], 11);
        assert_eq!(set.metadata["squareCropSize"], 1);
        assert_eq!(set.metadata["sourceOrientation"], 1);
        assert_eq!(set.renditions[0].lineage["id"], "preview:asset:source");
        assert_eq!(set.renditions[1].lineage["id"], "square256:asset:source");
        assert_eq!(
            image::load_from_memory(&set.renditions[0].bytes)
                .unwrap()
                .width(),
            11
        );
        assert_eq!(
            image::load_from_memory(&set.renditions[1].bytes)
                .unwrap()
                .width(),
            256
        );
        assert!(render(input(), profile(1)).is_err());
    }
}
