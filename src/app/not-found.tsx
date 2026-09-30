import { ButtonLink } from "@/components/ui";

export default function NotFound() {
  return (
    <main id="main" className="container" style={{ padding: "96px 20px" }}>
      <h1>Page not found</h1>
      <p className="muted">
        The page you asked for does not exist or you do not have access to it.
      </p>
      <ButtonLink href="/">Back to home</ButtonLink>
    </main>
  );
}
