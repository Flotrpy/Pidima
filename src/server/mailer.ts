import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { getEnv } from "@/lib/env";

export type OutgoingMail = { to: string; subject: string; text: string };

/** Test/dev inspection point; never populated in production. */
export const outbox: OutgoingMail[] = [];

let transport: Transporter | undefined;

export async function sendMail(mail: OutgoingMail): Promise<void> {
  const env = getEnv();
  if (env.NODE_ENV === "test") {
    outbox.push(mail);
    return;
  }
  if (!env.SMTP_URL || !env.SMTP_FROM) throw new Error("Email delivery is not configured");
  transport ??= nodemailer.createTransport(env.SMTP_URL);
  await transport.sendMail({ from: env.SMTP_FROM, ...mail });
}
