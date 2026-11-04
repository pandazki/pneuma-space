import { createHmac } from "node:crypto";

export type TurnCredential = { username: string; credential: string };

export function mintTurnCredential(secret: string, ttlSeconds: number, userId: string): TurnCredential {
  const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:${userId}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return { username, credential };
}

if (import.meta.main) {
  const secret = process.env.PNEUMA_RTC_SECRET;
  if (!secret) throw new Error("PNEUMA_RTC_SECRET is required");
  const ttl = Number(process.argv[2] ?? 3600);
  console.log(JSON.stringify(mintTurnCredential(secret, ttl, process.argv[3] ?? "alice")));
}
