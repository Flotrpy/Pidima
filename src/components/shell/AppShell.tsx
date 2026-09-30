import Link from "next/link";
import type { ReactNode } from "react";
import { signOutAction } from "@/app/actions/auth";
import { Button } from "@/components/ui";
import { MobileMenu } from "./MobileMenu";
import { APP_NAV } from "./nav";

export function AppShell({ user, children }: { user: { name: string }; children: ReactNode }) {
  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="row">
          <div className="mobile-only">
            <MobileMenu items={APP_NAV} />
          </div>
          <Link href="/inbox" className="brand">
            <span className="brand-mark" aria-hidden="true" />
            AI Action Inbox
          </Link>
        </div>
        <div className="row">
          <span className="muted app-user">{user.name}</span>
          <form action={signOutAction}>
            <Button type="submit" small>
              Sign out
            </Button>
          </form>
        </div>
      </header>
      <nav aria-label="Application" className="app-sidenav desktop-only">
        <ul className="side-list">
          {APP_NAV.map((i) => (
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
