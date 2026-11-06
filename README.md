# herdr-taskdesk

A [Herdr](https://herdr.dev) layout for working with coding agents: your terminals in the middle,
and everything you want to glance at around them.

```
+-----------+---------------------------+-------------+
| Spaces    |  tabs                     | Task card   |
|           +---------------------------+-------------+
| Agents    |                           | Git graph   |
| (+ card   |  terminals                +-------------+
|  "Next")  |                           | Changes     |
|           +---------------------------+ (folder     |
|           |  statusline  [Card][Git]  |  tree)      |
+-----------+---------------------------+-------------+
```

## What is in it

| Mod | What it does |
|---|---|
| `lite-card` | **Task card** panel for the focused terminal, with **Lint** and **Handover** buttons. |
| `lite-agents` | Agents list that also shows each agent's card line (`Next`, stale age, `lines/limit`). |
| `lite-git` | Git graph. Hover for the full message, author and date. Click a commit to show its files in Changes, right-click to copy its hash. |
| `lite-changes` | Changes as a scrollable folder tree. Shows uncommitted files, or the files of the commit selected in Git. |
| `lite-diff` | Diff window for one file. **Pop out** from Changes; it follows the file you click afterwards. Size steps S / M / L / XL. |
| `lite-status` | Statusline: machine, branch, ahead/behind, changed files, agent count, and buttons to toggle the right-hand panels. |

All of them follow the **live** folder of the focused terminal, including terminals on remote machines.

## Install

1. Copy `mods/*` into `~/.config/herdr-app/mods/` and `layouts/taskdesk.json` into `~/.config/herdr-app/layouts/`.
2. Switch to it: `herdr-app do layout.switch --name taskdesk` (or cycle with `ctrl-shift-l`).

Herdr hot reloads, so there is nothing to restart. `herdr-app check mods/<name>` checks one mod.

The layout also uses Herdr's shipped mods (`workspace-chrome`, `spaces`, `tabs`, `pane`, `files`, `changes`).
`lite-agents` and `lite-changes` were cloned from the shipped `agents` and `changes` (0.1.13).

## The Task card

The card panel and the agents list read a `task-card` Agent Skill's card file in the terminal's folder.
Without the skill installed on that machine, the panel shows an empty state and the Lint / Handover buttons
do not appear. Everything else works without it.

- **Lint** runs `~/.claude/skills/task-card/lint.py` on the machine of the terminal and shows the verdict.
- **Handover** types `/task-card handover` into the focused agent (only when it is idle).

## Commands

Every command can be run with `herdr-app do <command>` or bound to a key in `keys.json`.

| Command | Effect |
|---|---|
| `lite-status.card` / `.git` / `.changes` | Toggle that right-hand panel (the column goes with the last one). |
| `lite-git.next` / `.prev` | Select the older / newer commit. |
| `lite-changes.popout` | Open the diff window for the selected file. |
| `lite-changes.next` / `.prev` | Select the next / previous file in tree order (the diff window follows). |
| `lite-diff.next` / `.prev` / `.smaller` / `.larger` / `.close` | Control the diff window. |

## Notes

- Herdr windows have no drag edge, so the diff window is resized in steps with the `-` / `+` buttons.
- `mods/lite-card/card.js` and `mods/lite-agents/card.js` must stay identical.
- Mods talk through Herdr `shared` keys: `lite.commit` (Git to Changes) and `lite.diff.view` (Changes to Diff).

## Credits

The left-hand skeleton of the layout started from the Shepherdr layout by eliasstravik; the rest is new.
Shipped Herdr mods are the base of `lite-agents` and `lite-changes`.
