use std::io::Cursor;

use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, codecs::jpeg::JpegEncoder};

use crate::crops::{Crop, ImageSize};

#[derive(Clone, Copy)]
pub struct DecodeLimits {
    pub bytes: usize,
    pub pixels: u64,
    pub allocation_bytes: u64,
}

pub type Error = Box<dyn std::error::Error + Send + Sync>;

pub struct SourceImage {
    pixels: DynamicImage,
    pub size: ImageSize,
}

impl SourceImage {
    pub fn decode(source: &[u8], budget: DecodeLimits) -> Result<Self, Error> {
        let (decoder, size, _) = source_decoder(source, budget, None)?;
        Ok(Self {
            pixels: DynamicImage::from_decoder(decoder)?,
            size,
        })
    }

    pub(crate) fn jpeg_fitted(&self, target: ImageSize, quality: u8) -> Result<Vec<u8>, Error> {
        self.encode_jpeg(
            Crop {
                x: 0,
                y: 0,
                width: self.size.width.get(),
                height: self.size.height.get(),
            },
            target,
            quality,
            false,
        )
    }

    pub fn jpeg(&self, crop: Crop, target: ImageSize, quality: u8) -> Result<Vec<u8>, Error> {
        self.encode_jpeg(crop, target, quality, true)
    }

    fn encode_jpeg(
        &self,
        crop: Crop,
        target: ImageSize,
        quality: u8,
        fill: bool,
    ) -> Result<Vec<u8>, Error> {
        if !(1..=100).contains(&quality) {
            return Err("Invalid JPEG quality".into());
        }
        let Crop {
            x,
            y,
            width,
            height,
        } = crop;
        let source_width = self.size.width.get();
        let source_height = self.size.height.get();
        if width == 0
            || height == 0
            || width > source_width.saturating_sub(x)
            || height > source_height.saturating_sub(y)
        {
            return Err("Crop extends beyond the source image".into());
        }

        // Crop to the target aspect in source coordinates before resizing.
        // Scaling to cover before cropping can create a very large intermediate
        // image for a narrow or wide source crop.
        let crop = if fill {
            center_to_fill(crop, target)
        } else {
            crop
        };
        let resized = self
            .pixels
            .crop_imm(crop.x, crop.y, crop.width, crop.height)
            .resize_exact(
                target.width.get(),
                target.height.get(),
                image::imageops::FilterType::Lanczos3,
            );
        let rgb = if resized.color().has_alpha() {
            let rgba = resized.into_rgba8();
            image::RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
                let [r, g, b, a] = rgba.get_pixel(x, y).0;
                let flatten = |channel: u8| ((u16::from(channel) * u16::from(a) + 127) / 255) as u8;
                image::Rgb([flatten(r), flatten(g), flatten(b)])
            })
        } else {
            resized.into_rgb8()
        };

        let mut output = Vec::new();
        JpegEncoder::new_with_quality(&mut output, quality).encode_image(&rgb)?;
        Ok(output)
    }
}

pub(crate) fn decode_rendition_source(
    source: &[u8],
    mime: &str,
    limits: DecodeLimits,
    oriented: bool,
) -> Result<(SourceImage, ImageSize, u8, &'static str), Error> {
    let (mut decoder, raw_size, format) = source_decoder(source, limits, Some(mime))?;
    let orientation = if oriented {
        decoder.orientation()?
    } else {
        image::metadata::Orientation::NoTransforms
    };
    let mut pixels = DynamicImage::from_decoder(decoder)?;
    if oriented {
        pixels.apply_orientation(orientation);
    }
    let size = ImageSize {
        width: pixels.width().try_into()?,
        height: pixels.height().try_into()?,
    };
    Ok((
        SourceImage { pixels, size },
        raw_size,
        orientation.to_exif(),
        format,
    ))
}

/// Validate a source header and its declared MIME type without decoding pixels.
pub fn inspect_dimensions(
    source: &[u8],
    mime: &str,
    budget: DecodeLimits,
) -> Result<ImageSize, Error> {
    let (_, size, _) = source_decoder(source, budget, Some(mime))?;
    Ok(size)
}

