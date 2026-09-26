package ai.offgridmobile.litert

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

@Suppress("kotlin:S100")
class LiteRTTensorPreflightTest {
    @Test
    fun `rejects unsupported Pixels before native initialization`() {
        for (soc in listOf("Tensor G4", "Tensor G3", "", "unknown")) {
            assertNotNull(LiteRTModule.tensorNpuLoadError("npu", soc, true, "gemma.litertlm", true))
        }
    }

    @Test
    fun `requires matching TPU artifact and dispatch library`() {
        for (chip in listOf("G5", "G6")) {
            val file = "gemma-4-E2B-it_Google_Tensor_$chip.litertlm"
            assertNull(LiteRTModule.tensorNpuLoadError("npu", "Tensor $chip", true, file, true))
            assertNotNull(LiteRTModule.tensorNpuLoadError("npu", "Tensor $chip", true, file, false))
            assertNotNull(LiteRTModule.tensorNpuLoadError("npu", "Tensor $chip", true, "gemma.litertlm", true))
            assertNotNull(LiteRTModule.tensorNpuLoadError("cpu", "Tensor $chip", true, file, true))
        }
        assertNotNull(LiteRTModule.tensorNpuLoadError("npu", "Tensor G5", true, "gemma_Google_Tensor_G6.litertlm", true))
        assertNotNull(LiteRTModule.tensorNpuLoadError("npu", "SM8750", false, "gemma_Google_Tensor_G5.litertlm", true))
    }

    @Test
    fun `preserves CPU GPU and non Tensor NPU requests`() {
        for (backend in listOf("cpu", "gpu")) {
            assertNull(LiteRTModule.tensorNpuLoadError(backend, "Tensor G4", true, "gemma.litertlm", false))
        }
        assertNull(LiteRTModule.tensorNpuLoadError("npu", "SM8750", false, "gemma.litertlm", false))
    }
}
