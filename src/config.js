import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

export const config = {
  port: Number(process.env.CATHODE_PORT || 8080),
  host: process.env.CATHODE_HOST || '0.0.0.0',

  dbPath: process.env.CATHODE_DB || path.join(ROOT, 'data', 'cathode.db'),
  mediaDir: process.env.CATHODE_MEDIA || path.join(ROOT, 'media'),
  publicDir: path.join(ROOT, 'public'),

  // How far ahead the schedule is built, in days.
  scheduleWindowDays: Number(process.env.CATHODE_WINDOW_DAYS || 14),

  // Player driver: 'mpv' drives a real window, 'none' runs headless
  // (config + browser TV view only).
  playerDriver: process.env.CATHODE_PLAYER || 'mpv',
  mpvBinary: process.env.CATHODE_MPV || 'mpv',
  mpvSocket:
    process.env.CATHODE_MPV_SOCKET ||
    path.join(os.tmpdir(), `cathode-mpv-${process.pid}.sock`),
  mpvFullscreen: process.env.CATHODE_FULLSCREEN !== '0',

  // How often the engine re-checks what should be on air. 1s feels live
  // and costs nothing — it's one indexed SQLite read per channel.
  tickMs: Number(process.env.CATHODE_TICK_MS || 1000),

  clientIdentifier: process.env.CATHODE_CLIENT_ID || 'cathode-retro-cable-box',
  productName: 'Cathode',
  productVersion: '0.1.0',

  // Optional LLM assist. Off unless a base URL is set. OpenAI-compatible, so it
  // works with Ollama (default host below), LM Studio, or any hosted endpoint.
  // Never in the critical path — it only proposes; a human applies.
  llm: {
    baseUrl: process.env.CATHODE_LLM_URL || null, // e.g. http://localhost:11434/v1
    model: process.env.CATHODE_LLM_MODEL || 'llama3.1',
    apiKey: process.env.CATHODE_LLM_KEY || null,
  },
};

export const PLEX_HEADERS = {
  'X-Plex-Product': config.productName,
  'X-Plex-Version': config.productVersion,
  'X-Plex-Client-Identifier': config.clientIdentifier,
  'X-Plex-Platform': os.type(),
  'X-Plex-Device': 'Cathode Cable Box',
  'X-Plex-Device-Name': os.hostname(),
  Accept: 'application/json',
};
