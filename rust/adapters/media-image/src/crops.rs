use std::num::NonZeroU32;

use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Crop {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy)]
pub struct ImageSize {
    pub width: NonZeroU32,
    pub height: NonZeroU32,
}

pub fn square(source: ImageSize, requested: &Value) -> Crop {
    let width = source.width.get();
    let height = source.height.get();
    let max_side = width.min(height);
    let Some([x, y, size]) =
        coordinates(requested, ["x", "y", "size"]).filter(|[_, _, size]| *size > 0.0)
    else {
        return Crop {
            x: (width - max_side) / 2,
            y: (height - max_side) / 2,
            width: max_side,
            height: max_side,
        };
    };
    let side = (size.floor() as u32).clamp(1, max_side);
    bounded_crop(source, x.floor(), y.floor(), side, side)
}

pub fn focal_point(requested: &Value) -> [f64; 2] {
    coordinates(requested, ["x", "y"])
        .unwrap_or([0.5, 0.5])
        .map(|value| value.clamp(0.0, 1.0))
}

#[derive(Clone, Copy)]
pub struct CoverZoom(f64);

impl CoverZoom {
    pub fn parse(value: &Value) -> Option<Self> {
        let zoom = if value.is_null() {
            1.0
        } else {
            value.as_f64()?
        };
        (1.0..=3.0).contains(&zoom).then_some(Self(zoom))
    }

    pub fn get(self) -> f64 {
        self.0
    }
}

pub fn cover(
    source: ImageSize,
    target: ImageSize,
    focal: [f64; 2],
    requested: &Value,
    zoom: CoverZoom,
) -> Crop {
    let source_width = source.width.get();
    let source_height = source.height.get();
    if let Some([x, y, width, height]) = coordinates(requested, ["x", "y", "width", "height"])
        .filter(|[_, _, width, height]| *width > 0.0 && *height > 0.0)
    {
        return bounded_crop(
            source,
            x.floor(),
            y.floor(),
            (width.floor() as u32).clamp(1, source_width),
            (height.floor() as u32).clamp(1, source_height),
        );
    }
    let target_aspect = f64::from(target.width.get()) / f64::from(target.height.get());
    let natural_width = f64::from(source_width);
    let natural_height = f64::from(source_height);
    let (width, height) = if natural_width / natural_height > target_aspect {
        (
            (natural_height * target_aspect)
                .round()
                .clamp(1.0, natural_width),
            natural_height,
        )
    } else {
        (
            natural_width,
            (natural_width / target_aspect)
                .round()
                .clamp(1.0, natural_height),
        )
    };
    let width = (width / zoom.get()).round().max(1.0) as u32;
    let height = (height / zoom.get()).round().max(1.0) as u32;
    let x = (focal[0].clamp(0.0, 1.0) * natural_width - f64::from(width) / 2.0).round();
    let y = (focal[1].clamp(0.0, 1.0) * natural_height - f64::from(height) / 2.0).round();
    bounded_crop(source, x, y, width, height)
}

fn bounded_crop(source: ImageSize, x: f64, y: f64, width: u32, height: u32) -> Crop {
    Crop {
        x: (x as u32).min(source.width.get() - width),
        y: (y as u32).min(source.height.get() - height),
        width,
        height,
    }
}

fn coordinates<const N: usize>(value: &Value, fields: [&str; N]) -> Option<[f64; N]> {
    let mut result = [0.0; N];
    for (position, field) in fields.into_iter().enumerate() {
        let value = value.get(field)?;
        let number = match value {
            Value::Null => 0.0,
            Value::Bool(value) => u8::from(*value).into(),
            Value::String(value) if value.trim().is_empty() => 0.0,
            Value::String(value) => value.trim().parse().ok()?,
            _ => value.as_f64()?,
        };
        if !number.is_finite() {
            return None;
        }
        result[position] = number;
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn size(width: u32, height: u32) -> ImageSize {
        ImageSize {
            width: width.try_into().unwrap(),
            height: height.try_into().unwrap(),
        }
    }

    #[test]
    fn square_crop_centers_by_default_and_clamps_requested_coordinates() {
        assert_eq!(
            square(size(101, 60), &Value::Null),
            Crop {
                x: 20,
                y: 0,
                width: 60,
                height: 60
            }
        );
        assert_eq!(
            square(size(101, 60), &json!({"x":"100","y":-1,"size":20.9})),
            Crop {
                x: 81,
                y: 0,
                width: 20,
                height: 20
            }
        );
    }

    #[test]
    fn cover_crop_uses_focal_point_zoom_and_explicit_overrides() {
        let zoom = CoverZoom::parse(&json!(2)).unwrap();
        let source = size(1200, 600);
        let target = size(2400, 900);
        let focal = focal_point(&json!({"x":1.3,"y":0}));
        assert_eq!(
            cover(source, target, focal, &Value::Null, zoom),
            Crop {
                x: 600,
                y: 0,
                width: 600,
                height: 225
            }
        );
        assert_eq!(
            cover(
                source,
                target,
                focal,
                &json!({"x":-3,"y":590,"width":300,"height":100}),
                zoom
            ),
            Crop {
                x: 0,
                y: 500,
                width: 300,
                height: 100
            }
        );
        assert!(CoverZoom::parse(&json!(3.1)).is_none());
        assert!(CoverZoom::parse(&json!("2")).is_none());
    }
}
