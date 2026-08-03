package kr.bottlecorp.pluslotto.recuploader.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RecordingFileMatcherTest {

    @Test
    fun `samsung oneui style`() {
        assertEquals("01012345678", RecordingFileMatcher.parsePhone("Call recording 01012345678_250706_143210"))
        assertEquals("01012345678", RecordingFileMatcher.parsePhone("통화 녹음 01012345678_250706_143210"))
    }

    @Test
    fun `samsung legacy style`() {
        assertEquals("01012345678", RecordingFileMatcher.parsePhone("01012345678-20250706-143210"))
    }

    @Test
    fun `xiaomi miui style`() {
        assertEquals("01012345678", RecordingFileMatcher.parsePhone("CallRecord_01012345678_20250706143210"))
        assertEquals("01012345678", RecordingFileMatcher.parsePhone("+821012345678_20250706_143210"))
    }

    @Test
    fun `lg style timestamp first`() {
        assertEquals("01012345678", RecordingFileMatcher.parsePhone("20250706_143210_01012345678"))
    }

    @Test
    fun `incoming outgoing suffix style`() {
        assertEquals("01012345678", RecordingFileMatcher.parsePhone("01012345678 Incoming 20250706"))
        assertEquals("01012345678", RecordingFileMatcher.parsePhone("01012345678-Outgoing-143210"))
    }

    @Test
    fun `bare phone number anywhere in name`() {
        assertEquals("01012345678", RecordingFileMatcher.parsePhone("recording_01012345678_final"))
    }

    @Test
    fun `fallback longest digit run when no pattern matches`() {
        // 어떤 패턴에도 안 걸리지만 9~11자리 숫자열이 있는 임의 파일명
        assertEquals("123456789", RecordingFileMatcher.parsePhone("weird_name_123456789_x"))
    }

    @Test
    fun `no plausible phone returns null`() {
        assertNull(RecordingFileMatcher.parsePhone("random_file_abc"))
    }

    @Test
    fun `timestamp parsing yyyyMMdd_HHmmss`() {
        assertEquals("2025-07-06T14:32:10", RecordingFileMatcher.parseRecordedAtIso("Call recording 01012345678_20250706_143210"))
    }

    @Test
    fun `timestamp parsing yyMMdd_HHmmss`() {
        assertEquals("2025-07-06T14:32:10", RecordingFileMatcher.parseRecordedAtIso("Call recording 01012345678_250706_143210"))
    }

    @Test
    fun `timestamp parsing returns null when absent`() {
        assertNull(RecordingFileMatcher.parseRecordedAtIso("no_timestamp_here"))
    }
}
