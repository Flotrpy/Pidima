import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/auth-client", () => ({ authClient: {} }));

import { SignInForm } from "./SignInForm";

describe("SignInForm", () => {
  it("renders only configured methods", () => {
    const html = renderToStaticMarkup(<SignInForm methods={["github"]} />);
    expect(html).toContain("Continue with GitHub");
    expect(html).not.toContain("Continue with Google");
    expect(html).not.toContain("Email address");
  });

  it("explains when nothing is configured instead of showing dead buttons", () => {
    const html = renderToStaticMarkup(<SignInForm methods={[]} />);
    expect(html).toContain("not configured");
    expect(html).not.toContain("button");
  });

  it("shows the email form when email is configured", () => {
    expect(renderToStaticMarkup(<SignInForm methods={["email"]} />)).toContain("Email address");
  });
});
