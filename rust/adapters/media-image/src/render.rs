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
        if source.is_empty() || source.len() > budget.bytes {
            return Err("Image source exceeds the input byte limit".into());
        }

        let mut reader = ImageReader::new(Cursor::new(source)).with_guessed_format()?;
        if !matches!(
            reader.format(),
            Some(ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::Gif | ImageFormat::WebP)
        ) {
            return Err("Unsupported source image format".into());
        }
        // Crop coordinates refer to stored pixels, so leave EXIF orientation unapplied.
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
        Ok(Self {
            pixels: DynamicImage::from_decoder(decoder)?,
            size,
        })
    }

    pub fn jpeg(&self, crop: Crop, target: ImageSize, quality: u8) -> Result<Vec<u8>, Error> {
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

        let resized = self.pixels.crop_imm(x, y, width, height).resize_to_fill(
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

#[cfg(test)]
mod tests {
    use super::*;

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
