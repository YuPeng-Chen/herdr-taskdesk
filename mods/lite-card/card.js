// Task cards: a worktree's CLAUDE.md as written by the task-card skill.
// Shared by lite-card and lite-agents; keep ../lite-card/card.js and ../lite-agents/card.js identical.
// Headings are matched by prefix, like the skill's lint.py, so a template tweak does not break it.

const SECTIONS = ["Goal", "Must not change", "Decided", "Model", "DUT", "Pre-approved", "Ask first", "How to drive",
  "Milestones", "Known facts", "Current state", "Next", "Handover rule"];
const LIMIT = 80;
const LIMIT_MILESTONES = 110;
const STALE_DAYS = 3; // Current state older than this was not rewritten at the last handover
const LEVELS = 3; // the folder itself and two parents: an agent may sit in a subfolder
const DATE = /\d{4}-\d{2}-\d{2}/;

// A card has a Goal and a Next; any other CLAUDE.md is not one.
export function parseCard(text) {
  const lines = text.split("\n");
  const sections = {};
  let title = "";
  let name = null;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      const head = line.slice(3).trim();
      name = SECTIONS.find((n) => head.startsWith(n)) ?? head;
      sections[name] = { head, body: [] };
    } else if (line.startsWith("# ") && !title) title = line.slice(2).replace(/\s*[—-]\s*task card\s*$/, "").trim();
    else if (name) sections[name].body.push(line.trimEnd());
  }
  for (const s of Object.values(sections)) {
    while (s.body.length && !s.body[0].trim()) s.body.shift();
    while (s.body.length && !s.body.at(-1).trim()) s.body.pop();
  }
  const count = lines.length - (text.endsWith("\n") ? 1 : 0);
  return { title, sections, lines: count, isCard: Boolean(sections.Goal && sections.Next) };
}

// The numbers a view shows: size against the limit, and how old Current state is.
export function cardStatus(card, now) {
  const date = DATE.exec(card.sections["Current state"]?.head ?? "")?.[0] ?? null;
  const age = date ? Math.floor((now - Date.parse(date)) / 86400000) : null;
  const limit = card.sections.Milestones ? LIMIT_MILESTONES : LIMIT;
  return { lines: card.lines, limit, over: card.lines > limit, full: card.lines >= limit - 4, date, age, stale: age !== null && age > STALE_DAYS };
}

export const bodyOf = (card, name) => card.sections[name]?.body ?? [];

export function oneLine(lines, max) {
  const text = lines.join(" ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const parentOf = (p) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : null;
};

// The nearest card at or above `cwd`, and whether a next card is queued beside it.
// `read` is herdr's readTextFile: null for a missing file, `on` picks the machine.
export async function loadCard(cwd, on, read) {
  let dir = cwd;
  for (let i = 0; dir && i < LEVELS; i += 1, dir = parentOf(dir)) {
    const sep = dir.includes("\\") ? "\\" : "/";
    const text = await read(`${dir}${sep}CLAUDE.md`, { on }).catch(() => null);
    const card = text ? parseCard(text) : null;
    if (!card?.isCard) continue;
    const next = await read(`${dir}${sep}.claude${sep}CLAUDE.next.md`, { on }).catch(() => null);
    return { root: dir, card, queued: next !== null };
  }
  return null;
}
