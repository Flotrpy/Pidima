"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/server/session";
import { OAuthError } from "@/server/mcp-oauth";
import {
  AuthorizeFatal,
  AuthorizeRedirectable,
  approveAuthorization,
  denyAuthorization,
  errorRedirect,
} from "@/server/mcp-consent";

const KEYS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "state",
  "resource",
];
const rawFrom = (f: FormData) =>
  Object.fromEntries(KEYS.map((k) => [k, (f.get(k) as string | null) ?? undefined]));

export async function approveConsentAction(form: FormData) {
  const user = await requireUser();
  let target: string;
  try {
    target = await approveAuthorization(user.id, String(form.get("workspace_id")), rawFrom(form));
  } catch (e) {
    if (e instanceof AuthorizeRedirectable) target = errorRedirect(e);
    else if (e instanceof AuthorizeFatal || e instanceof OAuthError)
      redirect(`/authorize/error?reason=${encodeURIComponent(e.message)}`);
    else throw e;
  }
  redirect(target);
}

export async function denyConsentAction(form: FormData) {
  await requireUser();
  let target: string;
  try {
    target = await denyAuthorization(rawFrom(form));
  } catch (e) {
    if (e instanceof AuthorizeRedirectable) target = errorRedirect(e);
    else if (e instanceof AuthorizeFatal)
      redirect(`/authorize/error?reason=${encodeURIComponent(e.message)}`);
    else throw e;
  }
  redirect(target);
}
