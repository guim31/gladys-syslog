// -----------------------------------------------------------------------------
// Syslog over TCP (RFC 6587): a stream of frames, either "octet counting"
// (`<length> <message>`, rsyslog with `TCP_Framing="octet-counted"`, RFC 5425)
// or "non-transparent framing" (one message per line, ended by LF — or NUL,
// sent by some appliances). Both are detected per frame: an octet-counted
// frame starts with a digit, a message starts with `<`.
//
// A frame longer than `maxFrame` is skipped up to its end, never buffered: a
// sender cannot make the receiver hold more than `maxFrame` bytes per socket.
// -----------------------------------------------------------------------------

export const MAX_FRAME = 8192;

export class TcpFramer {
  /**
   * @param {(frame: Buffer) => void} onFrame
   * @param {{ maxFrame?: number, onOversized?: () => void }} [options]
   */
  constructor(onFrame, { maxFrame = MAX_FRAME, onOversized = () => {} } = {}) {
    this.onFrame = onFrame;
    this.maxFrame = maxFrame;
    this.onOversized = onOversized;
    this.buffer = Buffer.alloc(0);
    // Bytes still to skip of an oversized octet-counted frame.
    this.skipBytes = 0;
    // True while skipping the rest of an oversized line.
    this.skipLine = false;
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length > 0) {
      if (this.skipBytes > 0) {
        const n = Math.min(this.skipBytes, this.buffer.length);
        this.skipBytes -= n;
        this.buffer = this.buffer.subarray(n);
        continue;
      }
      if (this.skipLine) {
        const end = this.lineEnd();
        if (end < 0) {
          this.buffer = Buffer.alloc(0);
          return;
        }
        this.skipLine = false;
        this.buffer = this.buffer.subarray(end + 1);
        continue;
      }
      const first = this.buffer[0];
      if (first >= 0x30 && first <= 0x39) {
        if (!this.octetCounted()) {
          return;
        }
      } else if (!this.line()) {
        return;
      }
    }
  }

  lineEnd() {
    const lf = this.buffer.indexOf(0x0a);
    const nul = this.buffer.indexOf(0x00);
    if (lf < 0) return nul;
    if (nul < 0) return lf;
    return Math.min(lf, nul);
  }

  /** @returns {boolean} false when more bytes are needed */
  octetCounted() {
    const space = this.buffer.indexOf(0x20);
    const header = this.buffer.subarray(0, space < 0 ? this.buffer.length : space);
    if (!/^\d+$/.test(header.toString('latin1')) || header.length > 7) {
      // Not a length after all: a line that happens to start with a digit.
      return this.line();
    }
    if (space < 0) {
      return false;
    }
    const length = Number(header.toString('latin1'));
    const start = space + 1;
    if (length > this.maxFrame) {
      this.onOversized();
      this.buffer = this.buffer.subarray(start);
      this.skipBytes = length;
      return true;
    }
    if (this.buffer.length < start + length) {
      return false;
    }
    const frame = this.buffer.subarray(start, start + length);
    this.buffer = this.buffer.subarray(start + length);
    this.onFrame(frame);
    return true;
  }

  /** @returns {boolean} false when more bytes are needed */
  line() {
    const end = this.lineEnd();
    if (end < 0) {
      if (this.buffer.length > this.maxFrame) {
        this.onOversized();
        this.buffer = Buffer.alloc(0);
        this.skipLine = true;
        return true;
      }
      return false;
    }
    if (end > this.maxFrame) {
      this.onOversized();
    } else if (end > 0) {
      this.onFrame(this.buffer.subarray(0, end));
    }
    this.buffer = this.buffer.subarray(end + 1);
    return true;
  }
}
