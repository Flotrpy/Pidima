import Link from "next/link";
import { ButtonLink } from "@/components/ui";
import { MobileMenu } from "./MobileMenu";
import { PUBLIC_NAV } from "./nav";

export function PublicHeader() {
  return (
    <header className="site-header glass">
      <div className="container site-header-inner">
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden="true" />
          AI Action Inbox
        </Link>
        <nav aria-label="Primary" className="desktop-only">
          <ul className="nav-list">
            {PUBLIC_NAV.map((i) => (
              <li key={i.href}>
                <Link href={i.href}>{i.label}</Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="row desktop-only">
          <ButtonLink href="/sign-in" variant="ghost" small>
            Sign In
          </ButtonLink>
          <ButtonLink href="/sign-in?mode=sign-up" variant="primary" small>
            Start Approving Actions
          </ButtonLink>
        </div>
        <div className="mobile-only">
          <MobileMenu items={PUBLIC_NAV}>
            <div className="stack" style={{ marginTop: 16 }}>
              <ButtonLink href="/sign-in" className="btn-block">
                Sign In
              </ButtonLink>
              <ButtonLink href="/sign-in?mode=sign-up" variant="primary" className="btn-block">
                Start Approving Actions
              </ButtonLink>
            </div>
          </MobileMenu>
        </div>
      </div>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="site-footer">
      <div className="container row" style={{ justifyContent: "space-between" }}>
        <span className="muted">Your AI can prepare the work. You decide what gets done.</span>
        <nav aria-label="Footer">
          <ul className="nav-list">
            <li>
              <Link href="/security">Security</Link>
            </li>
            <li>
              <Link href="/docs">Docs</Link>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
