// Git graph of the focused terminal's repo: lanes, refs, subjects and ages.
// One `git log --graph` call; its output is parsed once into plain rows.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, HoverCard } from "gpui-base";
import { spaces, panes, focused, exec, theme, terminals, shared, setShared, nextCommand } from "herdr";

const COMMITS = 80;
const CELL = 7; // width of one graph character
const MAX_CELLS = 14; // wider graphs are clipped
const ROW = 20;
const NARROW = 160; // the sidebar's rail
const MONO = "JetBrains Mono";
const SEP = "\x1f";
const FORMAT = "%x1f%h%x1f%D%x1f%s%x1f%ct"; // after the graph: hash, refs, subject, commit time (unix s)
const RS = "\x1e";
const DETAIL = "%x1e%h%x1f%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%ci%x1f%B"; // short and full hash, author, committer, commit date, full message
const COPIED_MS = 1200;
const CARD_W = 340;
const BODY_MAX = 1200;
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
// The commit shown in lite-changes, as { context, hash }; none = the latest, i.e. the uncommitted changes.
// lite-changes reads the same key: keep the two in step.
const SELECT_KEY = "lite.commit";
const GLYPH = { "*": "●", "|": "│", "/": "╱", "\\": "╲", "_": "─", "-": "─" };

// Same place the shipped Changes panel looks at, so both follow the same terminal.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  // terminals() has the folder the program is in now; a pane's cwd can still be where it started.
  const live = f?.terminal ? terminals().find((x) => x.address === f.terminal)?.cwd : null;
  return { cwd: live || pane?.cwd || f?.cwd || space?.folder, on };
}
const keyOf = () => JSON.stringify(location());

// A graph-only line has no separator: it is a connector between two commits.
function parse(out) {
  return out.split("\n").filter(Boolean).map((line) => {
    const i = line.indexOf(SEP);
    if (i < 0) return { graph: line.trimEnd() };
    const [hash, refs, subject, time] = line.slice(i + 1).split(SEP);
    return { graph: line.slice(0, i).trimEnd(), hash, subject, time: Number(time), refs: refs ? refs.split(", ") : [] };
  });
}

// Full message, author and committer per commit, keyed by short hash, for the hover card.
async function loadDetails(cwd, on) {
  const r = await exec("git", [...READ, "log", "--all", `-n${COMMITS}`, `--format=${DETAIL}`], { cwd, on });
  const out = {};
  if (r.code !== 0) return out;
  for (const rec of r.stdout.split(RS).filter((x) => x.trim())) {
    const [hash, full, author, email, committer, committerEmail, date, ...message] = rec.split(SEP);
    out[hash] = { full, author, email, committer, committerEmail, date, message: message.join(SEP).trim() };
  }
  return out;
}

function ago(seconds) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 365 ? `${d}d` : `${Math.floor(d / 365)}y`;
}

