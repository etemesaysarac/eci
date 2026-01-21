import { promises as fs } from "fs";
import path from "path";

export type StoredObjectMeta = {
  key: string;          // relative key (posix-like)
  absolutePath: string; // absolute filesystem path
  bytes: number;
  contentType: string;
  filename: string;
};

export type StoredObject = StoredObjectMeta & { buffer: Buffer };

function safeSegment(seg: string): string {
  const s = String(seg ?? "").trim();
  if (!s) return "x";
  // keep it boring: alnum + _-. only
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180) || "x";
}

function normalizeKey(key: string): string {
  // Always store keys in a stable, forward-slash form
  return key.replace(/\\/g, "/").replace(/^\/+/, "");
}

function resolveBaseDir(): string {
  // Default: services/core/outputs
  const raw = process.env.ECI_STORAGE_DIR?.trim();
  if (raw) return path.resolve(raw);
  return path.resolve(process.cwd(), "outputs");
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function ensureWithinBase(base: string, target: string) {
  const rel = path.relative(base, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("invalid storage path");
  }
}

async function writeFileAtomic(filePath: string, buf: Buffer) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmp = filePath + ".tmp_" + Date.now();
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, filePath);
}

export const storage = {
  baseDir: resolveBaseDir(),

  safeFileName(name: string) {
    return safeSegment(name);
  },

  async putBuffer(opts: {
    prefix: string;
    filename: string;
    contentType: string;
    buffer: Buffer;
  }): Promise<StoredObjectMeta> {
    const base = storage.baseDir;
    const prefix = normalizeKey(opts.prefix || "");
    const filename = safeSegment(opts.filename || "file.bin");

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const key = normalizeKey(path.posix.join(prefix, `${stamp}_${filename}`));

    const abs = path.resolve(base, key);
    ensureWithinBase(base, abs);

    await writeFileAtomic(abs, opts.buffer);

    return {
      key,
      absolutePath: abs,
      bytes: opts.buffer.length,
      contentType: opts.contentType || "application/octet-stream",
      filename,
    };
  },

  async putText(opts: {
    prefix: string;
    filename: string;
    contentType?: string;
    text: string;
  }): Promise<StoredObjectMeta> {
    const buf = Buffer.from(opts.text ?? "", "utf8");
    return storage.putBuffer({
      prefix: opts.prefix,
      filename: opts.filename,
      contentType: opts.contentType ?? "text/plain; charset=utf-8",
      buffer: buf,
    });
  },

  async getBuffer(key: string): Promise<StoredObject> {
    const base = storage.baseDir;
    const k = normalizeKey(key);
    const abs = path.resolve(base, k);
    ensureWithinBase(base, abs);

    const buffer = await fs.readFile(abs);
    const filename = path.basename(abs);

    // contentType burada “best effort” (server tarafında download endpoint gerekirse override edebilir)
    const contentType = filename.endsWith(".pdf")
      ? "application/pdf"
      : filename.endsWith(".png")
        ? "image/png"
        : filename.endsWith(".jpg") || filename.endsWith(".jpeg")
          ? "image/jpeg"
          : filename.endsWith(".zpl")
            ? "text/plain; charset=utf-8"
            : "application/octet-stream";

    return {
      key: k,
      absolutePath: abs,
      bytes: buffer.length,
      contentType,
      filename,
      buffer,
    };
  },
};
