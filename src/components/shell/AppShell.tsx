import Link from "next/link";
import type { ReactNode } from "react";
import { signOutAction } from "@/app/actions/auth";
import { Button } from "@/components/ui";
import { MobileMenu } from "./MobileMenu";
import { APP_NAV } from "./nav";
import { NAV_PERMISSION, can, type Role } from "@/lib/permissions";

export function AppShell({
  user,
  role,
  workspaceName,
  children,
}: {
  user: { name: string };
  role: Role;
  workspaceName: string;
  children: ReactNode;
}) {
  // Navigation is a convenience only; every page and action re-checks on the server.
  const nav = APP_NAV.filter((i) => {
    const p = NAV_PERMISSION[i.href];
    return !p || can(role, p);
  });
  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="row">
          <div className="mobile-only">
            <MobileMenu items={nav} />
          </div>
          <Link href="/inbox" className="brand">
            <span className="brand-mark" aria-hidden="true" />
            AI Action Inbox
          </Link>
        </div>
        <div className="row">
          <span className="muted app-user">
            {workspaceName} · {role} · {user.name}
          </span>
          <form action={signOutAction}>
            <Button type="submit" small>
              Sign out
            </Button>
          </form>
        </div>
      </header>
      <nav aria-label="Application" className="app-sidenav desktop-only">
        <ul className="side-list">
          {nav.map((i) => (
            <li key={i.href}>
              <Link href={i.href}>{i.label}</Link>
            </li>
          ))}
        </ul>
      </nav>
      <main id="main" className="app-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
