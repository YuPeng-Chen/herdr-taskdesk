// The task card of the focused terminal's worktree: what to do next, where it stands, the goal.
// Read-only: it reads CLAUDE.md (here or on the terminal's machine) and never writes.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, agents, exec, hc, readTextFile, theme, terminals } from "herdr";
import { bodyOf, cardStatus, loadCard } from "./card.js";

// The task-card skill's checker lives with the skill, on whichever machine has it; exit 127 = not here.
const LINT_SCRIPT = 'p="$HOME/.claude/skills/task-card/lint.py"; '
  + 'if [ ! -f "$p" ]; then echo "task-card skill not found: $p"; exit 127; fi; exec python3 "$p" "$@"';
const HANDOVER = "/task-card handover";

// A color with an alpha added; one that has an alpha already (t.border) is returned as it is.
const tint = (color, alpha) => (color.length === 7 ? color + alpha : color);

// hc reports a failure as {"error":{"message":…}} on stdout when it is not a terminal.
function hcError(r) {
  const text = (r.stderr || r.stdout).trim();
  try {
    return JSON.parse(text).error.message;
  } catch {
    return text || `hc exited with ${r.code}`;
  }
}
const REFRESH_MS = 5000;
const MAX_LINES = 14; // per section; the card itself is the full text
const BLOCKS = ["Next", "Current state", "Goal", "Model", "DUT"];

// Same place the Git and Changes panels look at, so all three follow the same terminal.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  // terminals() has the folder the program is in now; a pane's cwd can still be where it started.
  const live = f?.terminal ? terminals().find((x) => x.address === f.terminal)?.cwd : null;
  return { cwd: live || pane?.cwd || f?.cwd || space?.folder, on };
}
const keyOf = () => JSON.stringify(location());

