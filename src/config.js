import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

export const config = {
  port: Number(process.env.DUMBTV_PORT || 8080),
  host: process.env.DUMBTV_HOST || '0.0.0.0',

  dbPath: process.env.DUMBTV_DB || path.join(ROOT, 'data', 'dumbtv.db'),
  mediaDir: process.env.DUMBTV_MEDIA || path.join(ROOT, 'media'),
  publicDir: path.join(ROOT, 'public'),

  // How far ahead the schedule is built, in days.
  scheduleWindowDays: Number(process.env.DUMBTV_WINDOW_DAYS || 14),

  // Player driver: 'mpv' drives a real window, 'none' runs headless
  // (config + browser TV view only).
  playerDriver: process.env.DUMBTV_PLAYER || 'mpv',
  mpvBinary: process.env.DUMBTV_MPV || 'mpv',
  mpvSocket:
    process.env.DUMBTV_MPV_SOCKET ||
    path.join(os.tmpdir(), `dumbtv-mpv-${process.pid}.sock`),
  mpvFullscreen: process.env.DUMBTV_FULLSCREEN !== '0',
  // Extra mpv flags (space-separated). On a console Pi (no desktop), render to
  // HDMI via DRM: DUMBTV_MPV_ARGS="--vo=gpu --gpu-context=drm"
  mpvExtraArgs: (process.env.DUMBTV_MPV_ARGS || '').split(' ').map((s) => s.trim()).filter(Boolean),

  // How often the engine re-checks what should be on air. 1s feels live
  // and costs nothing — it's one indexed SQLite read per channel.
  tickMs: Number(process.env.DUMBTV_TICK_MS || 1000),

  clientIdentifier: process.env.DUMBTV_CLIENT_ID || 'dumbtv-retro-cable-box',
  productName: 'dumbTV',
  productVersion: '0.1.0',

  // Optional LLM assist. Off unless a base URL is set. OpenAI-compatible, so it
  // works with Ollama (default host below), LM Studio, or any hosted endpoint.
  // Never in the critical path — it only proposes; a human applies.
  llm: {
    baseUrl: process.env.DUMBTV_LLM_URL || null, // e.g. http://localhost:11434/v1
    model: process.env.DUMBTV_LLM_MODEL || 'llama3.1',
    apiKey: process.env.DUMBTV_LLM_KEY || null,
  },
};

export const PLEX_HEADERS = {
  'X-Plex-Product': config.productName,
  'X-Plex-Version': config.productVersion,
  'X-Plex-Client-Identifier': config.clientIdentifier,
  'X-Plex-Platform': os.type(),
  'X-Plex-Device': 'dumbTV Cable Box',
  'X-Plex-Device-Name': os.hostname(),
  Accept: 'application/json',
};
