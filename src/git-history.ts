import { inspectEvidence, withEvidenceFile } from "./evidence-files.js";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { PublicationFiles } from "./publication-files.js";

export type GitChange = { path: string; raw: string | null; fileHash?: string };
export type GitBatch = { token: string; changes: GitChange[]; actor: string; at: string };
export class GitUnavailable extends Error {}

/** Local Git only. Exact blobs, isolated staging, no filters/hooks/signing/remotes.
 * The durable checkpoint ref and branch advance in a single ref transaction.
 * SQLite may retry after any boundary without creating another commit. */
export class GitHistory {
  private readonly gitDir: string;
  constructor(private readonly root: string, private readonly executable = "git") {
    this.gitDir = path.join(root, ".git");
  }
  private command(args: string[], input?: string, extra: NodeJS.ProcessEnv = {}, optional = false, inputFd?: number): string {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
    const result = spawnSync(this.executable, ["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.splitIndex=false", "-c", "core.sparseCheckout=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], {
      cwd: this.root, input, ...(inputFd !== undefined ? { stdio: [inputFd, "pipe", "pipe"] as [number, "pipe", "pipe"] } : {}), encoding: "utf8", timeout: 10000, maxBuffer: 16 * 1024 * 1024,
      env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", ...extra },
    });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new GitUnavailable("Git is not installed; local history is waiting for Git.");
    if (result.error || (result.status !== 0 && !optional)) throw Error("Local Git checkpoint failed; resolve repository permissions, locks, or concurrent Git activity and retry.");
    return result.status === 0 ? result.stdout.trimEnd() : "";
  }
  private git(args: string[], input?: string, extra?: NodeJS.ProcessEnv, optional = false, inputFd?: number) {
    return this.command([`--git-dir=${this.gitDir}`, `--work-tree=${this.root}`, ...args], input, extra, optional, inputFd);
  }
  private repository() {
    this.command(["--version"]);
    new PublicationFiles(this.root); // Reject redirected vault roots before Git touches them.
    let stat: fs.Stats | undefined;
    try { stat = fs.lstatSync(this.gitDir); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (!stat) {
      this.git(["init", "--quiet", "--template=", "--initial-branch=main"]);
      stat = fs.lstatSync(this.gitDir);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(this.gitDir) !== this.gitDir) throw Error("Local Git needs a repository directory inside the vault; linked repositories require review.");
    if (this.git(["rev-parse", "--is-bare-repository"]) !== "false") throw Error("Local Git requires a non-bare vault repository.");
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
      if (fs.existsSync(path.join(this.gitDir, name))) throw Error("Local Git history is waiting for the active merge/rebase to finish.");
    }
    // Preserve existing local exclusions; never put recovery payloads in history.
    const info = path.join(this.gitDir, "info");
    if (fs.existsSync(info) && (!fs.lstatSync(info).isDirectory() || fs.lstatSync(info).isSymbolicLink())) throw Error("Unsafe Git info directory.");
    const exclude = path.join(info, "exclude");
    if (fs.existsSync(exclude) && (!fs.lstatSync(exclude).isFile() || fs.lstatSync(exclude).isSymbolicLink())) throw Error("Unsafe Git exclude file.");
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const previous = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    const missing = [".knowledge-history/", "/vault.json"].filter(rule => !previous.split(/\r?\n/).includes(rule));
    if (missing.length) fs.appendFileSync(exclude, `\n# Knowledge operational state (not portable content)\n${missing.join("\n")}\n`);
  }
  private entries(args: string[], env?: NodeJS.ProcessEnv) {
    const entries = new Map<string, string>();
    for (const line of this.git(args, undefined, env).split("\0").filter(Boolean)) {
      const tab = line.indexOf("\t"), fields = line.slice(0, tab).split(" ");
      // ls-tree: mode type oid; ls-files: mode oid stage.
      entries.set(line.slice(tab + 1), `${fields[0]} ${fields[1] === "blob" || fields[1] === "tree" || fields[1] === "commit" ? fields[2] : fields[1]}`);
    }
    return entries;
  }
  private apply(changes: GitChange[], index: string) {
    for (const change of changes) {
      if (change.fileHash) {
        const at = change.path.indexOf("/artifacts/");
        if (at < 0) throw Error("File-backed Git changes must be source artifacts");
        const root = path.join(this.root, change.path.slice(0, at)), relative = change.path.slice(at + 1);
        const oid = withEvidenceFile(root, relative, fd => {
          inspectEvidence(root, { path: relative, sha256: change.fileHash! });
          return this.git(["hash-object", "-w", "--stdin", "--no-filters"], undefined, undefined, false, fd);
        });
        this.git(["update-index", "--add", "--cacheinfo", "100644", oid, change.path], undefined, { GIT_INDEX_FILE: index });
      } else if (change.raw === null) this.git(["update-index", "--force-remove", "--", change.path], undefined, { GIT_INDEX_FILE: index });
      else {
        const oid = this.git(["hash-object", "-w", "--stdin", "--no-filters"], change.raw);
        this.git(["update-index", "--add", "--cacheinfo", "100644", oid, change.path], undefined, { GIT_INDEX_FILE: index });
      }
    }
  }
  /** Synchronize only unstaged paths; retain all pre-existing staged content.
   * A crash before this cosmetic step can be retried from the checkpoint ref. */
  private synchronizeIndex(changes: GitChange[], parent: string, temporary: string) {
    const index = path.join(this.gitDir, "index"), lock = index + ".lock";
    const fd = fs.openSync(lock, "wx", 0o600);
    let ownsLock = true;
    try {
      if (fs.existsSync(index)) {
        if (!fs.lstatSync(index).isFile() || fs.lstatSync(index).isSymbolicLink()) throw Error("Unsafe Git index.");
        fs.copyFileSync(index, temporary);
      } else this.git(["read-tree", "--empty"], undefined, { GIT_INDEX_FILE: temporary });
      const staged = this.entries(["ls-files", "--stage", "-z"], { GIT_INDEX_FILE: temporary });
      const before = parent ? this.entries(["ls-tree", "-r", "-z", parent]) : new Map<string, string>();
      const unchanged = changes.filter(c => staged.get(c.path) === before.get(c.path));
      this.apply(unchanged, temporary);
      fs.writeFileSync(fd, fs.readFileSync(temporary)); fs.fsyncSync(fd);
      fs.renameSync(lock, index); ownsLock = false;
    } finally { fs.closeSync(fd); if (ownsLock) fs.unlinkSync(lock); }
  }
  checkpoint(batch: GitBatch, hook: (stage: string) => void = () => {}): string {
    for (const c of batch.changes) {
      if (!/^(private|conversations\/[^/]+)\//.test(c.path) || c.path.split("/").some(p => !p || [".", "..", ".git", ".knowledge-history"].includes(p.toLowerCase()) || /[\\\x00-\x1f]/.test(p))) throw Error("Unsafe Git content path.");
    }
    if (!/^[a-f0-9]{64}$/.test(batch.token)) throw Error("Unsafe Git checkpoint token.");
    this.repository();
    if (this.git(["ls-files", "--unmerged"])) throw Error("Local Git history is waiting for unresolved index conflicts.");
    const ref = `refs/knowledge/checkpoints/${batch.token}`;
    let commit = this.git(["rev-parse", "--verify", "--quiet", ref], undefined, undefined, true);
    const temporary = fs.mkdtempSync(path.join(this.gitDir, "knowledge-index-"));
    try {
      let parent: string;
      if (commit) parent = this.git(["rev-parse", "--verify", "--quiet", `${commit}^`], undefined, undefined, true);
      else {
        const branch = this.git(["symbolic-ref", "--quiet", "HEAD"], undefined, undefined, true);
        if (!branch.startsWith("refs/heads/")) throw Error("Local Git history is waiting for an attached branch.");
        parent = this.git(["rev-parse", "--verify", "--quiet", "HEAD"], undefined, undefined, true);
        const index = path.join(temporary, "commit");
        this.git(["read-tree", parent || "--empty"], undefined, { GIT_INDEX_FILE: index });
        this.apply(batch.changes, index);
        const tree = this.git(["write-tree"], undefined, { GIT_INDEX_FILE: index });
        commit = this.git(["commit-tree", tree, ...(parent ? ["-p", parent] : [])], `Knowledge: ${batch.actor} (${batch.changes.length} files)\n\nKnowledge-Checkpoint: ${batch.token}\n`, {
          GIT_AUTHOR_NAME: "OpenClaw Knowledge", GIT_AUTHOR_EMAIL: "knowledge@localhost", GIT_COMMITTER_NAME: "OpenClaw Knowledge", GIT_COMMITTER_EMAIL: "knowledge@localhost", GIT_AUTHOR_DATE: batch.at, GIT_COMMITTER_DATE: batch.at,
        });
        hook("before-git-ref");
        const zero = "0".repeat(commit.length);
        this.git(["update-ref", "--stdin"], `start\nupdate ${branch} ${commit} ${parent || zero}\ncreate ${ref} ${commit}\nprepare\ncommit\n`);
        hook("after-git-ref");
      }
      // Do not adjust the index against a branch that has since moved.
      if (this.git(["rev-parse", "--verify", "HEAD"]) === commit) this.synchronizeIndex(batch.changes, parent, path.join(temporary, "working"));
      return commit;
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
}
