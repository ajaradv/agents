import { agentArtOrNull } from "./agent-art.ts";
import { listShipAdws, readShips } from "./fleet-layers.ts";
import { groupableAgentIds, readAdwPhases, readGroups, type Group } from "./groups.ts";
import { escapeHtml } from "./quota.ts";

function faces(ids: string[], lead: string): string {
  return ids
    .map(
      (id) =>
        `<span class="row group-member">${
          agentArtOrNull(id)
            ? `<img class="avatar avatar-sm" src="${agentArtOrNull(id)}" alt="" width="28" height="28" />`
            : `<span class="avatar avatar-sm portrait-initials">${escapeHtml(id.slice(0, 2).toUpperCase())}</span>`
        }${escapeHtml(id)}${id === lead ? ` <span class="detent">lead</span>` : ""}</span>`,
    )
    .join("");
}

async function adwOptions(selected?: Group["adw"]): Promise<string> {
  const opts = [`<option value="">No ADW label</option>`];
  for (const ship of await readShips()) {
    if (!ship.path) continue;
    for (const chain of await listShipAdws(ship.path)) {
      const v = `${ship.id}::${chain}`;
      const sel = selected && selected.ship === ship.id && selected.chain === chain ? " selected" : "";
      opts.push(`<option value="${escapeHtml(v)}"${sel}>${escapeHtml(ship.id)} · ${escapeHtml(chain)}</option>`);
    }
  }
  return opts.join("");
}

export async function groupsPanelHtml(error = ""): Promise<string> {
  const groups = await readGroups();
  const allowed = groupableAgentIds();
  const list = groups.length
    ? groups
        .map(
          (g) => `<li class="agent stack">
        <div class="between">
          <span class="sheet-title">${escapeHtml(g.name)}</span>
          <span class="row">
            <button type="button" class="btn" @click="openGroup('${escapeHtml(g.id)}')">Open</button>
            <button type="button" class="btn" hx-post="/api/groups/${escapeHtml(g.id)}/delete" hx-target="#groups" hx-swap="innerHTML" hx-confirm="Delete group ${escapeHtml(g.name)}?">Delete</button>
          </span>
        </div>
        <div class="row-wrap">${faces(g.members, g.lead)}</div>
        ${g.adw ? `<p class="muted">ADW ${escapeHtml(g.adw.ship)} · ${escapeHtml(g.adw.chain)}</p>` : ""}
      </li>`,
        )
        .join("")
    : `<li class="muted">No groups yet.</li>`;

  const memberBoxes = allowed
    .map(
      (id) => `<label class="row"><input type="checkbox" name="members" value="${escapeHtml(id)}" /> ${escapeHtml(id)}</label>`,
    )
    .join("");
  const leadOpts = allowed.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join("");

  return `<div class="stack">
    <div class="between"><h3>Groups</h3><span class="muted">work goes to the lead</span></div>
    ${error ? `<p class="warn">${escapeHtml(error)}</p>` : ""}
    <ul class="agent-list">${list}</ul>
    <details class="fold">
      <summary>New group</summary>
      <form class="stack group-form" hx-post="/api/groups" hx-target="#groups" hx-swap="innerHTML">
        <label class="stack">Name <input class="field" name="name" required maxlength="60" /></label>
        <fieldset class="stack"><legend>Members</legend><div class="row-wrap">${memberBoxes || `<span class="muted">No assistants registered.</span>`}</div></fieldset>
        <label class="stack">Lead <select class="field" name="lead" required>${leadOpts}</select></label>
        <label class="stack">ADW label <select class="field" name="adw">${await adwOptions()}</select></label>
        <p class="muted">Firstmate and its workers cannot join a group. The ADW label is display only; it does not launch the workflow.</p>
        <button class="btn btn-ink" type="submit">Save group</button>
      </form>
    </details>
  </div>`;
}

/** Fleet leaf: each labelled group's chain as ordered phase chips. Not a claim about a running session. */
export async function groupAdwSectionHtml(): Promise<string> {
  const groups = (await readGroups()).filter((g) => g.adw);
  if (groups.length === 0) return "";
  const ships = new Map((await readShips()).map((s) => [s.id, s]));
  const cards: string[] = [];
  for (const g of groups) {
    const ship = ships.get(g.adw!.ship);
    const phases = ship?.path ? await readAdwPhases(ship.path, g.adw!.chain) : [];
    const chips = phases.length
      ? `<ol class="phase-chips">${phases.map((p) => `<li class="detent">${escapeHtml(p)}</li>`).join("")}</ol>`
      : `<p class="warn">Could not read ${escapeHtml(g.adw!.chain)} on ${escapeHtml(g.adw!.ship)}.</p>`;
    cards.push(`<article class="sheet stack">
      <div class="between">
        <h3>${escapeHtml(g.name)}</h3>
        <span class="detent">${escapeHtml(g.adw!.ship)}</span>
      </div>
      <p class="muted">${escapeHtml(g.adw!.chain)} · lead ${escapeHtml(g.lead)}</p>
      ${chips}
    </article>`);
  }
  return `<div class="between"><h3>Groups and ADWs</h3><span class="muted">chain, not live status</span></div>
    <div class="grid-2">${cards.join("")}</div>`;
}
