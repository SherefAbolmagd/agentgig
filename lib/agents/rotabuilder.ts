import { z } from "zod";
import { GatewayError } from "@/lib/errors";
import { slackPost, notDelivered, type Delivery } from "@/lib/connectors";
import { generateJson, textPart } from "@/lib/vertex";
import { defineAgent, groundingPrompt } from "./types";

/**
 * RotaBuilder: Gemini proposes a week of shifts; code then checks every rule
 * (availability, max hours, minimum cover) so the owner sees real problems.
 */

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export const RotaInput = z.object({
  staffCsv: z.string().trim().min(10).max(20_000).describe("name, role, max_hours, unavailable (days separated by spaces)"),
  weekStarting: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  openDays: z.array(z.enum(DAYS)).min(1).default(["Mon", "Tue", "Wed", "Thu", "Fri"]),
  shifts: z.array(z.object({ name: z.string(), start: z.string(), end: z.string() })).min(1).default([
    { name: "Morning", start: "07:00", end: "12:00" },
    { name: "Afternoon", start: "12:00", end: "17:00" },
  ]),
  minStaffPerShift: z.number().int().min(1).max(20).default(2),
});
export type RotaInput = z.infer<typeof RotaInput>;

export interface Staff {
  name: string;
  role: string;
  maxHours: number;
  unavailable: string[];
}

export function parseStaffCsv(csv: string): Staff[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  const first = lines[0]?.toLowerCase() ?? "";
  const body = first.includes("name") && first.includes("max") ? lines.slice(1) : lines;
  if (!body.length) throw new GatewayError("INVALID_INPUT", "Add at least one person: name, role, max hours, unavailable days.");
  return body.map((l, i) => {
    const [name, role = "", max = "40", unavailable = ""] = l.split(",").map((s) => s.trim());
    const maxHours = Number(max);
    if (!name || !Number.isFinite(maxHours)) throw new GatewayError("INVALID_INPUT", `Line ${i + 1}: use “name, role, max hours, unavailable days”.`);
    const days = unavailable.split(/[\s;/]+/).map((d) => d.slice(0, 3)).map((d) => d.charAt(0).toUpperCase() + d.slice(1).toLowerCase()).filter((d) => (DAYS as readonly string[]).includes(d));
    return { name, role, maxHours, unavailable: days };
  });
}

const hoursBetween = (start: string, end: string) => {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return Math.max(0, (eh * 60 + em - (sh * 60 + sm)) / 60);
};

const ModelOutput = z.object({
  assignments: z.array(z.object({ day: z.enum(DAYS), shift: z.string(), staff: z.array(z.string()) })),
  notes: z.string().describe("One or two sentences on trade-offs you made"),
});

export type RotaOutput = {
  weekStarting: string;
  assignments: { day: (typeof DAYS)[number]; shift: string; start: string; end: string; staff: string[] }[];
  hoursByPerson: Record<string, number>;
  violations: string[];
  notes: string;
  slackText: string;
};

/** Checks a rota against the rules; returns plain-English problems. */
export function checkRota(input: RotaInput, staff: Staff[], assignments: RotaOutput["assignments"]): { hours: Record<string, number>; violations: string[] } {
  const hours: Record<string, number> = Object.fromEntries(staff.map((s) => [s.name, 0]));
  const violations: string[] = [];
  const byName = new Map(staff.map((s) => [s.name.toLowerCase(), s]));
  for (const a of assignments) {
    if (a.staff.length < input.minStaffPerShift) violations.push(`${a.day} ${a.shift}: ${a.staff.length} of ${input.minStaffPerShift} people.`);
    for (const n of a.staff) {
      const s = byName.get(n.toLowerCase());
      if (!s) {
        violations.push(`${a.day} ${a.shift}: “${n}” isn't on the staff list.`);
        continue;
      }
      if (s.unavailable.includes(a.day)) violations.push(`${s.name} is unavailable on ${a.day} but is on the ${a.shift} shift.`);
      hours[s.name] += hoursBetween(a.start, a.end);
    }
  }
  for (const s of staff) if (hours[s.name] > s.maxHours) violations.push(`${s.name} has ${hours[s.name]} hours (max ${s.maxHours}).`);
  for (const day of input.openDays) for (const sh of input.shifts) {
    if (!assignments.some((a) => a.day === day && a.shift === sh.name)) violations.push(`${day} ${sh.name} has nobody assigned.`);
  }
  return { hours, violations };
}

export const rotaBuilder = defineAgent<RotaInput, RotaOutput>({
  slug: "rotabuilder",
  skillId: "rota.generate",
  tier: "flash",
  inputSchema: RotaInput,
  scrubFields: [],
  files: null,

  async run({ input, grounding }) {
    const staff = parseStaffCsv(input.staffCsv);
    const res = await generateJson({
      tier: "flash",
      system:
        "You build fair weekly staff rotas. Every open day and shift needs at least the minimum staff. Never schedule anyone on a day they're unavailable or past their maximum hours. Spread hours fairly. Use staff names exactly as given.",
      parts: [
        textPart(
          [
            groundingPrompt(grounding),
            `Week starting ${input.weekStarting}. Open: ${input.openDays.join(", ")}.`,
            `Shifts: ${input.shifts.map((s) => `${s.name} ${s.start}–${s.end} (${hoursBetween(s.start, s.end)}h)`).join("; ")}. Minimum ${input.minStaffPerShift} per shift.`,
            "Staff:",
            ...staff.map((s) => `- ${s.name} (${s.role}), max ${s.maxHours}h${s.unavailable.length ? `, unavailable ${s.unavailable.join(" ")}` : ""}`),
          ].join("\n"),
        ),
      ],
      schema: ModelOutput,
      temperature: 0.2,
      thinkingBudget: 1024,
    });
    const shiftTimes = new Map(input.shifts.map((s) => [s.name, s]));
    const assignments = res.data.assignments
      .filter((a) => shiftTimes.has(a.shift))
      .map((a) => ({ ...a, start: shiftTimes.get(a.shift)!.start, end: shiftTimes.get(a.shift)!.end }));
    const { hours, violations } = checkRota(input, staff, assignments);
    const slackText = [
      `*Rota for the week of ${input.weekStarting}*`,
      ...input.openDays.map((d) => `*${d}*  ${assignments.filter((a) => a.day === d).map((a) => `${a.shift} (${a.start}–${a.end}): ${a.staff.join(", ")}`).join("  ·  ")}`),
    ].join("\n");
    return { ...res, output: { weekStarting: input.weekStarting, assignments, hoursByPerson: hours, violations, notes: res.data.notes, slackText } };
  },

  approval(o) {
    return {
      title: o.violations.length ? `Rota for ${o.weekStarting} has ${o.violations.length} problem${o.violations.length > 1 ? "s" : ""}` : `Rota for ${o.weekStarting} is ready`,
      preview: o.violations[0] ?? o.notes,
      severity: o.violations.length ? "check" : "info",
      actions: [
        { id: "approve", label: "Post to the team", kind: "approve" },
        { id: "skip", label: "Not now", kind: "skip" },
      ],
    };
  },

  async deliver(o, { userId }): Promise<Delivery> {
    const posted = await slackPost(userId, { text: o.slackText });
    if (!posted) return notDelivered("Rota ready. Connect Slack to post it to your team channel.");
    return { delivered: true, summary: "Posted the rota to Slack", links: posted.url ? [{ label: "Open in Slack", url: posted.url }] : [] };
  },
});
