import { getAuth } from "@/server/auth";
import { outbox } from "@/server/mailer";

/** Signs a user in through the real magic-link flow; returns a Cookie header for later calls. */
export async function signInAs(email: string, name = "Test User"): Promise<Headers> {
  const auth = getAuth();
  await auth.api.signInMagicLink({ body: { email, name }, headers: new Headers() });
  const link = outbox
    .filter((m) => m.to === email)
    .at(-1)!
    .text.match(/https?:\/\/\S+/)![0];
  const token = new URL(link).searchParams.get("token")!;
  const res = await auth.api.magicLinkVerify({
    query: { token },
    headers: new Headers(),
    asResponse: true,
  });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return new Headers({ cookie });
}
