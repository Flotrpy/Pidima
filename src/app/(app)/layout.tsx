import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { requireActiveContext } from "@/server/active-workspace";
import { unreadCount } from "@/server/notifications";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { user, role, workspace } = await requireActiveContext();
  const unread = await unreadCount(user.id);
  return (
    <AppShell user={user} role={role} workspaceName={workspace.name} unread={unread}>
      {children}
    </AppShell>
  );
}
