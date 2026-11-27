//! Vimeo provider requests for Rust workers.

pub mod upload;
pub mod video;

pub type Error = Box<dyn std::error::Error + Send + Sync + 'static>;
