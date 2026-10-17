class GifEncoder {
  constructor(width, height, delayMs = 100) {
    this.width = width;
    this.height = height;
    this.delay = Math.round(delayMs / 10); // 1/100ths of a second
    this.frames = [];
  }

  addFrame(ctx) {
    const imgData = ctx.getImageData(0, 0, this.width, this.height);
    this.frames.push(imgData.data);
  }

  finish() {
    const bytes = [];

    // Header: GIF89a
    this.writeString(bytes, 'GIF89a');

    // Logical Screen Descriptor
    this.writeShort(bytes, this.width);
    this.writeShort(bytes, this.height);
    bytes.push(0xF7); // Global color table flag (8-bit, 256 colors)
    bytes.push(0);    // Background color index
    bytes.push(0);    // Pixel aspect ratio

    // Global Color Table (6x6x6 color cube + grayscale ramp = 256 colors)
    const palette = this.createStandardPalette();
    for (let i = 0; i < 256; i++) {
      bytes.push(palette[i * 3]);
      bytes.push(palette[i * 3 + 1]);
      bytes.push(palette[i * 3 + 2]);
    }

    // Netscape Looping Application Extension (무한 반복)
    bytes.push(0x21); // Extension Introducer
    bytes.push(0xFF); // Application Extension Label
    bytes.push(0x0B); // Block Size (11 bytes)
    this.writeString(bytes, 'NETSCAPE2.0');
    bytes.push(0x03); // Sub-block size
    bytes.push(0x01); // Loop sub-block ID
    this.writeShort(bytes, 0); // Loop count (0 = infinite)
    bytes.push(0x00); // Block Terminator

    // Write Each Frame
    for (let f = 0; f < this.frames.length; f++) {
      const data = this.frames[f];

      // Graphic Control Extension
      bytes.push(0x21); // Extension Introducer
      bytes.push(0xF9); // Graphic Control Label
      bytes.push(0x04); // Byte Size
      bytes.push(0x04); // Packed: restore to previous / disposal 1
      this.writeShort(bytes, this.delay);
      bytes.push(0x00); // Transparent color index
      bytes.push(0x00); // Block Terminator

      // Image Descriptor
      bytes.push(0x2C); // Image Separator
      this.writeShort(bytes, 0); // Image Left
      this.writeShort(bytes, 0); // Image Top
      this.writeShort(bytes, this.width);
      this.writeShort(bytes, this.height);
      bytes.push(0x00); // Packed fields (no local color table)

      // Quantize frame pixels to palette indices
      const indexedPixels = new Uint8Array(this.width * this.height);
      for (let p = 0; p < indexedPixels.length; p++) {
        const r = data[p * 4];
        const g = data[p * 4 + 1];
        const b = data[p * 4 + 2];
        indexedPixels[p] = this.findClosestPaletteIndex(r, g, b);
      }

      // LZW Compress and write
      this.writeLZW(bytes, indexedPixels, 8);
    }

    // GIF Trailer
    bytes.push(0x3B);

    return new Blob([new Uint8Array(bytes)], { type: 'image/gif' });
  }

  createStandardPalette() {
    const p = new Uint8Array(256 * 3);
    let idx = 0;
    // 6x6x6 color cube (216 colors)
    for (let r = 0; r < 6; r++) {
      for (let g = 0; g < 6; g++) {
        for (let b = 0; b < 6; b++) {
          p[idx++] = Math.round(r * 255 / 5);
          p[idx++] = Math.round(g * 255 / 5);
          p[idx++] = Math.round(b * 255 / 5);
        }
      }
    }
    // 40 step grayscale ramp
    for (let i = 0; i < 40; i++) {
      const gray = Math.round(i * 255 / 39);
      p[idx++] = gray;
      p[idx++] = gray;
      p[idx++] = gray;
    }
    return p;
  }

  findClosestPaletteIndex(r, g, b) {
    const rIdx = Math.round(r * 5 / 255);
    const gIdx = Math.round(g * 5 / 255);
    const bIdx = Math.round(b * 5 / 255);
    return (rIdx * 36) + (gIdx * 6) + bIdx;
  }

  writeString(arr, str) {
    for (let i = 0; i < str.length; i++) {
      arr.push(str.charCodeAt(i));
    }
  }

  writeShort(arr, num) {
    arr.push(num & 0xFF);
    arr.push((num >> 8) & 0xFF);
  }

  writeLZW(arr, indexedPixels, minCodeSize) {
    arr.push(minCodeSize);

    const clearCode = 1 << minCodeSize; // 256
    const eoiCode = clearCode + 1;      // 257

    let curCodeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;

    let dict = new Map();
    const resetDict = () => {
      dict.clear();
      curCodeSize = minCodeSize + 1;
      nextCode = eoiCode + 1;
    };

    let accum = 0;
    let accumBits = 0;
    const packet = [];

    const flushPacket = () => {
      if (packet.length > 0) {
        arr.push(packet.length);
        for (let i = 0; i < packet.length; i++) {
          arr.push(packet[i]);
        }
        packet.length = 0;
      }
    };

    const outputCode = (code) => {
      accum |= (code << accumBits);
      accumBits += curCodeSize;
      while (accumBits >= 8) {
        packet.push(accum & 0xFF);
        accum >>= 8;
        accumBits -= 8;
        if (packet.length === 254) {
          flushPacket();
        }
      }
    };

    outputCode(clearCode);

    let prefix = indexedPixels[0];
    for (let i = 1; i < indexedPixels.length; i++) {
      const k = indexedPixels[i];
      const key = (prefix << 8) | k;
      if (dict.has(key)) {
        prefix = dict.get(key);
      } else {
        outputCode(prefix);
        if (nextCode < 4096) {
          dict.set(key, nextCode++);
          if (nextCode === (1 << curCodeSize) && curCodeSize < 12) {
            curCodeSize++;
          }
        } else {
          outputCode(clearCode);
          resetDict();
        }
        prefix = k;
      }
    }
    outputCode(prefix);
    outputCode(eoiCode);

    if (accumBits > 0) {
      packet.push(accum & 0xFF);
    }
    flushPacket();
    arr.push(0x00); // Sub-block terminator
  }
}
