import { SOURCE_DESCRIPTOR_MAX_BYTES } from "./source-descriptors.js";
import { RECORD_MAX_BYTES, AUXILIARY_MAX_BYTES } from "./limits.js";
import * as fs from "node:fs";
import path from "node:path";
import { digest, MAX_ENTRIES } from "./vault.js";

export type PublicationRole = "record" | "auxiliary" | "source-descriptor";
/** Classify only canonical destinations; retained names inherit their destination role. */
export function publicationRole(relative: string): PublicationRole {
  if (/\/artifacts\/sources\/[^/]+\.json$/.test(relative)) return "source-descriptor";
  if (relative.endsWith(".md") && !relative.includes("/artifacts/") && !relative.includes("/.knowledge-history/")) return "record";
  return "auxiliary";
}
const byteLimit = (role: PublicationRole) => role === "record" ? RECORD_MAX_BYTES : role === "source-descriptor" ? SOURCE_DESCRIPTOR_MAX_BYTES : AUXILIARY_MAX_BYTES;

/** Synchronous file operations keep the SQLite publisher fence held throughout
 * each filesystem boundary. No user path is accepted by the mutation API. */
export class PublicationFiles {
  readonly root: string;
  private readonly stamp: string;
  constructor(root: string) {
    this.root = fs.realpathSync(root);
    if (fs.lstatSync(root).isSymbolicLink()) throw Error("Unsafe vault root");
    this.stamp = this.identity();
  }
  identity() { const s = fs.lstatSync(this.root); return `${s.dev}:${s.ino}`; }
  guard(relative: string, mkdir = false): string {
    if (this.identity() !== this.stamp || fs.realpathSync(this.root) !== this.root) throw Error("Vault root changed");
    const parts = relative.split("/");
    if (!parts.length || parts.some(p => !p || p === "." || p === ".." || /[\\\x00-\x1f]/.test(p))) throw Error("Unsafe publication path");
    let current = this.root;
    for (const part of parts.slice(0, -1)) {
      const parent = current; current = path.join(current, part);
      if (mkdir) { try { fs.mkdirSync(current, { mode: 0o700 }); this.sync(parent); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; } }
      const s = fs.lstatSync(current);
      if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync(current) !== current) throw Error("Unsafe publication directory");
    }
    return path.join(this.root, relative);
  }
  read(relative: string, allowRetainedLink = false, role = publicationRole(relative)): string | null {
    const maxBytes = byteLimit(role);
    let filename: string;
    try { filename = this.guard(relative); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    let before: fs.Stats;
    try { before = fs.lstatSync(filename); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    if (!before.isFile() || before.isSymbolicLink() || (!allowRetainedLink && before.nlink !== 1) || before.size > maxBytes) throw Error("Unsafe publication file");
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes || !opened.isFile() || (!allowRetainedLink && opened.nlink !== 1)) throw Error("Publication file changed");
      // Read the observed size plus one growth sentinel, not the maximum for every file.
      const bytes = Buffer.alloc(opened.size + 1); let used = 0;
      while (used < bytes.length) { const n = fs.readSync(fd, bytes, used, bytes.length - used, used); if (!n) break; used += n; }
      const after = fs.lstatSync(filename);
      if (used > maxBytes || after.ino !== opened.ino || after.dev !== opened.dev || after.mtimeMs !== opened.mtimeMs || after.size !== used) throw Error("Publication file changed");
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
    } finally { fs.closeSync(fd); }
  }
  sync(directory: string) { const fd = fs.openSync(directory, fs.constants.O_RDONLY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  exclusive(relative: string, raw: string, role = publicationRole(relative)) {
    if (Buffer.byteLength(raw) > byteLimit(role)) throw Error("Publication file exceeds record byte limit");
    const filename = this.guard(relative, true);
    const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.sync(path.dirname(filename));
  }
  /** Move old inode aside, compare *after* displacement, install with no-clobber
   * link. Editor writes through an open old fd remain on the retained inode.
   * Never rename over an author's concurrently-created replacement. */
  repairStageLink(change: FileChange) {
    let staged: fs.Stats, current: fs.Stats;
    try { staged = fs.lstatSync(this.guard(change.stage)); current = fs.lstatSync(this.guard(change.path)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    if (staged.dev === current.dev && staged.ino === current.ino) {
      if (staged.nlink !== 2 || this.read(change.stage, true, publicationRole(change.path)) !== change.after) throw Error("conflict");
      fs.unlinkSync(this.guard(change.stage)); this.sync(path.dirname(this.guard(change.stage)));
      this.sync(path.dirname(this.guard(change.path)));
    }
  }
  publish(change: FileChange, checkpoint: (stage: string) => void) {
    this.repairStageLink(change);
    let current = this.read(change.path), retained = this.read(change.backup, true, publicationRole(change.path));
    if (current === change.after && (change.before === null || retained === change.before)) return;
    if (retained !== null && retained !== change.before) throw Error("conflict");
    if (retained === null && change.before !== null) {
      if (current !== change.before) throw Error("conflict");
      checkpoint("before-displace");
      fs.renameSync(this.guard(change.path), this.guard(change.backup, true));
      this.sync(path.dirname(this.guard(change.path))); this.sync(path.dirname(this.guard(change.backup)));
      checkpoint("after-displace");
      retained = this.read(change.backup, false, publicationRole(change.path));
      if (retained !== change.before) {
        // Restore the displaced editor version only if the slot is still empty.
        try { fs.linkSync(this.guard(change.backup), this.guard(change.path)); this.sync(path.dirname(this.guard(change.path))); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
        throw Error("conflict");
      }
      current = this.read(change.path);
    }
    if (current !== null) throw Error("conflict");
    let staged = this.read(change.stage, true, publicationRole(change.path));
    if (staged === null) { this.exclusive(change.stage, change.after, publicationRole(change.path)); staged = change.after; }
    if (staged !== change.after) throw Error("conflict");
    checkpoint("before-install");
    try { fs.linkSync(this.guard(change.stage), this.guard(change.path, true)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw Error("conflict"); throw e; }
    checkpoint("after-link");
    // The only link we remove is our known, journal-owned staging name.
    fs.unlinkSync(this.guard(change.stage)); this.sync(path.dirname(this.guard(change.stage)));
    this.sync(path.dirname(this.guard(change.path)));
    checkpoint("after-install");
    if (this.read(change.path) !== change.after || (change.before !== null && this.read(change.backup, false, publicationRole(change.path)) !== change.before)) throw Error("conflict");
  }
  /** Change stamps of every authored file in a scope (not contents). Equal
   * snapshots mean no file was added, removed or rewritten: any rewrite
   * changes ctime. Reading stamps keeps each publication independent of how
   * much knowledge the scope holds. */
  snapshot(scope: string, tolerateUnsafe = false): string {
    const entries: [string, string][] = []; let count = 0;
    const walk = (relative: string, depth = 0) => {
      if (depth > 8) throw Error("Vault directory depth exceeds 8");
      let names: string[];
      try { names = fs.readdirSync(path.dirname(this.guard(`${relative}/.probe`))); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
      for (const name of names.sort()) {
        if (name === ".knowledge-history" || name.toLowerCase() === ".git" || name === "artifacts") continue;
        if (++count > MAX_ENTRIES) throw Error(`Vault exceeds ${MAX_ENTRIES.toLocaleString("en-US")} entries`);
        const target = `${relative}/${name}`, full = this.guard(target), stat = fs.lstatSync(full, { bigint: true });
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1n)) {
          if (tolerateUnsafe) continue; // Read-side Git observation never follows unsafe entries.
          throw Error("Unsafe publication directory entry");
        }
        if (stat.isDirectory()) { entries.push([target, "directory"]); walk(target, depth + 1); }
        // Stamps only: two snapshots of an unchanged file must compare equal
        // whenever they are taken. accept() re-verifies record contents.
        else if (stat.isFile() && /\.(md|ya?ml)$/.test(name)) entries.push([target, `${stat.mode}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`]);
      }
    };
    walk(scope); return JSON.stringify(entries);
  }
  hash(relative: string) { const raw = this.read(relative); return raw === null ? null : digest(raw); }
}
export type FileChange = { path: string; before: string | null; after: string; backup: string; stage: string };
