"use client";

import { Button } from "@/components/ui";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id="main" className="container" style={{ padding: "96px 20px" }}>
      <h1>Something went wrong</h1>
      <p className="muted">
        The request could not be completed. Nothing was sent or created.
        {error.digest ? ` Reference: ${error.digest}` : null}
      </p>
      <Button variant="primary" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
