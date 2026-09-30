export const metadata = { title: "Authorization problem" };

export default async function AuthorizeError({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  return (
    <div className="card stack">
      <h1>This request can&apos;t be completed</h1>
      <p className="alert alert-error" role="alert">
        {(reason ?? "The authorization request was invalid").slice(0, 200)}
      </p>
      <p className="muted">
        Nothing was connected. Return to the app that sent you here and try again.
      </p>
    </div>
  );
}
