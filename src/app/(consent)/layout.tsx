import type { ReactNode } from "react";
import { requireUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** Focused layout for authorization prompts: no navigation to distract from the decision. */
export default async function ConsentLayout({ children }: { children: ReactNode }) {
  await requireUser();
  return (
    <main
      id="main"
      className="container"
      style={{ maxWidth: 560, padding: "48px 20px" }}
      tabIndex={-1}
    >
      {children}
    </main>
  );
}
