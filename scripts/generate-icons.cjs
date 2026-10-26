'use strict';
// Original document + rising arrow mark. Minimal PNG writer, no graphics dependency.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const label = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([label, data])));
  return Buffer.concat([length, label, data, crc]);
}
for (const size of [16, 32, 48, 128]) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + .5) / size, v = (y + .5) / size;
    let color = [26, 81, 67, 255];
    const rounded = Math.hypot(Math.max(.16 - u, 0, u - .84), Math.max(.16 - v, 0, v - .84)) > .145;
    if (rounded) color = [0, 0, 0, 0];
    if (u > .25 && u < .66 && v > .2 && v < .8) color = [239, 244, 225, 255];
    if (u > .33 && u < .55 && ((v > .35 && v < .39) || (v > .47 && v < .51) || (v > .59 && v < .63))) color = [111, 145, 109, 255];
    if ((u > .69 && u < .77 && v > .33 && v < .72) ||
        (v > .27 && v < .49 && Math.abs(u - .73) < (.49 - v) * .7)) color = [174, 211, 139, 255];
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    rows.set(color, offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  fs.writeFileSync(path.join(__dirname, '..', 'extension', 'icons', `icon${size}.png`), Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))
  ]));
}
