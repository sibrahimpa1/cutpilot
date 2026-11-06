/** Usage: pnpm demo:footage [outDir]  (macOS uses `say`; Linux uses espeak-ng) */
import { loadEnv, makeDemoFootage } from "@cutpilot/core";

loadEnv();
makeDemoFootage(process.argv[2]).then(
  (f) => console.log(`Demo footage: ${f}`),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
