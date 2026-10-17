/**
 * Addresses for the people in the store video. Anyone who receives an email
 * an agent sends on camera gets a plus-address of the store's own Gmail
 * (name+emma@gmail.com), so the email is really delivered, lands back in the
 * same inbox, and nothing goes to a stranger. Worked out from the video
 * account's Google connection, so no address is written in the repo.
 */
export const VIDEO_UID = "video-cafe-lumen";

export const PEOPLE = {
  sophie: { name: "Sophie Turner", tag: "sophie" },
  emma: { name: "Emma Clarke", tag: "emma" },
  tom: { name: "Tom Reid", tag: "tom" },
  northside: { name: "Hannah Price", tag: "northside" },
  calder: { name: "Calder Candle Co.", tag: "calder" },
  northernWax: { name: "Northern Wax Co.", tag: "northernwax" },
  leah: { name: "Leah Morgan", tag: "leah" },
} as const;
export type Person = keyof typeof PEOPLE;

/** The store's Gmail address, from the video account's Google connection. */
export async function storeInbox(): Promise<string> {
  const { googleSelf } = await import("@/lib/connectors/google");
  const self = await googleSelf(VIDEO_UID);
  if (!self) throw new Error("Connect Google on the video account first.");
  return self;
}

/** Every person's plus-address of the store's Gmail. */
export async function videoAddresses(): Promise<Record<Person, string>> {
  const [local, domain] = (await storeInbox()).split("@");
  return Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [k, `${local}+${p.tag}@${domain}`])) as Record<Person, string>;
}
