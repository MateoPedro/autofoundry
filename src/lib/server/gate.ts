import { createHmac, timingSafeEqual } from "node:crypto";

// Who may press Launch and End. The dashboard itself stays public.
//
// Naïve's Studio can open an app whose DASHBOARD_TOKEN secret it holds: apps.entry(id) answers
// { url, ticket }, where the ticket is "a two-minute HMAC keyed by" the token, POSTed to the url as
// a form field (SDK 0.12.3, apps.entry). The signed fields and their encoding aren't documented, and
// minting a ticket to inspect needs the token set on the live app, which wasn't done (Nov 8). So only
// DASHBOARD_PASSWORD signs anyone in; a posted ticket is ignored. The password is readable only
// by members of the Naïve organization (apps.access, an audited reveal).

export const OPERATOR_COOKIE = "foundry_operator";
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;

export type GateEnv = Partial<Record<string, string>>;

// The cookie is keyed by the gate's secret, so rotating the password signs every browser out.
export function gateSecret(env: GateEnv): string | undefined {
  return env.DASHBOARD_TOKEN?.trim() || env.DASHBOARD_PASSWORD?.trim() || undefined;
}

export function operatorCookieValue(token: string): string {
  return createHmac("sha256", token).update("foundry-operator").digest("hex");
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function isOperator(cookie: string | undefined, token: string | undefined): boolean {
  return !!cookie && !!token && sameText(cookie, operatorCookieValue(token));
}

export function cookieFrom(request: Request, name = OPERATOR_COOKIE): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

export async function entryResponse(request: Request, env: GateEnv): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const password = form?.get("password");
  const secret = gateSecret(env);
  const expected = env.DASHBOARD_PASSWORD?.trim();
  const ok = !!secret && typeof password === "string" && !!expected && sameText(password, expected);
  if (!ok) return new Response(null, { status: 303, headers: { location: "/?entry=failed" } });
  return new Response(null, {
    status: 303,
    headers: {
      location: "/",
      "set-cookie": `${OPERATOR_COOKIE}=${operatorCookieValue(secret)}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
