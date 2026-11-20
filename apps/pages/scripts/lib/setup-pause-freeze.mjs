/**
 * Stable Playwright captures: freeze cipher scrambles and respect reduced motion.
 */

export const SETUP_PAUSE_INIT = `
(() => {
  let seed = 1;
  Math.random = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const native = window.matchMedia.bind(window);
  window.matchMedia = (query) => {
    if (String(query).includes("prefers-reduced-motion")) {
      return {
        matches: true,
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() {
          return true;
        },
      };
    }
    return native(query);
  };
})();
`;

export async function freezeContextRandomness(context) {
  await context.addInitScript(SETUP_PAUSE_INIT);
}

export async function freezePageRandomness(page) {
  await page.context().addInitScript(SETUP_PAUSE_INIT);
}