export default class LiteGit extends View {
  init(_props, cx) {
    this.rows = [];
    this.details = {};
    this.hashes = "";
    this.copied = null;
    this.cells = 1;
    this.repo = "";
    this.error = null;
    this.sig = "";
    this.context = null;
    this.width = null;
    this.refresh(cx);
    cx.timer.every(5000, (cx) => this.refresh(cx));
    // `herdr-app do lite-git.next` / `.prev` (or keys bound to them) move to the older / newer commit.
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        if (command === "next") this.step(1);
        else if (command === "prev") this.step(-1);
      }
    });
  }

  // The hash lite-changes is showing, or null for the latest commit (its changes are the uncommitted ones).
  pickedHash() {
    const s = shared(SELECT_KEY);
    return s?.hash && s.context === keyOf() ? s.hash : null;
  }

  isHead(r) { return r.refs.some((name) => name.startsWith("HEAD")); }

  isSelected(r, picked) {
    return picked ? picked === (this.details[r.hash]?.full ?? r.hash) : this.isHead(r);
  }

  // Picking the latest commit, or nothing, goes back to the uncommitted changes.
  choose(r) {
    const hash = r ? this.details[r.hash]?.full ?? r.hash : null;
    setShared(SELECT_KEY, !r || this.isHead(r) ? null : { context: keyOf(), hash });
  }

  step(by) {
    const commits = this.rows.filter((r) => r.hash), picked = this.pickedHash();
    const now = Math.max(0, commits.findIndex((r) => this.isSelected(r, picked)));
    const next = commits[Math.max(0, Math.min(commits.length - 1, now + by))];
    if (next) this.choose(next);
  }

  refresh(cx) {
    if (this.loading) return;
    const { cwd, on } = location(), context = keyOf();
    if (context !== this.context) {
      this.context = context;
      this.sig = "";
      this.rows = [];
      this.details = {};
      this.hashes = "";
      this.repo = "";
      this.error = null;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      let next = null;
      try {
        const top = await exec("git", [...READ, "rev-parse", "--show-toplevel"], { cwd, on });
        if (top.code !== 0) next = { error: "Not a git repository", rows: [], repo: "" };
        else {
          const root = top.stdout.trim();
          const log = await exec("git", [...READ, "log", "--graph", "--all", "--date-order", "--color=never", `-n${COMMITS}`, `--format=${FORMAT}`], { cwd: root, on });
          const repo = root.split(/[\\/]/).pop();
          if (log.code !== 0) next = { error: "No commits yet", rows: [], repo, details: {}, hashes: "" };
          else {
            const rows = parse(log.stdout);
            const hashes = rows.filter((r) => r.hash).map((r) => r.hash).join(",");
            // The messages only change when the commits do, so they are read again only then.
            const details = hashes === this.hashes ? this.details : await loadDetails(root, on);
            next = { error: null, rows, repo, details, hashes };
          }
        }
      } catch (e) {
        next = { error: String(e), rows: [], repo: "" };
      } finally {
        this.loading = false;
      }
      if (keyOf() !== context) return cx.notify(); // focus moved: render asks again
      const sig = JSON.stringify(next);
      if (sig === this.sig) return;
      this.sig = sig;
      Object.assign(this, next);
      this.cells = Math.min(MAX_CELLS, Math.max(1, ...this.rows.map((r) => r.graph.length)));
      cx.notify();
    });
  }

  chips(refs, t) {
    const shown = refs.slice(0, 2);
    const chip = (name) => {
      const head = name.startsWith("HEAD");
      const tag = name.startsWith("tag: ");
      const color = head ? t.accent : tag ? t.ansi3 : t.muted;
      return div().flex_none().max_w(110).truncate().px(5).rounded(4).border_1().border_color(color + "88").text_size(10).text_color(color)
        .child(head ? name.replace("HEAD -> ", "") : tag ? name.slice(5) : name);
    };
    return shown.map(chip).concat(refs.length > shown.length ? [div().flex_none().text_size(10).text_color(t.dim).child(`+${refs.length - shown.length}`)] : []);
  }

  // One cell per graph character; git puts a lane every two columns, so the cell's column picks its color.
  row(r, i, t, picked) {
    const lane = [t.ansi2, t.ansi4, t.ansi5, t.ansi3, t.ansi6, t.ansi1];
    const graph = h_flex().flex_none().w(this.cells * CELL).h(ROW).overflow_hidden().font_family(MONO).text_size(12)
      .children([...r.graph].slice(0, MAX_CELLS).map((ch, col) => div().w(CELL).h(ROW).flex_none().flex().items_center().justify_center()
        .text_color(lane[Math.floor(col / 2) % lane.length]).child(GLYPH[ch] ?? "")));
    const line = h_flex().id(`git-${i}`).w_full().h(ROW).flex_none().px(10).gap(6).items_center().text_size(12).text_color(t.foreground)
      .child(graph);
    if (!r.hash) return line; // a connector between commits has nothing to show
    const copied = this.copied === r.hash;
    const selected = this.isSelected(r, picked);
    line.cursor_pointer().when(selected, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click(() => this.choose(selected ? null : r))
      .on_mouse_down("right", (_e, cx) => this.copy(r, cx))
      .children(this.chips(r.refs, t))
      .child(div().flex_1().min_w(0).truncate().child(r.subject))
      .child(div().flex_none().text_size(10.5).text_color(copied ? t.accent : t.dim).child(copied ? "Copied" : ago(r.time)));
    return HoverCard.new(`card-${r.hash}`).w_full().flex_none().open_delay(350).trigger(line).content(this.card(r, t));
  }

  // The full hash once the details are in, else the short one: git takes either.
  copy(r, cx) {
    cx.write_to_clipboard(this.details[r.hash]?.full ?? r.hash);
    this.copied = r.hash;
    cx.notify();
    cx.spawn(async (cx) => {
      await cx.sleep(COPIED_MS);
      if (this.copied !== r.hash) return;
      this.copied = null;
      cx.notify();
    });
  }

  // The whole commit: title, body, then who and when. Without details yet, the subject alone.
  card(r, t) {
    const d = this.details[r.hash];
    const [title, ...rest] = (d?.message || r.subject).split("\n");
    const text = rest.join("\n").trim();
    const body = text.length > BODY_MAX ? `${text.slice(0, BODY_MAX).trimEnd()}…` : text;
    const meta = (key, value, mono = false) => h_flex().gap(8).items_start().text_size(11.5)
      .child(div().w(66).flex_none().text_color(t.dim).child(key))
      .child(div().flex_1().min_w(0).text_color(t.muted).when(mono, (e) => e.font_family(MONO)).child(value));
    const who = (name, email) => (email ? `${name} <${email}>` : name);
    const sameCommitter = !d || (d.committer === d.author && d.committerEmail === d.email);
    return v_flex().w(CARD_W).p(12).gap(8).rounded(10).bg(t.popover).border_1().border_color(t.border).shadow_lg().text_color(t.foreground)
      .child(div().text_size(13).font_semibold().child(title))
      .when(Boolean(body), (el) => el.child(v_flex().gap(2).text_size(12).text_color(t.muted)
        .children(body.split("\n").map((l) => (l ? div().child(l) : div().h(6))))))
      .when(Boolean(d), (el) => el.child(v_flex().gap(3).pt(8).border_t(1).border_color(t.border)
        .child(meta("Author", who(d.author, d.email)))
        .when(!sameCommitter, (e) => e.child(meta("Committer", who(d.committer, d.committerEmail))))
        .child(meta("Date", d.date))
        .child(meta("Commit", r.hash, true))
        .when(r.refs.length > 0, (e) => e.child(meta("Refs", r.refs.join(", "))))))
      .child(div().text_size(10.5).text_color(t.dim).child("Click: show its files in Changes · Right-click: copy the hash"));
  }

  render(cx) {
    if (keyOf() !== this.context) this.refresh(cx);
    const t = theme();
    const rail = (this.width ?? Infinity) < NARROW;
    const commits = this.rows.filter((r) => r.hash).length, picked = this.pickedHash();
    return v_flex().id("lite-git").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => {
        if (size.width === this.width) return;
        this.width = size.width;
        cx.notify();
      })
      .when(!rail, (el) => el
        .child(h_flex().h(34).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
          .child(div().font_semibold().child("Git"))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.repo))
          .when(commits > 0, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.muted).child(`${commits} commits`))))
        .child(v_flex().id("lite-git-list").flex_1().min_h(0).overflow_y_scrollbar().py(4)
          .children(this.rows.map((r, i) => this.row(r, i, t, picked)))
          .when(!this.rows.length, (e) => e.child(div().p(12).text_size(12).text_color(t.dim).child(this.error ?? "Loading…")))));
  }
}
