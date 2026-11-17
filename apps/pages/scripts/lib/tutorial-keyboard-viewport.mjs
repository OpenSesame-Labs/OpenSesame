import { checkKeyboardCard } from "./tutorial-keyboard-checks.mjs";
import {
  checkKeyboardTarget,
  keyboardGeometry,
} from "./tutorial-keyboard-diagnostics.mjs";
import { keyboardTargetReady } from "./tutorial-keyboard-target.mjs";
import { readStep } from "./tutorial-walk.mjs";

/** Emulate the visual viewport left by a phone keyboard while editing a field. */
export async function checkKeyboardViewport(
  page,
  check,
  label,
  { fieldLabel = "Name", target = "item.editor.name", shot = "keyboard" } = {},
) {
  const original = page.viewportSize();
  if (!original) throw new Error("The phone viewport is unavailable.");
  const field = page.getByLabel(fieldLabel, { exact: true });
  await field.click();
  try {
    await page.setViewportSize({ width: original.width, height: 240 });
    await page.waitForFunction(
      () => (window.visualViewport?.height ?? window.innerHeight) <= 240.5,
      undefined,
      { timeout: 5000 },
    );
    await field.evaluate((node) =>
      node.scrollIntoView({ block: "center", inline: "nearest" }),
    );
    try {
      await page.waitForFunction(keyboardTargetReady, target, {
        timeout: 5000,
      });
    } catch {
      const geometry = await keyboardGeometry(page, target);
      throw new Error(
        `The coach did not fit the shortened viewport: ${JSON.stringify(geometry)}`,
      );
    }
    const info = await readStep(page);
    await checkKeyboardTarget(page, check, label, fieldLabel, target, info);
    if (process.env.TUTORIALS_SHOTS === "1" && process.env.TUTORIALS_OUT) {
      const name = label.replaceAll(" ", "-");
      await page.screenshot({
        path: `${process.env.TUTORIALS_OUT}/${original.width}-${name}-${shot}.png`,
      });
    }
    await checkKeyboardCard(page, check, label, {
      back: target === "unlock.seal-pin-confirm",
    });
  } finally {
    await page.setViewportSize(original);
    await page.waitForFunction(
      (height) =>
        (window.visualViewport?.height ?? window.innerHeight) >= height - 0.5,
      original.height,
      { timeout: 5000 },
    );
  }
}
