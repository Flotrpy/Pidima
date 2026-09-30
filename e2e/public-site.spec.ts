import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const PAGES = ["/", "/security", "/docs", "/sign-in"];

test.describe("accessibility (WCAG 2 A/AA via axe)", () => {
  // Scan the settled presentation: sampling mid-fade would measure transient opacity, not contrast.
  test.use({ reducedMotion: "reduce" });
  for (const path of PAGES) {
    test(`no detectable violations on ${path}`, async ({ page }) => {
      await page.goto(path);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(
        results.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
        ),
      ).toEqual([]);
    });
  }
});

test("scroll reveals every section, so nothing stays hidden", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
  });
  await page.waitForTimeout(700);
  const hidden = await page.locator('.reveal[data-armed="true"]:not([data-shown="true"])').count();
  expect(hidden).toBe(0);
});

test.describe("responsive layout", () => {
  for (const [name, width, height] of [
    ["320px phone", 320, 640],
    ["390px phone", 390, 844],
    ["tablet", 820, 1180],
    ["laptop", 1280, 800],
    ["large desktop", 1920, 1080],
  ] as const) {
    test(`no horizontal scrolling at ${name}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      for (const path of PAGES) {
        await page.goto(path);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${path} at ${width}px`).toBeLessThanOrEqual(0);
      }
    });
  }

  test("text zoom to 200% keeps content readable and unclipped", async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 800 });
    await page.goto("/");
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});

test.describe("keyboard operation", () => {
  test("skip link is the first stop and moves focus to main content", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();
  });

  test("mobile drawer opens, traps focus, closes on Escape and returns focus", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const toggle = page.getByRole("button", { name: "Menu" });
    await toggle.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Site navigation" });
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(toggle).toBeFocused();
  });

  test("mobile drawer locks page scroll while open", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: "Menu" }).click();
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe("hidden");
  });

  test("the inbox demo can be completed with the keyboard alone and announces results", async ({
    page,
  }) => {
    await page.goto("/");
    const approve = page.getByRole("button", { name: "Approve and Create" }).last();
    await approve.scrollIntoViewIfNeeded();
    await approve.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Receipt RCPT-7F3A9C21").first()).toBeVisible();
    await expect(page.locator(".mk-demo [aria-live=polite]")).toHaveText(/Completed/);
  });

  test("every interactive element shows a visible focus indicator", async ({ page }) => {
    await page.goto("/");
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      const visible = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        const s = getComputedStyle(el);
        return (
          (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== "none"
        );
      });
      expect(visible).toBe(true);
    }
  });
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("the hero renders no travelling signals and content is immediately visible", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator(".mk-signal")).toHaveCount(0);
    await page.getByRole("heading", { name: "How it works" }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("heading", { name: "How it works" })).toBeVisible();
    const opacity = await page
      .locator(".mk-step")
      .first()
      .evaluate((e) => getComputedStyle(e.parentElement!).opacity);
    expect(opacity).toBe("1");
  });
});

test.describe("semantics and targets", () => {
  test("has one h1, landmarks, and labelled navigation", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(page.getByRole("contentinfo")).toBeVisible();
  });

  test("primary buttons meet a 44px touch target on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    for (const name of ["Start Approving Actions", "See How It Works"]) {
      const box = await page.getByRole("link", { name }).first().boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });
});
