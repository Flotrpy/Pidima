import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { requireActiveContext } from "@/server/active-workspace";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { user, role, workspace } = await requireActiveContext();
  return (
    <AppShell user={user} role={role} workspaceName={workspace.name}>
      {children}
    </AppShell>
  );
}
