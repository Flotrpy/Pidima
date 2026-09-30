import { redirect } from "next/navigation";
import { SignInForm } from "@/components/auth/SignInForm";
import { configuredAuthMethods, getEnv } from "@/lib/env";
import { getSessionUser } from "@/server/session";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function SignInPage() {
  if (await getSessionUser()) redirect("/inbox");
  const methods = configuredAuthMethods(getEnv());
  return (
    <div className="container" style={{ maxWidth: 440, paddingTop: 64 }}>
      <h1>Sign in to AI Action Inbox</h1>
      <p className="muted">
        Your AI can prepare the work. You decide what gets done. New here? The same options create
        your account.
      </p>
      <div className="card">
        <SignInForm methods={methods} />
      </div>
    </div>
  );
}
