// One changed file's diff in a window of its own, as big as you want it.
// Opened by lite-changes with { root, on, hasHead, files, index, commit? }; it reads the diff itself.
// `commit` ({ base, hash }) is set while lite-changes shows a commit's files instead of the uncommitted ones.
// Herdr windows have no drag edge, so the size is a state of this view: the root element
// is sized from it and the window follows (the - and + buttons step through SIZES).

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, readTextFile, theme, settings, props, closeOverlay, shared, setShared, nextCommand } from "herdr";

const SIZES = [[720, 480], [1000, 680], [1400, 900], [1800, 1100]];
const SIZE_NAMES = ["S", "M", "L", "XL"];
const SIZE_KEY = "lite-diff.size";
const VIEW_KEY = "lite.diff.view"; // published by lite-changes: the same props, newer, plus a `seq`
const DEFAULT_SIZE = 1;
const ROW = 20;
const CHAR_PX = 7.4; // monospace 12px, for the width of the longest line
const MAX_LINES = 20000;
const MAX_LINE_CHARS = 2000;
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

// Numbers every diff line once: old number, new number, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0], text = line.slice(1) || " ";
    if (kind === "-") return { kind, old: old++, text };
    if (kind === "+") return { kind, next: next++, text };
    if (kind === " ") return { kind, old: old++, next: next++, text };
    return { kind: "", text: line };
  });
}

// Nothing stored yet reads back as null, which Number() would make a 0.
const sizeIndex = () => {
  const stored = shared(SIZE_KEY);
  const n = stored === null || stored === undefined ? DEFAULT_SIZE : Number(stored);
  return Number.isInteger(n) && n >= 0 && n < SIZES.length ? n : DEFAULT_SIZE;
};

