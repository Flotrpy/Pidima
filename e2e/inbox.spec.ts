import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

type Seed = {
  workspaceId: string;
  approverCookies: { name: string; value: string }[];
  ids: { deny: string; edit: string; view: string };
};
// Read lazily: global setup rewrites the file after spec files are first loaded.
let seed: Seed;

test.beforeEach(async ({ context }) => {
  seed = JSON.parse(readFileSync("e2e/.seed.json", "utf8")) as Seed;
  // The server runs in production mode, so its session cookie carries the __Secure- prefix.
  await context.addCookies(
    seed.approverCookies.map((c) => ({
      name: `__Secure-${c.name}`,
      value: c.value,
      domain: "localhost",
      path: "/",
      secure: true,
    })),
  );
  await context.addCookies([
    { name: "active_workspace", value: seed.workspaceId, domain: "localhost", path: "/" },
  ]);
});

test("signed-out visitors are sent to sign in", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/inbox");
  await expect(page).toHaveURL(/sign-in/);
});

test("approver sees the pending queue and opens a request", async ({ page }) => {
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page
    .getByRole("link", { name: /acme\/platform/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}/);
  await expect(page.getByRole("button", { name: "Approve and Create" })).toBeEnabled();
});

test("deny asks for confirmation, records the decision and executes nothing", async ({ page }) => {
  await page.goto(`/inbox/${seed.ids.deny}`);
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Deny this request" });
  await dialog.getByLabel("Reason (optional)").fill("Not needed");
  await dialog.getByRole("button", { name: "Deny", exact: true }).click();
  // The decision bar only disappears once the server has recorded the decision.
  await expect(page.getByRole("group", { name: "Decision" })).toHaveCount(0, { timeout: 15_000 });
  await page.reload();
  await expect(page.getByText(/denied/i).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and Create" })).toHaveCount(0);
});

// The e2e server cannot reach GitHub, so a valid edit cannot be re-validated here; edit success is
// covered at service level (tests/edits.test.ts). This checks the failure is explained, not swallowed.
test("edit with an unreachable provider explains why and saves nothing", async ({ page }) => {
  await page.goto(`/inbox/${seed.ids.edit}/edit`);
  await page.getByLabel("Title").fill("Edited by a human");
  await page.getByRole("button", { name: "Save as new version" }).click();
  await expect(page.getByRole("alert").first()).toContainText(/reconnected|try again/i);
  await expect(page).toHaveURL(/\/edit$/);
});

test("review page is keyboard operable and axe-clean", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/inbox/${seed.ids.view}`);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);
  // After the scan: a focused skip link legitimately overlaps the brand link while it is shown.
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
});

test("mobile layout has no horizontal overflow on app pages", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const path of ["/inbox", `/inbox/${seed.ids.view}`, "/history", "/team", "/settings"]) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});
