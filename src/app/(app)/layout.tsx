import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return <AppShell user={user}>{children}</AppShell>;
}