export default class LiteDiff extends View {
  init(_props, cx) {
    this.p = props() ?? {};
    this.seq = this.p.seq ?? 0; // the VIEW_KEY version these props are from
    this.files = this.p.files ?? [];
    this.index = Math.max(0, Math.min(this.files.length - 1, this.p.index ?? 0));
    this.rows = [];
    this.width = 300;
    this.state = this.files.length ? "Loading…" : "No file to show";
    this.handle = cx.focus_handle();
    this.show(this.index, cx);
    this.handle.focus();
    // `herdr-app do lite-diff.next` (or a key bound to it) does what the button does.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "close") closeOverlay(this.p.overlay);
        else if (command === "prev") this.step(-1, cx);
        else if (command === "next") this.step(1, cx);
        else if (command === "smaller") this.resize(-1, cx);
        else if (command === "larger") this.resize(1, cx);
      }
    });
  }

  async read(file) {
    const { root, on, hasHead, commit } = this.p;
    if (file.fresh || (!hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${file.path}`, { on }).catch(() => null);
      if (text === null) return ["Cannot preview this file (binary, too large, or unreadable)"];
      if (text.includes("\0")) return ["Binary file · no text diff"];
      const body = text.replace(/\n$/, "").split("\n");
      return [`@@ -0,0 +1,${body.length} @@`, ...body.map((l) => `+${l}`)];
    }
    // A commit compares with its parent; otherwise the working tree compares with HEAD.
    const revs = commit ? [commit.base, commit.hash] : hasHead ? ["HEAD"] : [];
    const args = [...READ, "diff", ...revs, "--no-ext-diff", "--no-textconv", "--no-color", "--", file.path];
    const r = await exec("git", args, { cwd: root, on });
    if (r.code !== 0) throw new Error(r.stderr);
    const all = r.stdout.replace(/\n$/, "").split("\n");
    const first = all.findIndex((l) => l.startsWith("@@"));
    return first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
  }

  // `notify` is false when called from render, which must not ask for another render.
  show(index, cx, notify = true) {
    const file = this.files[index];
    if (!file) return;
    this.index = index;
    this.rows = [];
    this.state = "Loading…";
    cx.spawn(async (cx) => {
      let lines, state = "";
      try {
        lines = await this.read(file);
        if (lines.length > MAX_LINES) {
          state = `Showing the first ${MAX_LINES.toLocaleString()} of ${lines.length.toLocaleString()} lines`;
          lines = lines.slice(0, MAX_LINES);
        }
      } catch (e) {
        lines = [`Cannot preview this diff: ${e}`];
      }
      if (this.index !== index) return;
      lines = lines.map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}… (line truncated)` : l));
      this.rows = diffRows(lines);
      this.width = Math.max(300, ...lines.map((l) => l.length * CHAR_PX + 130));
      this.state = state;
      cx.notify();
    });
    if (notify) cx.notify();
  }

  // lite-changes publishes what the panel shows now; a newer one replaces this window's files.
  follow(cx) {
    const view = shared(VIEW_KEY);
    if (!view || !(view.seq > this.seq) || !view.files?.length) return;
    this.seq = view.seq;
    this.p = { ...view, overlay: this.p.overlay };
    this.files = view.files;
    this.show(Math.max(0, Math.min(this.files.length - 1, view.index ?? 0)), cx, false);
  }

  step(by, cx) {
    const next = this.index + by;
    if (next >= 0 && next < this.files.length) this.show(next, cx);
  }

  resize(by, cx) {
    const next = Math.max(0, Math.min(SIZES.length - 1, sizeIndex() + by));
    if (next !== sizeIndex()) setShared(SIZE_KEY, next);
    cx.notify();
  }

  diffRow(row, t) {
    if (row.kind === "@") return div().w_full().px(12).h(ROW).flex_none().truncate().bg(t.raised).text_color(t.dim).child(row.text);
    const sign = row.kind === "+" ? "+" : row.kind === "-" ? "−" : " ";
    const signColor = row.kind === "+" ? t.ansi2 : t.ansi1;
    const num = (n) => div().w(46).flex_none().text_right().text_color(t.dim).child(n === undefined ? "" : String(n));
    return h_flex().w_full().h(ROW).flex_none().gap(8)
      .when(row.kind === "+", (e) => e.bg(t.ansi2 + "18")).when(row.kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(num(row.old)).child(num(row.next))
      .child(div().w(10).flex_none().text_color(signColor).child(sign))
      .child(div().flex_1().min_w(0).child(row.text));
  }

  button(id, label, t, enabled, onClick) {
    return div().id(id).flex_none().px(8).h(24).flex().items_center().rounded(5).border_1().border_color(t.border).text_size(12)
      .text_color(enabled ? t.foreground : t.dim).when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { if (enabled) onClick(cx); })
      .child(label);
  }

  render(cx) {
    this.follow(cx);
    const t = theme();
    const file = this.files[this.index];
    const [w, h] = SIZES[sizeIndex()];
    const add = this.rows.filter((r) => r.kind === "+").length, del = this.rows.filter((r) => r.kind === "-").length;
    const parts = (file?.path ?? "").split("/"), name = parts.pop();
    const size = sizeIndex();
    return v_flex().id("lite-diff").w(w).h(h).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") closeOverlay(this.p.overlay);
        else if (e.key === "left") this.step(-1, cx);
        else if (e.key === "right") this.step(1, cx);
      })
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
        .child(div().w(14).flex_none().text_size(12).text_color(file?.status === "A" ? t.ansi2 : file?.status === "D" || file?.status === "U" ? t.ansi1 : t.blocked).child(file?.status ?? ""))
        .child(h_flex().flex_1().min_w(0)
          .child(div().min_w(0).truncate().text_color(t.dim).child(parts.length ? `${parts.join("/")}/` : ""))
          .child(div().flex_none().font_semibold().child(name ?? "")))
        .child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${add}`))
        .child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${del}`))
        .child(this.button("diff-prev", "‹", t, this.index > 0, (cx) => this.step(-1, cx)))
        .child(div().flex_none().text_size(11).text_color(t.muted).child(`${this.index + 1}/${this.files.length}`))
        .child(this.button("diff-next", "›", t, this.index < this.files.length - 1, (cx) => this.step(1, cx)))
        .child(this.button("diff-smaller", "−", t, size > 0, (cx) => this.resize(-1, cx)))
        .child(div().flex_none().w(20).text_size(11).text_center().text_color(t.muted).child(SIZE_NAMES[size]))
        .child(this.button("diff-larger", "+", t, size < SIZES.length - 1, (cx) => this.resize(1, cx)))
        .child(this.button("diff-close", "Close", t, true, () => closeOverlay(this.p.overlay))))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(div().id("lite-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.width).h_full().child(v_virtual_list("lite-diff-rows", this.rows.length, ROW, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("lite-diff-rows").viewport_from_layout().absolute().inset_0())
        .when(this.rows.length === 0, (e) => e.child(div().absolute().top(8).left(12).text_color(t.dim).child(this.state))))
      .when(Boolean(this.state) && this.rows.length > 0, (e) => e.child(div().flex_none().px(12).py(4).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).child(this.state)));
  }
}
