package expo.modules.kotlin.exception
open class CodedException(code: String, message: String?, cause: Throwable?) : Exception(message, cause)
