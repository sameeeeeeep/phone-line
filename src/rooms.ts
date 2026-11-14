import { type Env, type Kind, type Member, type Props, hashToken, randomId, tokenRoom } from "./shared";

export const roomStub = (env: Env, room: string) => env.ROOM.get(env.ROOM.idFromName(room));

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "room";

export async function createRoom(env: Env, name: string, owner: { name: string; kind: Kind }) {
  const room = `${slug(name)}-${randomId(3)}`;
  return roomStub(env, room).init(room, name.trim().slice(0, 60), owner);
}

/** A relay token (pl_<room>_<secret>) → the member it belongs to, or null. One DO call. */
export async function authToken(env: Env, token: string): Promise<(Props & { member: Member }) | null> {
  const room = tokenRoom(token);
  if (!room) return null;
  const member = await roomStub(env, room).authHash(await hashToken(token));
  return member ? { room, member_id: member.id, member } : null;
}

export function bearer(req: Request) {
  const h = req.headers.get("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}
