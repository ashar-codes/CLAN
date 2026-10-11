package expo.modules.kotlin.modules

import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise

// Compile-only mirror of expo-modules-core's module DSL signatures (ObjectDefinitionBuilder.kt): same overloads,
// reified/crossinline shapes and @JvmName split, so overload resolution behaves as in the real build. Never shipped.
class ModuleDefinitionData
abstract class Module {
  val appContext: AppContext = AppContext()
  abstract fun definition(): ModuleDefinitionData
  fun sendEvent(name: String, body: Map<String, Any?> = emptyMap()) {}
}
@Suppress("FunctionName", "UNUSED_PARAMETER", "NOTHING_TO_INLINE", "UNUSED_VARIABLE")
class ModuleDefinitionBuilder {
  fun Name(name: String) {}
  fun Events(vararg events: String) {}
  inline fun OnDestroy(crossinline body: () -> Unit) {}
  inline fun OnCreate(crossinline body: () -> Unit) {}
  inline fun OnNewIntent(crossinline body: (android.content.Intent) -> Unit) {}
  @JvmName("FunctionWithoutArgs") inline fun Function(name: String, crossinline body: () -> Any?) {}
  inline fun <reified R> Function(name: String, crossinline body: () -> R) {}
  inline fun <reified R, reified P0> Function(name: String, crossinline body: (p0: P0) -> R) {}
  inline fun <reified R, reified P0, reified P1> Function(name: String, crossinline body: (p0: P0, p1: P1) -> R) {}
  inline fun <reified R, reified P0, reified P1, reified P2> Function(name: String, crossinline body: (p0: P0, p1: P1, p2: P2) -> R) {}
  inline fun <reified R, reified P0, reified P1, reified P2, reified P3> Function(name: String, crossinline body: (p0: P0, p1: P1, p2: P2, p3: P3) -> R) {}
  inline fun <reified R, reified P0, reified P1, reified P2, reified P3, reified P4> Function(name: String, crossinline body: (p0: P0, p1: P1, p2: P2, p3: P3, p4: P4) -> R) {}
  inline fun <reified R, reified P0, reified P1, reified P2, reified P3, reified P4, reified P5> Function(name: String, crossinline body: (p0: P0, p1: P1, p2: P2, p3: P3, p4: P4, p5: P5) -> R) {}
  inline fun <reified R, reified P0, reified P1, reified P2, reified P3, reified P4, reified P5, reified P6> Function(name: String, crossinline body: (p0: P0, p1: P1, p2: P2, p3: P3, p4: P4, p5: P5, p6: P6) -> R) {}
  inline fun <reified R, reified P0, reified P1, reified P2, reified P3, reified P4, reified P5, reified P6, reified P7> Function(name: String, crossinline body: (p0: P0, p1: P1, p2: P2, p3: P3, p4: P4, p5: P5, p6: P6, p7: P7) -> R) {}
  @JvmName("AsyncFunctionWithoutArgs") inline fun AsyncFunction(name: String, crossinline body: () -> Any?) {}
  inline fun <reified R> AsyncFunction(name: String, crossinline body: () -> R) {}
  inline fun <reified R, reified P0> AsyncFunction(name: String, crossinline body: (p0: P0) -> R) {}
  inline fun <reified R, reified P0, reified P1> AsyncFunction(name: String, crossinline body: (p0: P0, p1: P1) -> R) {}
  inline fun <reified R, reified P0, reified P1, reified P2> AsyncFunction(name: String, crossinline body: (p0: P0, p1: P1, p2: P2) -> R) {}
  inline fun <reified R, reified P0, reified P1, reified P2, reified P3> AsyncFunction(name: String, crossinline body: (p0: P0, p1: P1, p2: P2, p3: P3) -> R) {}
  inline fun <reified R, reified P0, reified P1, reified P2, reified P3, reified P4> AsyncFunction(name: String, crossinline body: (p0: P0, p1: P1, p2: P2, p3: P3, p4: P4) -> R) {}
  inline fun <reified R, reified P0, reified P1, reified P2, reified P3, reified P4, reified P5> AsyncFunction(name: String, crossinline body: (p0: P0, p1: P1, p2: P2, p3: P3, p4: P4, p5: P5) -> R) {}
  inline fun <reified R, reified P0, reified P1, reified P2, reified P3, reified P4, reified P5, reified P6> AsyncFunction(name: String, crossinline body: (p0: P0, p1: P1, p2: P2, p3: P3, p4: P4, p5: P5, p6: P6) -> R) {}
  inline fun <reified R, reified P0, reified P1, reified P2, reified P3, reified P4, reified P5, reified P6, reified P7> AsyncFunction(name: String, crossinline body: (p0: P0, p1: P1, p2: P2, p3: P3, p4: P4, p5: P5, p6: P6, p7: P7) -> R) {}
  @JvmName("AsyncFunctionWithPromise") inline fun <reified R, reified P0> AsyncFunction(name: String, crossinline body: (p0: P0, p1: Promise) -> R) {}
  @JvmName("AsyncFunctionWithPromise") inline fun <reified R, reified P0, reified P1> AsyncFunction(name: String, crossinline body: (p0: P0, p1: P1, p2: Promise) -> R) {}
  @JvmName("AsyncFunctionWithPromise") inline fun <reified R, reified P0, reified P1, reified P2> AsyncFunction(name: String, crossinline body: (p0: P0, p1: P1, p2: P2, p3: Promise) -> R) {}
  @JvmName("AsyncFunctionWithPromise") inline fun <reified R, reified P0, reified P1, reified P2, reified P3> AsyncFunction(name: String, crossinline body: (p0: P0, p1: P1, p2: P2, p3: P3, p4: Promise) -> R) {}
  @JvmName("AsyncFunctionWithPromise") inline fun <reified R, reified P0, reified P1, reified P2, reified P3, reified P4> AsyncFunction(name: String, crossinline body: (p0: P0, p1: P1, p2: P2, p3: P3, p4: P4, p5: Promise) -> R) {}
  @JvmName("AsyncFunctionWithPromise") inline fun <reified R, reified P0, reified P1, reified P2, reified P3, reified P4, reified P5> AsyncFunction(name: String, crossinline body: (p0: P0, p1: P1, p2: P2, p3: P3, p4: P4, p5: P5, p6: Promise) -> R) {}
  @JvmName("AsyncFunctionWithPromise") inline fun <reified R, reified P0, reified P1, reified P2, reified P3, reified P4, reified P5, reified P6> AsyncFunction(name: String, crossinline body: (p0: P0, p1: P1, p2: P2, p3: P3, p4: P4, p5: P5, p6: P6, p7: Promise) -> R) {}
  @JvmName("AsyncFunctionWithPromise") inline fun <reified R, reified P0, reified P1, reified P2, reified P3, reified P4, reified P5, reified P6, reified P7> AsyncFunction(name: String, crossinline body: (p0: P0, p1: P1, p2: P2, p3: P3, p4: P4, p5: P5, p6: P6, p7: P7, p8: Promise) -> R) {}
}
@Suppress("FunctionName")
inline fun ModuleDefinition(crossinline block: ModuleDefinitionBuilder.() -> Unit): ModuleDefinitionData { ModuleDefinitionBuilder().block(); return ModuleDefinitionData() }
