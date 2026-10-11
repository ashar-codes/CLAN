#!/usr/bin/env bash
# Type-checks the CLAN Android native modules (Kotlin) against the Android 16 (API 36) framework surface published by
# Robolectric on Maven Central, with compile-only Expo stubs. Catches API misuse and syntax/type errors; it is NOT a
# Gradle/AGP build (no resources, manifest merge, R8, or React Native linkage) and does not run anything.
# Usage: KC=/path/with/jars ./check.sh [module dirs...]
set -euo pipefail
KC=${KC:?set KC to the folder with kotlin-compiler-embeddable, stdlib, android-all jars}
here=$(cd "$(dirname "$0")" && pwd); root=$(cd "$here/../.." && pwd)
# file-actions needs androidx (FileProvider), which is not downloadable here; it is excluded by default.
mods=("${@:-pinned-transport direct-join share-intake peer-link}")
src=(); for m in ${mods[@]}; do while IFS= read -r f; do src+=("$f"); done < <(find "$root/modules/$m/android" -name '*.kt'); done
cp=$(ls "$KC"/*.jar | grep -v android-all | tr '\n' ':')
okhttp=$(ls "$KC"/okhttp-*.jar "$KC"/okio-*.jar "$KC"/androidx-*.jar 2>/dev/null | tr '\n' ':' || true)
out=$(mktemp -d)
java -Xmx2g -cp "$cp" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect -jvm-target 17 \
  -classpath "$KC/kotlin-stdlib-2.1.21.jar:$KC/android-all-16-robolectric-13921718.jar:$okhttp" \
  -d "$out" "$here/Promise.kt" "$here/Exceptions.kt" "$here/Modules.kt" "${src[@]}"
echo "Kotlin type-check OK: ${#src[@]} files (${mods[*]})"
