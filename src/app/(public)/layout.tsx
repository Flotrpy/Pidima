import type { ReactNode } from "react";
import { PublicFooter, PublicHeader } from "@/components/shell/PublicHeader";

export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PublicHeader />
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <PublicFooter />
    </>
  );
}