/// Decode one still image and apply its embedded orientation. The caller owns
/// rendition, transparency, and publication policy.
#[cfg(feature = "still-images")]
pub fn decode_oriented_still(source: &[u8], budget: DecodeLimits) -> Result<DynamicImage, Error> {
    use image::codecs::{png::PngDecoder, webp::WebPDecoder};

    let reader = source_reader(source, budget)?;
    let input = Cursor::new(source);
    let still = match reader.format() {
        Some(ImageFormat::Jpeg) => true,
        Some(ImageFormat::Png) => !PngDecoder::new(input)?.is_apng()?,
        Some(ImageFormat::WebP) => !WebPDecoder::new(input)?.has_animation(),
        Some(ImageFormat::Tiff) => !tiff::decoder::Decoder::new(input)?.more_images(),
        _ => false,
    };
    if !still {
        return Err("A supported still image is required".into());
    }

    let (mut decoder, _) = bounded_decoder(reader, budget)?;
    let orientation = decoder.orientation()?;
    let mut pixels = DynamicImage::from_decoder(decoder)?;
    pixels.apply_orientation(orientation);
    Ok(pixels)
}

fn source_decoder<'a>(
    source: &'a [u8],
    budget: DecodeLimits,
    mime: Option<&str>,
) -> Result<(impl ImageDecoder + 'a, ImageSize, &'static str), Error> {
    let reader = source_reader(source, budget)?;
    let detected = match reader.format() {
        Some(ImageFormat::Jpeg) => "image/jpeg",
        Some(ImageFormat::Png) => "image/png",
        Some(ImageFormat::Gif) => "image/gif",
        Some(ImageFormat::WebP) => "image/webp",
        _ => return Err("Unsupported source image format".into()),
    };
    if mime.is_some_and(|mime| mime != detected) {
        return Err("Image does not match its declared MIME type".into());
    }
    let (decoder, size) = bounded_decoder(reader, budget)?;
    Ok((decoder, size, detected))
}

fn source_reader(source: &[u8], budget: DecodeLimits) -> Result<ImageReader<Cursor<&[u8]>>, Error> {
    if source.is_empty() || source.len() > budget.bytes {
        return Err("Image source exceeds the input byte limit".into());
    }
    Ok(ImageReader::new(Cursor::new(source)).with_guessed_format()?)
}

fn bounded_decoder(
    mut reader: ImageReader<Cursor<&[u8]>>,
    budget: DecodeLimits,
) -> Result<(impl ImageDecoder + '_, ImageSize), Error> {
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(budget.allocation_bytes);
    reader.limits(limits.clone());
    let mut decoder = reader.into_decoder()?;
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > budget.pixels {
        return Err("Image source exceeds the input pixel limit".into());
    }
    let size = ImageSize {
        width: width.try_into()?,
        height: height.try_into()?,
    };
    limits.reserve(decoder.total_bytes())?;
    decoder.set_limits(limits)?;
    Ok((decoder, size))
}

