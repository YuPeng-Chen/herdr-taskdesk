import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, openOverlay, terminals, shared, setShared, nextCommand } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  // The folder the running program is in now (an agent can start somewhere other than its shell's
  // folder), else the shell's own; a pane's cwd can still be where it started.
  const term = f?.terminal ? terminals().find((x) => x.address === f.terminal) : null;
  const live = term?.foreground?.cwd || term?.cwd;
  return { cwd: live || pane?.cwd || f?.cwd || space?.folder, on };
}
const place = () => JSON.stringify(location());
// lite-git sets { context, hash } when a commit is clicked, context being its own place(): a pick
// made in another terminal or folder does not count here. No pick = the uncommitted changes.
const SELECT_KEY = "lite.commit";
// What the pop-out window should show, same shape as its props plus a `seq`: the window reads it
// on every render and follows when it is newer than what it has. lite-diff reads the same key.
const VIEW_KEY = "lite.diff.view";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // what a first commit is compared with
const picked = () => {
  const s = shared(SELECT_KEY);
  return s?.hash && s.context === place() ? s.hash : null;
};
// Everything that changes what the panel shows: where, and which commit.
const key = () => JSON.stringify({ place: place(), commit: picked() });

// `git diff --numstat -z`: "added\tdeleted\tpath\0" per file; "-" counts mean a binary file.
function numstat(out) {
  const stats = {};
  for (const entry of out.split("\0")) {
    const [a, d, ...parts] = entry.split("\t");
    if (parts.length) stats[parts.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
  }
  return stats;
}
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

const ROW = 26;
const LIST_MAX = 220; // px; a longer list scrolls
const AUTO_EXPAND = 15; // up to this many changed files, folders start open

const sortedDirs = (node) => [...node.dirs].sort(([a], [b]) => a.localeCompare(b));

function treeOf(files) {
  const root = { dirs: new Map(), files: [] };
  for (const file of files) {
    let node = root;
    for (const part of file.path.split("/").slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(file);
  }
  return root;
}

function totals(node) {
  const sum = { count: node.files.length, add: 0, del: 0 };
  for (const f of node.files) { sum.add += f.add; sum.del += f.del; }
  for (const child of node.dirs.values()) {
    const s = totals(child);
    sum.count += s.count; sum.add += s.add; sum.del += s.del;
  }
  return sum;
}

// The tree as the rows that are showing. A folder holding only one folder joins it
// into a single row ("src/ui/panels"), so a deep path costs one line, not five.
function flatten(node, prefix, depth, isOpen, rows) {
  for (const [name, child] of sortedDirs(node)) {
    let label = name, path = prefix + name, last = child;
    while (!last.files.length && last.dirs.size === 1) {
      const [next, inner] = last.dirs.entries().next().value;
      label += "/" + next; path += "/" + next; last = inner;
    }
    const open = isOpen(path);
    rows.push({ kind: "dir", path, label, depth, open, ...totals(last) });
    if (open) flatten(last, path + "/", depth + 1, isOpen, rows);
  }
  for (const file of node.files) rows.push({ kind: "file", path: file.path, file, name: file.path.split("/").pop(), depth });
  return rows;
}

const dirPaths = (files) => flatten(treeOf(files), "", 0, () => true, []).filter((r) => r.kind === "dir").map((r) => r.path);

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.fold = new Map(); // folder path -> open; a folder not in it follows AUTO_EXPAND
    this.where = null; // place() the panel last loaded for
    this.commit = null; // { hash, short, subject, base } while a commit's files show
    this.loadedFor = null;
    this.copied = false;
    this.popped = false; // a pop-out window was opened: keep it in step from now on
    this.syncPending = false; // the files changed under it: tell it once they are in
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    // `herdr-app do lite-changes.popout` opens the window; `.next` / `.prev` pick the next / previous file.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "popout") this.popOut();
        else if (command === "next") this.step(1, cx);
        else if (command === "prev") this.step(-1, cx);
      }
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key(), where = place();
    if (context !== this.context) {
      const moved = where !== this.where; // another terminal or folder, not just another commit
      this.where = where;
      this.context = context; this.root = null; this.files = []; this.open = null; this.fold = new Map(); this.commit = null; this.loadedFor = null; this.syncPending = true;
      this.setLines([]); this.error = null; this.note = null; this.closed = false; this.limited = false;
      if (moved) { this.message = ""; this.input.set_value(""); this.watched = null; }
    }
    if (!cwd) return;
    if (this.commit && this.loadedFor === context) return; // a commit never changes
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const commit = await this.commitFiles(git, picked());
        if (commit) {
          if (key() !== context) return;
          this.root = root; this.on = on; this.hasHead = true; this.commit = commit; this.files = commit.files; this.limited = commit.limited; this.error = null;
          this.loadedFor = context;
          return await this.showOpen(commit.files, context);
        }
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        await this.showOpen(files, context);
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // The files a commit changed, against its first parent (a first commit: against nothing).
  // null for no pick, and for the latest commit: its changes are the ones not committed yet.
  async commitFiles(git, wanted) {
    if (!wanted) return null;
    if (!/^[0-9a-f]{4,64}$/i.test(wanted)) throw new Error("Not a commit hash");
    const rev = await git(["rev-parse", "--verify", `${wanted}^{commit}`]);
    if (rev.code !== 0) throw new Error(`Commit ${wanted.slice(0, 7)} not found`);
    const hash = rev.stdout.trim();
    const head = await git(["rev-parse", "--verify", "HEAD"]);
    if (head.code === 0 && head.stdout.trim() === hash) return null;
    const parent = await git(["rev-parse", "--verify", `${hash}^1`]);
    const base = parent.code === 0 ? parent.stdout.trim() : EMPTY_TREE;
    const names = await git(["diff", "--name-status", "-z", "--no-renames", base, hash]);
    const nums = await git(["diff", "--numstat", "-z", "--no-renames", base, hash]);
    if (names.code !== 0 || nums.code !== 0) throw new Error((names.stderr || nums.stderr).trim());
    const info = await git(["log", "-1", "--format=%h%x1f%s", hash]);
    const [short, subject] = info.stdout.trim().split("\x1f");
    const stats = numstat(nums.stdout), tokens = names.stdout.split("\0").filter(Boolean), files = [];
    for (let i = 0; i + 1 < tokens.length && files.length < 1000; i += 2) {
      const code = tokens[i][0], path = tokens[i + 1];
      files.push({ path, status: code === "A" || code === "D" ? code : "M", fresh: false, ...(stats[path] ?? { add: 0, del: 0 }) });
    }
    return { hash, base, short: short ?? hash.slice(0, 7), subject: subject ?? "", files, limited: tokens.length / 2 > 1000 };
  }

  // What the diff compares: a commit with its parent, or the working tree with HEAD.
  revs() { return this.commit ? [this.commit.base, this.commit.hash] : this.hasHead ? ["HEAD"] : []; }

  async showOpen(files, context) {
    if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
    // The first file's diff shows until you pick another.
    if (!this.open && !this.closed && files.length) this.open = files[0].path;
    if (this.syncPending) { this.syncPending = false; this.syncPopup(); }
    if (!this.open) return;
    try { await this.load(this.open, context); }
    catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...this.revs(), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    this.syncPopup();
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  isOpen(path) { return this.fold.get(path) ?? this.files.length <= AUTO_EXPAND; }

  toggleDir(path, cx) { this.fold.set(path, !this.isOpen(path)); cx.notify(); }

  // A virtual list takes one click handler for all its rows, keyed by the row's path.
  clickRow(row, cx) {
    if (row?.kind === "dir") this.toggleDir(row.path, cx);
    else if (row) this.pick(row.path, cx);
  }

  // The selected file's diff in a window of its own; the window steps through all the files.
  popOut() {
    const index = this.files.findIndex((f) => f.path === this.open);
    if (index < 0 || !this.root) return;
    this.popped = true;
    openOverlay({ mod: "lite-diff", kind: "window", key: "lite-diff", props: this.popupProps(index) });
  }

  popupProps(index) {
    const files = this.files.map(({ path, status, fresh, add, del, binary }) => ({ path, status, fresh, add, del, binary }));
    return {
      root: this.root, on: this.on ?? null, hasHead: this.hasHead, files, index, seq: Date.now(),
      commit: this.commit ? { base: this.commit.base, hash: this.commit.hash } : null,
    };
  }

  // Tells an open pop-out window what the panel shows now. Nobody reads it when no window is open.
  syncPopup() {
    const index = this.files.findIndex((f) => f.path === this.open);
    if (!this.popped || index < 0 || !this.root) return;
    setShared(VIEW_KEY, this.popupProps(index));
  }

  // The next / previous file in the order the tree lists them, folders closed or not.
  step(by, cx) {
    const order = flatten(treeOf(this.files), "", 0, () => true, []).filter((r) => r.kind === "file");
    const now = order.findIndex((r) => r.path === this.open);
    const next = order[Math.max(0, Math.min(order.length - 1, now + by))];
    if (next && next.path !== this.open) this.pick(next.path, cx);
  }

  copyHash(cx) {
    cx.write_to_clipboard(this.commit.hash);
    this.copied = true;
    cx.notify();
    cx.spawn(async (cx) => {
      await cx.sleep(1200);
      this.copied = false;
      cx.notify();
    });
  }

  // Under the title while a commit shows: its hash (click to copy), its subject, and the way back.
  banner(t) {
    const c = this.commit, lit = this.copied;
    return h_flex().flex_none().h(30).px(14).gap(8).items_center().border_b(1).border_color(t.border).text_size(11.5)
      .child(div().id("commit-hash").flex_none().px(6).h(20).flex().items_center().rounded(5).border_1().border_color(lit ? t.accent : t.border)
        .font_family("JetBrains Mono").text_color(lit ? t.accent : t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.copyHash(cx)).child(lit ? "Copied" : c.short))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(c.subject))
      .child(div().id("commit-back").flex_none().px(6).h(20).flex().items_center().rounded(5).cursor_pointer().text_color(t.accent)
        .hover((s) => s.bg(t.hover)).on_click(() => setShared(SELECT_KEY, null)).child("Uncommitted"));
  }

  foldAll(open, cx) {
    for (const path of dirPaths(this.files)) this.fold.set(path, open);
    cx.notify();
  }

  treeRow(row, t) {
    const pad = 8 + row.depth * 14;
    const stats = (e) => e
      .when(row.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${row.add}`)))
      .when(row.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${row.del}`)));
    if (row.kind === "dir") {
      return stats(h_flex().w_full().h(ROW).flex_none().pl(pad).pr(8).gap(6).items_center().rounded(7).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .child(div().w(10).flex_none().text_size(10).text_color(t.dim).child(row.open ? "▾" : "▸"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(row.label))
        .child(div().flex_none().text_size(10).text_color(t.dim).child(`${row.count}`)));
    }
    const f = row.file, color = f.status === "A" ? t.ansi2 : f.status === "D" || f.status === "U" ? t.ansi1 : t.blocked;
    return stats(h_flex().w_full().h(ROW).flex_none().pl(pad + 16).pr(8).gap(8).items_center().rounded(7).cursor_pointer()
      .when(this.open === row.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .child(div().w(14).flex_none().text_size(11).text_color(color).child(f.status))
      .child(div().flex_1().min_w(0).truncate().child(row.name)));
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const tree = flatten(treeOf(this.files), "", 0, (p) => this.isOpen(p), []);
    const byPath = new Map(tree.map((row) => [row.path, row]));
    const dirs = dirPaths(this.files), anyOpen = dirs.some((p) => this.isOpen(p));
    const listHeight = Math.min(LIST_MAX, Math.max(44, tree.length * ROW + 12));
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child(this.commit ? "Commit" : "Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1())
        .when(Boolean(this.open), (e) => e.child(div().id("pop-out").flex_none().px(6).h(20).flex().items_center().rounded(5).cursor_pointer().text_size(11).text_color(t.muted)
          .hover((s) => s.bg(t.hover)).on_click(() => this.popOut()).child("Pop out")))
        .when(dirs.length > 0, (e) => e.child(div().id("fold-all").flex_none().px(6).h(20).flex().items_center().rounded(5).cursor_pointer().text_size(11).text_color(t.muted)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.foldAll(!anyOpen, cx)).child(anyOpen ? "Collapse" : "Expand")))
        .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      .when(Boolean(this.commit), (e) => e.child(this.banner(t)))
      .child(div().id("changes-list").flex_none().h(listHeight).relative().border_b(1).border_color(t.border)
        .child(tree.length
          ? div().size_full().px(6).py(6).child(v_virtual_list("changes-tree", tree.length, ROW, (i) => tree[i].path,
            (range) => tree.slice(range.start, range.end).map((row) => this.treeRow(row, t))).size_full()
            .on_item_click((path, cx) => this.clickRow(byPath.get(path), cx)))
          : div().p(14).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? (this.commit ? "No file changes in this commit" : "No uncommitted changes") : "No folder")))
        .when(tree.length > 0, (e) => e.child(Scrollbar.vertical("changes-tree").viewport_from_layout().absolute().inset_0())))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .when(!this.commit, (e) => e.child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit"))));
  }
}
