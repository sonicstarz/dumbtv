import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';

/**
 * Thin wrapper around mpv's JSON IPC socket.
 *
 * mpv is not an implementation detail — it is the reason this works. It seeks
 * into a remote file instantly, plays whatever Plex hands it without
 * transcoding, and draws overlays natively. Nothing else does all three.
 */
export class MpvPlayer extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.sock = null;
    this.reqId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.ready = false;
    this.lastError = null;
  }

  async start() {
    if (this.proc) return;

    try {
      fs.unlinkSync(config.mpvSocket);
    } catch {
      /* nothing to clean up */
    }

    const args = [
      `--input-ipc-server=${config.mpvSocket}`,
      '--idle=yes',
      '--force-window=yes',
      '--keep-open=no',
      '--no-osc',
      '--no-input-default-bindings',
      '--osd-level=0',
      '--cache=yes',
      '--demuxer-max-bytes=64MiB',
      '--hr-seek=yes',
      '--hr-seek-framedrop=yes',
      '--msg-level=all=warn',
    ];
    if (config.mpvFullscreen) args.push('--fullscreen');

    this.proc = spawn(config.mpvBinary, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    this.proc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) this.emit('log', msg);
    });

    this.proc.on('error', (err) => {
      this.lastError =
        err.code === 'ENOENT'
          ? 'mpv is not installed or not on PATH. Install it, or run with DUMBTV_PLAYER=none.'
          : err.message;
      this.emit('error', new Error(this.lastError));
    });

    this.proc.on('exit', (code) => {
      this.ready = false;
      this.sock = null;
      this.proc = null;
      this.emit('exit', code);
    });

    await this.#connect();
  }

  async #connect(attempt = 0) {
    if (attempt > 40) throw new Error('mpv never opened its IPC socket');
    await new Promise((r) => setTimeout(r, 100));

    return new Promise((resolve, reject) => {
      const sock = net.connect(config.mpvSocket);
      sock.on('connect', () => {
        this.sock = sock;
        this.ready = true;
        sock.on('data', (d) => this.#onData(d));
        sock.on('close', () => {
          this.ready = false;
          this.sock = null;
        });
        this.command('observe_property', 1, 'eof-reached').catch(() => {});
        this.emit('ready');
        resolve();
      });
      sock.on('error', () => {
        sock.destroy();
        this.#connect(attempt + 1).then(resolve, reject);
      });
    });
  }

  #onData(chunk) {
    this.buffer += chunk.toString();
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.request_id && this.pending.has(msg.request_id)) {
        const { resolve, reject } = this.pending.get(msg.request_id);
        this.pending.delete(msg.request_id);
        msg.error === 'success' ? resolve(msg.data) : reject(new Error(msg.error));
      } else if (msg.event) {
        this.emit('mpv-event', msg);
        this.emit(msg.event, msg);
      }
    }
  }

  command(...args) {
    if (!this.sock || !this.ready) {
      return Promise.reject(new Error('mpv is not connected'));
    }
    const id = this.reqId++;
    const payload = JSON.stringify({ command: args, request_id: id }) + '\n';
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock.write(payload);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('mpv command timed out'));
        }
      }, 5000);
    });
  }

  /**
   * Load a file and land at `offsetSec`.
   * The start option is passed on load (fast path) and a corrective seek runs
   * after the file opens, because option syntax moved between mpv releases and
   * we would rather be right than clever.
   */
  async play(url, offsetSec = 0) {
    const off = Math.max(0, Math.floor(offsetSec));
    try {
      await this.command('loadfile', url, 'replace', 0, { start: String(off) });
    } catch {
      try {
        await this.command('loadfile', url, 'replace', { start: String(off) });
      } catch {
        await this.command('loadfile', url, 'replace');
      }
    }
    if (off > 0) {
      const correct = async () => {
        try {
          const pos = await this.command('get_property', 'playback-time');
          if (typeof pos === 'number' && Math.abs(pos - off) > 3) {
            await this.command('seek', off, 'absolute+exact');
          }
        } catch {
          /* file may have moved on already */
        }
      };
      setTimeout(correct, 600);
    }
    await this.setProperty('pause', false);
  }

  /**
   * Make the mpv window act like a cable box front panel. Each key fires a
   * script-message, which mpv broadcasts back as a `client-message` event the
   * engine listens for. This is the only path a FLIRC remote (a USB keyboard)
   * has into the schedule, so it matters as much as the browser handler does.
   */
  async bindKeys() {
    const msg = (...a) => `script-message dumbtv-key ${a.join(' ')}`;
    const binds = [];
    // 0 and 2-9 tune; 1 opens the program guide.
    for (let d = 0; d <= 9; d++) binds.push([String(d), d === 1 ? msg('guide') : msg('digit', d)]);
    // Arrows carry a direction; the engine decides surf vs guide-navigation.
    binds.push(['UP', msg('arrow', 'up')]);
    binds.push(['DOWN', msg('arrow', 'down')]);
    binds.push(['LEFT', msg('arrow', 'left')]);
    binds.push(['RIGHT', msg('arrow', 'right')]);
    binds.push(['ENTER', msg('enter')]);
    // Captions toggle.
    binds.push(['c', msg('captions')]);
    binds.push(['C', msg('captions')]);
    // No pausing, no seeking (invariant #1). These flash ⊘ and do nothing.
    for (const k of ['SPACE', 'k', 'j', 'l']) {
      binds.push([k, msg('blocked')]);
    }
    for (const [key, command] of binds) {
      await this.command('keybind', key, command).catch(() => {});
    }
  }

  /**
   * Shrink the live picture into the top-left corner (for the guide) or restore
   * it to full screen. The video keeps playing either way.
   */
  async setVideoRegion(on) {
    const right = on ? 0.55 : 0;
    const bottom = on ? 0.6 : 0;
    await this.setProperty('video-margin-ratio-right', right).catch(() => {});
    await this.setProperty('video-margin-ratio-bottom', bottom).catch(() => {});
  }

  async stop() {
    try {
      await this.command('stop');
    } catch {
      /* already stopped */
    }
  }

  setProperty(name, value) {
    return this.command('set_property', name, value);
  }

  getProperty(name) {
    return this.command('get_property', name);
  }

  /** Draw an ASS overlay. This is how the channel banner and guide are shown. */
  async showOverlay(id, assText, resX = 1280, resY = 720) {
    return this.command('osd-overlay', id, 'ass-events', assText, resX, resY, 0);
  }

  async clearOverlay(id) {
    return this.command('osd-overlay', id, 'none', '', 1280, 720, 0);
  }

  async quit() {
    try {
      await this.command('quit');
    } catch {
      if (this.proc) this.proc.kill();
    }
  }
}
