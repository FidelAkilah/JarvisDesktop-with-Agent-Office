# JARVIS desktop app (Phase 2 — not yet built)

Electron shell hosting the HUD (HTML/CSS/SVG/Canvas) and the pixel office
(PixiJS v8), with tray icon, global hotkey (push-to-talk fallback), and
lifecycle management for the two sidecar services (agent on 4777, voice on
4778). Electron chosen over Tauri because the brain (Claude Agent SDK) is
Node — one runtime, no Rust toolchain. See vault `System/DECISIONS.md`.
