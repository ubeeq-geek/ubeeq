//! FFmpeg process helpers for local MP4, QuickTime, and Matroska media.

use serde_json::Value;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

pub type Error = Box<dyn std::error::Error + Send + Sync + 'static>;

const TOOL_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PROBE_BYTES: u64 = 4 * 1024 * 1024;

/// Reads raw stream and container metadata from a local media file.
pub async fn probe(ffprobe: &Path, input: &Path) -> Result<Value, Error> {
    let format = input_format(input)?;
    let mut command = Command::new(ffprobe);
    command
        .args([
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-f",
            format,
            "-show_format",
            "-show_streams",
            "-of",
            "json",
        ])
        .arg(input);
    let output = bounded_output(command, MAX_PROBE_BYTES).await?;
    Ok(serde_json::from_slice(&output)?)
}

/// Extracts one JPEG frame, removing input metadata.
pub async fn extract_jpeg_frame(
    ffmpeg: &Path,
    input: &Path,
    timestamp_ms: u64,
    max_width: u32,
    max_bytes: u64,
) -> Result<Vec<u8>, Error> {
    let format = input_format(input)?;
    let seconds = format!("{}.{:03}", timestamp_ms / 1000, timestamp_ms % 1000);
    let scale = format!(r"scale=min({max_width}\,iw):-2");
    let mut command = Command::new(ffmpeg);
    command
        .args([
            "-nostdin",
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-f",
            format,
            "-ss",
            &seconds,
            "-i",
        ])
        .arg(input)
        .args([
            "-frames:v",
            "1",
            "-map_metadata",
            "-1",
            "-vf",
            &scale,
            "-q:v",
            "3",
            "-c:v",
            "mjpeg",
            "-f",
            "image2pipe",
            "pipe:1",
        ]);
    let bytes = bounded_output(command, max_bytes).await?;
    if !bytes.starts_with(&[0xff, 0xd8]) || !bytes.ends_with(&[0xff, 0xd9]) {
        return Err("Video tool did not return a complete JPEG".into());
    }
    Ok(bytes)
}

/// Detects the demuxer for an absolute local media path from its file signature.
pub fn input_format(input: &Path) -> Result<&'static str, Error> {
    use std::io::Read;
    if !input.is_absolute() {
        return Err("Video tools require an absolute input path".into());
    }
    let mut header = [0; 12];
    std::fs::File::open(input)?.read_exact(&mut header)?;
    if header.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return Ok("matroska");
    }
    // The MOV demuxer handles all of these ISO BMFF and QuickTime atom types.
    if [
        b"ftyp", b"moov", b"mdat", b"free", b"skip", b"wide", b"pnot", b"uuid",
    ]
    .contains(&header[4..8].try_into()?)
    {
        return Ok("mov");
    }
    Err("Unsupported video file header".into())
}

/// Runs an absolute executable with a 30-second timeout and a bounded stdout stream.
pub async fn bounded_output(mut command: Command, limit: u64) -> Result<Vec<u8>, Error> {
    if !Path::new(command.as_std().get_program()).is_absolute() {
        return Err("Video tools require absolute executable paths".into());
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    tokio::time::timeout(TOOL_TIMEOUT, async {
        let stdout = child.stdout.take().ok_or("Missing video tool output")?;
        let mut bytes = Vec::new();
        stdout
            .take(limit.saturating_add(1))
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() as u64 > limit {
            return Err("Video tool output exceeded its limit".into());
        }
        if !child.wait().await?.success() {
            return Err("Video tool failed".into());
        }
        Ok(bytes)
    })
    .await?
}

#[cfg(unix)]
#[cfg(test)]
mod process_tests {
    use super::*;

    #[tokio::test]
    async fn enforces_output_and_exit_status() {
        let command = |script: &str| {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", script]);
            command
        };
        assert_eq!(
            bounded_output(command("printf data"), 4).await.unwrap(),
            b"data"
        );
        assert!(bounded_output(command("printf extra"), 4).await.is_err());
        assert!(bounded_output(command("exit 1"), 4).await.is_err());
    }
}
