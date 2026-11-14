import { type Env, type Kind, type Member, type Props, hashToken, randomId, tokenRoom } from "./shared";

export const roomStub = (env: Env, room: string) => env.ROOM.get(env.ROOM.idFromName(room));

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "room";

export async function createRoom(env: Env, name: string, owner: { name: string; kind: Kind }) {
  const room = `${slug(name)}-${randomId(3)}`;
  return roomStub(env, room).init(room, name.trim().slice(0, 60), owner);
}

/** Local tests only (TEST_HOOKS): a new room whose members were written with the schema from before approval existed. */
export async function createLegacyRoom(env: Env, name: string) {
  const room = `${slug(name)}-${randomId(3)}`;
  return roomStub(env, room).initLegacy(room, name.trim().slice(0, 60));
}

/** A relay token (pl_<room>_<secret>) → the member it belongs to, or null. One DO call. `invite` is
 *  set when the token is an invite the owner has not approved yet: it gives no access by itself. */
export async function authToken(env: Env, token: string): Promise<(Props & { member: Member; invite?: boolean }) | null> {
  const room = tokenRoom(token);
  if (!room) return null;
  const who = await roomStub(env, room).access(await hashToken(token));
  return who ? { room, member_id: who.member.id, ...who } : null;
}

export function bearer(req: Request) {
  const h = req.headers.get("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}
