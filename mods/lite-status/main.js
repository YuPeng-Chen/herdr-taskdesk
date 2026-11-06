// Statusline for the sidebar: branch, ahead/behind, uncommitted files, agents.
// One `git status --porcelain=v2 --branch` call, read every few seconds.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, focused, agents, exec, theme, layout, run, nextCommand, terminals } from "herdr";

// The right-hand column and its blocks, by their ids in layouts/shepherdr-lite.json.
const SIDE = "side";
const PANELS = [
  { command: "card", id: "side-card", label: "Card" },
  { command: "git", id: "side-git", label: "Git" },
  { command: "changes", id: "side-changes", label: "Changes" },
];
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];

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

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const hidden = (id) => Boolean(find(layout(), id)?.hidden);

// The column is shown exactly when one of its blocks is, so hiding the last one takes it too.
function toggle(id) {
  const show = hidden(id);
  const anyShown = PANELS.some((p) => (p.id === id ? show : !hidden(p.id)));
  run(show ? "layout.show" : "layout.hide", { id });
  run(anyShown ? "layout.show" : "layout.hide", { id: SIDE });
}

// `# branch.head main`, `# branch.ab +1 -2`, then one line per changed path.
function parse(out) {
  const state = { branch: null, ahead: 0, behind: 0, changed: 0 };
  for (const line of out.split("\n").filter(Boolean)) {
    if (!line.startsWith("#")) state.changed += 1;
    else if (line.startsWith("# branch.head ")) state.branch = line.slice(14);
    else if (line.startsWith("# branch.ab ")) [state.ahead, state.behind] = line.slice(12).split(" ").map((n) => Math.abs(Number(n)));
  }
  return state;
}

export default class LiteStatus extends View {
  init(_props, cx) {
    this.git = null;
    this.sig = "";
    this.context = null;
    this.refresh(cx);
    cx.timer.every(5000, (cx) => this.refresh(cx));
    // `herdr-app do lite-status.git` (or a key bound to it) does what the button does.
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        const panel = PANELS.find((p) => p.command === command);
        if (panel) toggle(panel.id);
      }
    });
  }

  refresh(cx) {
    if (this.loading) return;
    const { cwd, on } = location(), context = keyOf();
    if (context !== this.context) {
      this.context = context;
      this.sig = "";
      this.git = null;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      let next = null;
      try {
        const r = await exec("git", [...READ, "status", "--porcelain=v2", "--branch", "--untracked-files=normal"], { cwd, on });
        next = r.code === 0 ? parse(r.stdout) : null;
      } catch {
        next = null;
      } finally {
        this.loading = false;
      }
      if (keyOf() !== context) return cx.notify(); // focus moved: render asks again
      const sig = JSON.stringify(next);
      if (sig === this.sig) return;
      this.sig = sig;
      this.git = next;
      cx.notify();
    });
  }

  render(cx) {
    if (keyOf() !== this.context) this.refresh(cx);
    const t = theme();
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const g = this.git;
    const icon = (name, color) => svg(`mods/workspace-chrome/${name}.svg`).size(13).flex_none().text_color(color ?? t.muted);
    // A button that is lit while its panel is shown.
    const button = (p) => {
      const on = !hidden(p.id);
      return div().id(`toggle-${p.command}`).flex_none().h(20).px(8).flex().items_center().rounded(5).border_1()
        .border_color(on ? t.accent + "88" : t.border).text_size(11).text_color(on ? t.accent : t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click(() => toggle(p.id)).child(p.label);
    };
    return h_flex().id("lite-status").size_full().px(12).gap(10).items_center().bg(t.chrome).border_t(1).border_color(t.border)
      .text_size(11.8).text_color(t.muted)
      .when(Boolean(space?.machine), (el) => el.child(h_flex().gap(5).items_center().flex_none().child(icon("server")).child(space.machine)))
      .when(Boolean(g?.branch), (el) => el.child(h_flex().gap(5).items_center().min_w(0).child(icon("branch")).child(div().truncate().child(g.branch))))
      .when(g?.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`↑${g.ahead}`)))
      .when(g?.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`↓${g.behind}`)))
      .when(g?.changed > 0, (el) => el.child(h_flex().gap(5).items_center().flex_none().text_color(t.blocked)
        .child(div().size(6).rounded(3).bg(t.blocked)).child(`${g.changed}`)))
      .child(div().flex_1())
      .child(h_flex().gap(6).items_center().flex_none()
        .child(div().size(6).rounded(3).bg(needs > 0 ? t.blocked : t.dim))
        .child(`${list.length} agents`)
        .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .children(PANELS.map(button));
  }
}
