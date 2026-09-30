"use client";

import { useState } from "react";
import { Button, TextField } from "@/components/ui";
import { authClient } from "@/lib/auth-client";
import type { AuthMethod } from "@/lib/env";

const LABELS: Record<Exclude<AuthMethod, "email">, string> = {
  google: "Continue with Google",
  github: "Continue with GitHub",
};

export function SignInForm({
  methods,
  callbackURL = "/inbox",
}: {
  methods: AuthMethod[];
  callbackURL?: string;
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const social = methods.filter((m): m is Exclude<AuthMethod, "email"> => m !== "email");

  if (methods.length === 0) {
    return (
      <div className="alert alert-warn" role="status">
        Sign-in is not configured for this deployment. An administrator must enable at least one
        sign-in method.
      </div>
    );
  }

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    const { error } = await authClient.signIn.magicLink({ email, callbackURL });
    setStatus(error ? "error" : "sent");
  }

  return (
    <div className="stack" style={{ ["--gap" as string]: "20px" }}>
      {social.map((provider) => (
        <Button
          key={provider}
          className="btn-block"
          onClick={() => authClient.signIn.social({ provider, callbackURL })}
        >
          {LABELS[provider]}
        </Button>
      ))}
      {social.length > 0 && methods.includes("email") ? (
        <p className="muted" style={{ textAlign: "center" }}>
          or
        </p>
      ) : null}
      {methods.includes("email") ? (
        status === "sent" ? (
          <div className="alert" role="status">
            Check your email. If an account can be created or found for {email}, a one-time sign-in
            link is on its way. It expires in 10 minutes.
          </div>
        ) : (
          <form onSubmit={sendLink} className="stack">
            <TextField
              id="email"
              label="Email address"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              hint="We email a one-time link. This also verifies your address."
              error={
                status === "error"
                  ? "The link could not be sent. Try again in a moment."
                  : undefined
              }
            />
            <Button
              type="submit"
              variant="primary"
              className="btn-block"
              disabled={status === "sending"}
            >
              {status === "sending" ? "Sending…" : "Email me a sign-in link"}
            </Button>
          </form>
        )
      ) : null}
    </div>
  );
}
