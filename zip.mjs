/**
 * 极简 ZIP 流式写入器（store 模式，不压缩、不支持 zip64）
 *
 * 为什么自己写：项目零依赖，而 Node 没有内置 zip 写出能力。
 * 产物多是 mp4（本身已压缩），store 模式的体积损失可忽略。
 *
 * 用法：
 *   const zip = new ZipStream(res);
 *   await zip.addStream('a.mp4', 1234, () => Readable.fromWeb(fetchRes.body));
 *   await zip.finish();
 *   res.end();
 */
import { Readable } from 'node:stream';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(buf, prev = 0) {
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const FLAG_UTF8 = 0x0800;
const FLAG_DESCRIPTOR = 0x0008;

export class ZipStream {
  constructor(out) {
    this.out = out;
    this.offset = 0;
    this.entries = [];
    this.finished = false;
  }

  _write(buf) {
    this.offset += buf.length;
    return new Promise((resolve, reject) => {
      if (this.out.write(buf)) resolve();
      else this.out.once('drain', resolve);
      this.out.once('error', reject);
    });
  }

  /** 加一个文件；producer() 返回可读流。size 仅用于进度展示，可为 0 */
  async addStream(name, size, producer) {
    const nameBuf = Buffer.from(String(name).replace(/[\u0000-\u001f]/g, ''), 'utf8');
    const localOffset = this.offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);                       // version needed
    header.writeUInt16LE(FLAG_UTF8 | FLAG_DESCRIPTOR, 6);
    header.writeUInt16LE(0, 8);                        // store
    header.writeUInt16LE(0, 10);                       // mod time
    header.writeUInt16LE(0x21, 12);                    // mod date = 1980-01-01
    header.writeUInt32LE(0, 14);                       // crc（稍后由数据描述符给出）
    header.writeUInt32LE(0, 18);
    header.writeUInt32LE(0, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    await this._write(header);
    await this._write(nameBuf);

    let crc = 0;
    let written = 0;
    const stream = await producer();
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      crc = crc32(buf, crc);
      written += buf.length;
      await this._write(buf);
    }

    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc >>> 0, 4);
    desc.writeUInt32LE(written, 8);
    desc.writeUInt32LE(written, 12);
    await this._write(desc);

    this.entries.push({ nameBuf, crc: crc >>> 0, size: written, offset: localOffset });
    return written;
  }

  async finish() {
    if (this.finished) return;
    this.finished = true;
    const start = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);                          // version made by
      h.writeUInt16LE(20, 6);                          // version needed
      h.writeUInt16LE(FLAG_UTF8 | FLAG_DESCRIPTOR, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(0, 12);
      h.writeUInt16LE(0x21, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.size, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt16LE(0, 30);
      h.writeUInt16LE(0, 32);
      h.writeUInt16LE(0, 34);
      h.writeUInt16LE(0, 36);
      h.writeUInt32LE(0, 38);
      h.writeUInt32LE(e.offset, 42);
      await this._write(h);
      await this._write(e.nameBuf);
    }
    const cdSize = this.offset - start;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(start, 16);
    end.writeUInt16LE(0, 20);
    await this._write(end);
  }
}

/** 把远端 URL 变成可读流（下载失败抛错） */
export async function streamRemote(url, timeoutMs = 600000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  return Readable.fromWeb(res.body);
}
