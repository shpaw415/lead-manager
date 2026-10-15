/**
 * lead-manager — WCAG contrast audit for both themes (Justin's rule: dark + light).
 * Extracts the CSS variables from the served page and checks the button/text pairs.
 * Usage: UI_PORT=4741 bun scripts/contrast-check.ts
 */
const PORT = Number(process.env.UI_PORT ?? 4747);
const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();

function varsOf(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2];
  return out;
}
const css = html.match(/<style>([\s\S]*?)<\/style>/)![1];
const rootBlock = css.slice(0, css.indexOf('html[data-theme="dark"]'));
const darkBlock = css.slice(css.indexOf('html[data-theme="dark"]'));
const light = varsOf(rootBlock);
const dark = varsOf(darkBlock);

function lum(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(fg: string, bg: string): number {
  const [a, b] = [lum(fg), lum(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// fixed colors used by components (from the stylesheet, both themes)
const FIX = {
  light: { danger: "#dc2626", dangerBg: "#ffffff", primaryText: "#ffffff", primaryBg: "#4f46e5" },
  dark: { danger: "#f87171", dangerBg: "#2a1b21", primaryText: "#ffffff", primaryBg: "#4f46e5" },
};

let fail = 0;
function check(name: string, fg: string, bg: string, min = 4.5) {
  const r = ratio(fg, bg);
  const ok = r >= min;
  if (!ok) fail++;
  console.log(`${ok ? "✓" : "✗"} ${name}: ${r.toFixed(2)}:1 (min ${min})  [${fg} on ${bg}]`);
}

for (const [theme, v] of [["light", light], ["dark", dark]] as const) {
  const f = (FIX as any)[theme];
  console.log(`\n— thème ${theme} —`);
  check(`${theme} .btn (ink/surface)`, v.ink, v.surface);
  check(`${theme} .btn:hover (ink/hover)`, v.ink, theme === "dark" ? "#212434" : "#fbfbfe");
  check(`${theme} .btn.lang / .fdel / .fhint (ink-soft/surface)`, v["ink-soft"], v.surface);
  check(`${theme} .btn.danger`, f.danger, f.dangerBg);
  check(`${theme} .btn.primary (fff/accent)`, f.primaryText, f.primaryBg, 4.0);
  check(`${theme} select#dStatus (ink/surface)`, v.ink, v.surface);
  check(`${theme} card .co (ink-soft/surface)`, v["ink-soft"], v.surface);
  check(`${theme} .fsize/.tmeta (ink-faint/surface)`, v["ink-faint"], v.surface, 3.0);
}

console.log(fail ? `\n${fail} échec(s)` : "\ntous les contrastes passent");
process.exit(fail ? 1 : 0);
