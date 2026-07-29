const path = require("node:path");

const resolved = require.resolve("@tools-qweer/electron-dock/preload");
const suffix = path.join("dist", "preload", "public.cjs");
if (!resolved.endsWith(suffix)) {
  throw new Error(`preload require resolved unexpectedly: ${resolved}`);
}
process.stdout.write(`REQUIRE_RESOLVE_OK preload ${resolved}\n`);