fn center_to_fill(mut crop: Crop, target: ImageSize) -> Crop {
    let (width, height) = (u64::from(crop.width), u64::from(crop.height));
    let (target_width, target_height) = (
        u64::from(target.width.get()),
        u64::from(target.height.get()),
    );
    if width * target_height > target_width * height {
        let fitted = (height * target_width / target_height).max(1) as u32;
        crop.x += (crop.width - fitted) / 2;
        crop.width = fitted;
    } else if width * target_height < target_width * height {
        let fitted = (width * target_height / target_width).max(1) as u32;
        crop.y += (crop.height - fitted) / 2;
        crop.height = fitted;
    }
    crop
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "still-images")]
    #[test]
    fn still_decoder_enforces_format_and_resource_limits() {
        let pixels =
            DynamicImage::ImageRgb8(image::RgbImage::from_pixel(4, 3, image::Rgb([24, 64, 128])));
        let budget = DecodeLimits {
            bytes: 4096,
            pixels: 12,
            allocation_bytes: 1024 * 1024,
        };

        for format in [ImageFormat::Png, ImageFormat::Tiff] {
            let mut source = Cursor::new(Vec::new());
            pixels.write_to(&mut source, format).unwrap();
            let source = source.into_inner();
            assert_eq!(decode_oriented_still(&source, budget).unwrap(), pixels);
            for small_budget in [
                DecodeLimits {
                    bytes: source.len() - 1,
                    ..budget
                },
                DecodeLimits {
                    pixels: 11,
                    ..budget
                },
                DecodeLimits {
                    allocation_bytes: 1,
                    ..budget
                },
            ] {
                assert!(decode_oriented_still(&source, small_budget).is_err());
            }
        }

        let mut source = Cursor::new(Vec::new());
        {
            let mut encoder = tiff::encoder::TiffEncoder::new(&mut source).unwrap();
            for _ in 0..2 {
                encoder
                    .write_image::<tiff::encoder::colortype::RGB8>(4, 3, pixels.as_bytes())
                    .unwrap();
            }
        }
        assert!(decode_oriented_still(source.get_ref(), budget).is_err());

        let mut source = Cursor::new(Vec::new());
        pixels.write_to(&mut source, ImageFormat::Gif).unwrap();
        assert!(decode_oriented_still(source.get_ref(), budget).is_err());
    }

    #[test]
    fn extreme_aspect_crops_stay_within_the_source() {
        let target = ImageSize {
            width: 100.try_into().unwrap(),
            height: 100.try_into().unwrap(),
        };
        let crop = Crop {
            x: 3,
            y: 4,
            width: 100_000,
            height: 1,
        };
        assert_eq!(
            center_to_fill(crop, target),
            Crop {
                x: 50_002,
                y: 4,
                width: 1,
                height: 1
            }
        );
        let crop = Crop {
            x: 3,
            y: 4,
            width: 1,
            height: 100_000,
        };
        assert_eq!(
            center_to_fill(crop, target),
            Crop {
                x: 3,
                y: 50_003,
                width: 1,
                height: 1
            }
        );
    }

    #[test]
    fn native_inspection_agrees_with_the_decoder_for_each_supported_format() {
        let source = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            11,
            7,
            image::Rgb([12, 50, 180]),
        ));
        let limits = DecodeLimits {
            bytes: 4096,
            pixels: 77,
            allocation_bytes: 1024 * 1024,
        };
        for (format, mime) in [
            (ImageFormat::Jpeg, "image/jpeg"),
            (ImageFormat::Png, "image/png"),
            (ImageFormat::Gif, "image/gif"),
            (ImageFormat::WebP, "image/webp"),
        ] {
            let mut encoded = Cursor::new(Vec::new());
            source.write_to(&mut encoded, format).unwrap();
            let bytes = encoded.get_ref();
            let size = inspect_dimensions(bytes, mime, limits).unwrap();
            let decoded = SourceImage::decode(bytes, limits).unwrap();
            assert_eq!((size.width.get(), size.height.get()), (11, 7), "{mime}");
            assert_eq!(size.width, decoded.size.width, "{mime}");
            assert_eq!(size.height, decoded.size.height, "{mime}");
            assert!(
                inspect_dimensions(bytes, "image/avif", limits).is_err(),
                "{mime}"
            );
            assert!(
                inspect_dimensions(
                    bytes,
                    mime,
                    DecodeLimits {
                        pixels: 76,
                        ..limits
                    }
                )
                .is_err(),
                "{mime}"
            );
            assert!(
                inspect_dimensions(
                    bytes,
                    mime,
                    DecodeLimits {
                        bytes: bytes.len() - 1,
                        ..limits
                    }
                )
                .is_err(),
                "{mime}"
            );
        }
    }

    #[test]
    fn png_crop_produces_a_jpeg_from_only_the_selected_pixels() {
        let source = DynamicImage::ImageRgba8(image::RgbaImage::from_fn(8, 8, |x, _| {
            if x < 4 {
                image::Rgba([255, 0, 0, 255])
            } else {
                image::Rgba([0, 0, 255, 255])
            }
        }));
        let mut source_bytes = Cursor::new(Vec::new());
        source
            .write_to(&mut source_bytes, ImageFormat::Png)
            .unwrap();
        let limits = DecodeLimits {
            bytes: 1024,
            pixels: 64,
            allocation_bytes: 1024 * 1024,
        };
        let inspected = inspect_dimensions(source_bytes.get_ref(), "image/png", limits).unwrap();
        assert_eq!((inspected.width.get(), inspected.height.get()), (8, 8));
        assert!(inspect_dimensions(source_bytes.get_ref(), "image/jpeg", limits).is_err());
        let decoded = SourceImage::decode(source_bytes.get_ref(), limits).unwrap();
        assert!(
            SourceImage::decode(
                source_bytes.get_ref(),
                DecodeLimits {
                    pixels: 63,
                    ..limits
                }
            )
            .is_err()
        );
        let target = ImageSize {
            width: 10.try_into().unwrap(),
            height: 6.try_into().unwrap(),
        };
        let crop = Crop {
            x: 4,
            y: 0,
            width: 4,
            height: 8,
        };
        let jpeg = decoded.jpeg(crop, target, 82).unwrap();
        let output = image::load_from_memory_with_format(&jpeg, ImageFormat::Jpeg)
            .unwrap()
            .into_rgb8();
        assert_eq!(output.dimensions(), (10, 6));
        let [red, green, blue] = output.get_pixel(4, 3).0;
        assert!(red < 10 && green < 10 && blue > 245);
        assert!(decoded.jpeg(Crop { x: 5, ..crop }, target, 82).is_err());
        assert!(SourceImage::decode(b"not an image", limits).is_err());
    }
}
