/**
 * Build the customer APK, repeatably.
 *
 *   node build-apk.mjs            a debug APK, for testing on your own phone
 *   node build-apk.mjs --release  an unsigned release APK, to be signed with
 *                                 your keystore (see the note at the bottom)
 *
 * The steps are the ones that were previously typed by hand, plus the one that
 * is easy to forget and matters most:
 *
 *   1. build the web bundle   (frontend, --mode native)
 *   2. copy it to www         WITHOUT the source maps
 *   3. cap sync android
 *   4. gradlew assembleDebug / assembleRelease
 *
 * WHY THE MAPS ARE DROPPED
 *
 * Vite writes "hidden" source maps: the .js files do not reference them, so a
 * browser never fetches them -- which is why nobody noticed that `cap sync`
 * copies them into the APK anyway. An APK is a zip anyone can open, and those
 * 39 files contain the project's ORIGINAL TypeScript, comments and all. They
 * also added about 4 MB to a 8.4 MB download for no one's benefit. They stay
 * on the build machine, where debugging a stack trace needs them; they do not
 * ship.
 */

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const mobile = dirname(fileURLToPath(import.meta.url));
const frontend = join(mobile, "..", "frontend");
const release = process.argv.includes("--release");

const run = (cmd, cwd) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit", shell: true });
};

/** Copy a tree, skipping source maps. */
function copyWithoutMaps(from, to) {
  let skipped = 0;
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      if (statSync(src).isDirectory()) return true;
      if (src.endsWith(".map")) {
        skipped += 1;
        return false;
      }
      return true;
    },
  });
  return skipped;
}

// 1. the web bundle
run("npm run build:native", frontend);

// 2. into the Capacitor shell, without the maps
const dist = join(frontend, "dist-native");
if (!existsSync(dist)) throw new Error(`No build at ${dist}`);
const www = join(mobile, "www");
rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
const skipped = copyWithoutMaps(dist, www);
console.log(`\nCopied the bundle to www (${readdirSync(www).length} entries, ${skipped} source maps left behind).`);

// 3. Android project
run("npx cap sync android", mobile);

// 4. the APK
const android = join(mobile, "android");
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(process.env.LOCALAPPDATA || "", "Android", "Sdk");
process.env.ANDROID_HOME = sdk;
process.env.ANDROID_SDK_ROOT = sdk;
/**
 * Which wrapper, spelled the way the shell that will actually run it expects.
 *
 * On Windows that shell is always cmd.exe: `execSync` with `shell: true` uses
 * ComSpec, whatever shell this script was started from. So looking at `SHELL`
 * (set by Git Bash) picked the POSIX `./gradlew`, and cmd answered
 * "'.' is not recognized". cmd needs the backslash form, and needs it to be
 * explicit -- a bare `gradlew.bat` is not found when the current directory is
 * excluded from the executable search path.
 */
const wrapper = process.platform === "win32" ? ".\\gradlew.bat" : "./gradlew";
run(`${wrapper} ${release ? "assembleRelease" : "assembleDebug"} --no-daemon`, android);

const out = join(android, "app", "build", "outputs", "apk", release ? "release" : "debug");
console.log(`\nDone. APK in ${out}`);

if (release) {
  console.log(
    [
      "",
      "That release APK is UNSIGNED and cannot be installed as it is.",
      "Sign it with your own keystore -- which only you should hold:",
      "",
      "  keytool -genkey -v -keystore fuelmart-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias fuelmart",
      "  apksigner sign --ks fuelmart-release.jks --out FuelMart-customer.apk app-release-unsigned.apk",
      "",
      "Keep the keystore and its password safe: losing them means never being",
      "able to update the app for anyone who installed it.",
    ].join("\n"),
  );
}