export default class LiteCard extends View {
  init(_props, cx) {
    this.info = null;
    this.sig = "";
    this.context = null;
    this.loaded = false;
    this.lint = null; // null | { running } | { missing } | { failed } | { lines }
    this.confirm = false; // asking before a handover is sent
    this.note = null; // { text, error? }: what the last action did
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (this.loading) return;
    const { cwd, on } = location(), context = keyOf();
    if (context !== this.context) {
      this.context = context;
      this.sig = "";
      this.info = null;
      this.loaded = false;
      this.lint = null;
      this.confirm = false;
      this.note = null;
    }
    this.on = on;
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      let info = null;
      try {
        info = await loadCard(cwd, on, readTextFile);
      } catch {
        info = null;
      } finally {
        this.loading = false;
      }
      if (keyOf() !== context) return cx.notify(); // focus moved: render asks again
      const sig = JSON.stringify(info);
      if (sig === this.sig && this.loaded) return;
      this.sig = sig;
      this.info = info;
      this.loaded = true;
      this.lint = null; // the card changed: an old verdict no longer describes it
      cx.notify();
    });
  }

  // The agent in the focused terminal, if it is one.
  agentHere() {
    const terminal = focused()?.terminal;
    return terminal ? agents().find((a) => a.address === terminal) ?? null : null;
  }

  runLint(cx) {
    const info = this.info, on = this.on, context = this.context;
    if (!info || this.lint?.running) return;
    const paths = ["CLAUDE.md", ...(info.queued ? [".claude/CLAUDE.next.md"] : [])];
    this.lint = { running: true };
    cx.spawn(async (cx) => {
      let result;
      try {
        const r = await exec("sh", ["-c", LINT_SCRIPT, "sh", ...paths], { cwd: info.root, on });
        result = r.code === 127 ? { missing: r.stdout.trim() } : { lines: r.stdout.split("\n").filter(Boolean), stderr: r.code > 1 ? r.stderr.trim() : "" };
      } catch (e) {
        result = { failed: String(e) };
      }
      if (this.context === context) this.lint = result;
      cx.notify();
    });
    cx.notify();
  }

  // The skill's handover is the agent's job (it rewrites Current state and Next), so the button
  // types the command into the agent. Only into an idle one, and only after a yes.
  startHandover(cx) {
    const agent = this.agentHere();
    this.note = null;
    if (!agent) this.note = { text: "Focus the agent's terminal first: the handover is typed into it.", error: true };
    else if (agent.status !== "idle") this.note = { text: `That agent is ${agent.status}. Hand over when it is idle.`, error: true };
    else this.confirm = !this.confirm;
    cx.notify();
  }

  sendHandover(cx) {
    const agent = this.agentHere(), context = this.context;
    this.confirm = false;
    if (!agent) return cx.notify();
    this.note = { text: `Sending to ${agent.title}…` };
    cx.spawn(async (cx) => {
      let note;
      try {
        const r = await hc(["send", agent.address, HANDOVER, "--if", "idle"]);
        note = r.code === 0
          ? { text: "Sent. The agent rewrites Current state and Next; this card updates when it is done." }
          : { text: hcError(r), error: true };
      } catch (e) {
        note = { text: String(e), error: true };
      }
      if (this.context === context) this.note = note;
      cx.notify();
    });
    cx.notify();
  }

  chip(id, label, t, onClick, lit) {
    return div().id(id).flex_none().px(8).h(22).flex().items_center().rounded(5).border_1().border_color(lit ? t.accent + "88" : t.border)
      .text_size(11).text_color(lit ? t.accent : t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => onClick(cx)).child(label);
  }

  actions(t) {
    return h_flex().flex_none().px(12).py(6).gap(6).items_center().border_b(1).border_color(t.border)
      .child(this.chip("card-lint", this.lint?.running ? "Linting…" : "Lint", t, (cx) => this.runLint(cx)))
      .child(this.chip("card-handover", "Handover", t, (cx) => this.startHandover(cx), this.confirm));
  }

  // What the actions say back: the handover question, what it did, the lint verdict.
  results(t) {
    const line = (text, color) => div().text_size(11).text_color(color).child(text);
    const box = (id, color, kids) => v_flex().id(id).gap(4).p(8).rounded(6).border_1().border_color(tint(color, "66")).children(kids);
    const out = [];
    if (this.confirm) {
      const agent = this.agentHere();
      out.push(box("card-confirm", t.accent, [
        line(`Type ${HANDOVER} into "${agent?.title ?? "the agent"}"?`, t.foreground),
        ...(this.info?.queued ? [line("A next card is queued: the handover activates it.", t.muted)] : []),
        h_flex().gap(6)
          .child(this.chip("card-send", "Send", t, (cx) => this.sendHandover(cx), true))
          .child(this.chip("card-cancel", "Cancel", t, (cx) => { this.confirm = false; cx.notify(); })),
      ]));
    }
    if (this.note) out.push(box("card-note", this.note.error ? t.blocked : t.border, [line(this.note.text, this.note.error ? t.blocked : t.muted)]));
    const lint = this.lint;
    if (lint) {
      const dismiss = h_flex().child(this.chip("card-lint-x", "Dismiss", t, (cx) => { this.lint = null; cx.notify(); }));
      if (lint.running) out.push(box("card-lint-box", t.border, [line("Running lint.py…", t.muted)]));
      else if (lint.missing) out.push(box("card-lint-box", t.ansi3, [line(lint.missing, t.ansi3), line("Lint runs the task-card skill's lint.py on the terminal's machine.", t.muted), dismiss]));
      else if (lint.failed) out.push(box("card-lint-box", t.blocked, [line(`Cannot run lint: ${lint.failed}`, t.blocked), dismiss]));
      else {
        const verdict = (text) => {
          const m = /(\d+) error\(s\), (\d+) warning\(s\)/.exec(text);
          return m ? (m[1] !== "0" ? t.blocked : m[2] !== "0" ? t.ansi3 : t.ansi2) : t.muted;
        };
        const color = (text) => {
          const s = text.trim();
          return s.startsWith("ERROR") ? t.blocked : s.startsWith("WARN") ? t.ansi3 : verdict(text);
        };
        const worst = lint.lines.map(color).includes(t.blocked) ? t.blocked : lint.lines.map(color).includes(t.ansi3) ? t.ansi3 : t.ansi2;
        out.push(box("card-lint-box", worst, [
          ...lint.lines.map((l) => line(l, color(l))),
          ...(lint.stderr ? [line(lint.stderr, t.muted)] : []),
          dismiss,
        ]));
      }
    }
    return out;
  }

  block(label, lines, t, color) {
    const shown = lines.slice(0, MAX_LINES);
    return v_flex().gap(3)
      .child(div().text_size(10.5).font_medium().text_color(color ?? t.dim).child(label))
      .children(shown.map((l) => (l.trim() ? div().text_size(12).text_color(t.foreground).child(l) : div().h(4))))
      .when(lines.length > shown.length, (el) => el.child(div().text_size(11).text_color(t.dim).child("…")));
  }

  render(cx) {
    if (keyOf() !== this.context) this.refresh(cx);
    const t = theme();
    const info = this.info;
    const st = info ? cardStatus(info.card, Date.now()) : null;
    const badge = (text, color) => div().flex_none().px(5).h(18).flex().items_center().rounded(4).border_1().border_color(tint(color, "88")).text_size(10).text_color(color).child(text);
    const sizeColor = st?.over ? t.blocked : st?.full ? t.ansi3 : t.dim;
    return v_flex().id("lite-card").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13)
      .child(h_flex().h(34).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Task card"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(info?.card.title ?? ""))
        .when(Boolean(info?.queued), (el) => el.child(badge("next card", t.accent)))
        .when(Boolean(st), (el) => el.child(badge(`${st.lines}/${st.limit}`, sizeColor))))
      .when(Boolean(info), (el) => el.child(this.actions(t)))
      .child(v_flex().id("lite-card-body").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(14)
        .children(this.results(t))
        .when(!info, (el) => el.child(div().text_size(12).text_color(t.dim)
          .child(!this.loaded ? "Loading…" : "No task card in this worktree. Start one with /task-card new …")))
        .when(Boolean(info), (el) => el.children(BLOCKS.filter((name) => bodyOf(info.card, name).length).map((name) => {
          if (name === "Next") return this.block("NEXT", bodyOf(info.card, name), t, t.accent);
          if (name === "Current state") {
            const label = `CURRENT STATE${st.date ? ` · ${st.date}${st.age > 0 ? ` · ${st.age}d ago` : ""}` : ""}`;
            return this.block(label, bodyOf(info.card, name), t, st.stale ? t.ansi3 : t.dim);
          }
          return this.block(name.toUpperCase(), bodyOf(info.card, name), t);
        }))));
  }
}
