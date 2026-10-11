use serde::{Deserialize, Serialize};
use std::path::Path;

/// 持久设置由 Host 持有；WebView 只接收不含密钥的设备开关。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VoiceSettings {
    pub enabled: bool,
    pub prewarm: bool,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            prewarm: true,
        }
    }
}

pub fn load(path: &Path) -> Result<VoiceSettings, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "invalid voice settings".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(VoiceSettings::default()),
        Err(_) => Err("voice settings unavailable".into()),
    }
}

pub fn save(path: &Path, settings: &VoiceSettings) -> Result<(), String> {
    let bytes = serde_json::to_vec(settings).map_err(|_| "invalid voice settings")?;
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, bytes).map_err(|_| "cannot save voice settings")?;
    std::fs::rename(temporary, path).map_err(|_| "cannot replace voice settings".into())
}

pub fn valid_timing(stage: &str, duration_ms: f64) -> bool {
    duration_ms.is_finite()
        && (0.0..=3_600_000.0).contains(&duration_ms)
        && [
            "client.device_ready",
            "client.press_to_first_sample",
            "client.press_to_first_send",
            "client.release_to_final_transcript",
            "client.release_to_first_segment",
            "client.release_to_tts_ready",
            "client.release_to_first_answer_playback",
            "client.release_to_first_text_ready",
            "stt.total",
            "stt.final",
            "session.ready",
            "model.first_delta",
            "speech.first_sentence_ready",
            "tts.answer.first_audio",
            "tts.answer.completed",
        ]
        .contains(&stage)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_settings_and_defaults() {
        let default = VoiceSettings::default();
        assert!(default.enabled && default.prewarm);
        assert!(
            serde_json::from_str::<VoiceSettings>(r#"{"enabled":true,"prewarm":"yes"}"#).is_err()
        );
        assert!(serde_json::from_str::<VoiceSettings>(
            r#"{"enabled":true,"prewarm":true,"apiKey":"unexpected"}"#
        )
        .is_err());
    }

    #[test]
    fn settings_roundtrip_and_invalid_timing() {
        let path =
            std::env::temp_dir().join(format!("semi-os-settings-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        assert!(load(&path).unwrap().prewarm);
        save(
            &path,
            &VoiceSettings {
                enabled: true,
                prewarm: false,
            },
        )
        .unwrap();
        assert!(!load(&path).unwrap().prewarm);
        std::fs::write(&path, b"broken").unwrap();
        assert!(load(&path).is_err());
        std::fs::remove_file(&path).unwrap();
        assert!(valid_timing("stt.final", 100.0));
        assert!(!valid_timing("arbitrary", 100.0));
        assert!(!valid_timing("stt.final", f64::NAN));
        assert!(!valid_timing("stt.final", -1.0));
    }
}
