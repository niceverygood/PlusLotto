package kr.bottlecorp.pluslotto.recuploader.scan

/**
 * 통화녹음 파일명에서 전화번호·녹음시각을 뽑아내는 순수함수 모음.
 * OEM(삼성/샤오미/LG 등)마다 파일명 규칙이 달라 정규식을 순서대로 시도하고, 전부 실패하면
 * "가장 긴 9~11자리 숫자열"을 폴백으로 쓴다. 실기기 검증 전까지는 최선의 추정치다 — 결과는
 * 항상 ScanLogEntity 에 남겨 진단화면에서 튜닝할 수 있게 한다.
 */
object RecordingFileMatcher {

    // 캡처 그룹은 9~12자리로 넉넉히 잡는다(국가코드 82 포함 시 최대 12자리) — 국가코드 보정은
    // normalizeCandidate() 에서 캡처된 원문 그대로 처리(백엔드 normalizeKr() 과 동일 로직).
    private val PHONE_PATTERNS: List<Regex> = listOf(
        // 삼성 One UI: "Call recording 01012345678_250706_143210.m4a" / "통화 녹음 01012345678_..."
        Regex("""(?:Call recording|통화\s?녹음)[ _]+\+?(\d{9,12})[_ ]""", RegexOption.IGNORE_CASE),
        // 삼성 구형: "01012345678-20250706-143210.m4a"
        Regex("""^\+?(\d{9,12})[-_]\d{8}[-_]\d{6}"""),
        // 샤오미 MIUI: "CallRecord_01012345678_20250706143210.mp3" / "+821012345678_20250706_143210.amr"
        Regex("""CallRecord_?\+?(\d{9,12})_""", RegexOption.IGNORE_CASE),
        Regex("""^\+?(\d{9,12})_\d{8}_\d{6}"""),
        // LG: "20250706_143210_01012345678.m4a" (타임스탬프가 먼저, 번호가 나중)
        Regex("""^\d{8}_\d{6}_\+?(\d{9,12})"""),
        // 일부 OEM: "<번호> Incoming/Outgoing <ts>"
        Regex("""\+?(\d{9,12})[ _-]?(?:Incoming|Outgoing|In|Out)""", RegexOption.IGNORE_CASE),
    )

    /** "82"로 시작하는 국가코드 포함 번호는 국내 형식(0으로 시작)으로 보정. 9~11자리만 유효한 번호로 인정. */
    private fun normalizeCandidate(rawDigits: String): String? {
        var d = rawDigits
        if (d.startsWith("82") && d.length in 11..12) d = "0" + d.substring(2)
        return if (d.length in 9..11) d else null
    }

    // (?<!\d)…(?!\d) 로 "독립된" 숫자 토큰만 매치 — 아니면 11자리 전화번호 중간 8/6자리가
    // 잘못 걸려서(예: 01012345678 의 뒷부분) 엉뚱한 값이 타임스탬프로 뽑힌다.
    private val TIMESTAMP_PATTERNS: List<Regex> = listOf(
        Regex("""(?<!\d)(\d{8})[_-](\d{6})(?!\d)"""), // yyyyMMdd_HHmmss
        Regex("""(?<!\d)(\d{6})[_-](\d{6})(?!\d)"""), // yyMMdd_HHmmss
    )

    /** 파일명(확장자 제외)에서 전화번호 숫자열을 추출. 실패 시 null. */
    fun parsePhone(filenameNoExt: String): String? {
        for (re in PHONE_PATTERNS) {
            val m = re.find(filenameNoExt) ?: continue
            val normalized = normalizeCandidate(m.groupValues[1].filter(Char::isDigit)) ?: continue
            return normalized
        }
        // 폴백: 9~11자리 숫자열 중 가장 긴 것(신뢰도 낮음 — 로그에 fallback 으로 표시할 것)
        val runs = Regex("""\d+""").findAll(filenameNoExt).map { it.value }.toList()
        return runs.sortedByDescending { it.length }.firstNotNullOfOrNull { normalizeCandidate(it) }
    }

    /** 파일명에서 yyyyMMdd_HHmmss 류 타임스탬프를 뽑아 ISO8601 로 변환. 실패 시 null(호출측이 파일 mtime 사용). */
    fun parseRecordedAtIso(filenameNoExt: String): String? {
        for (re in TIMESTAMP_PATTERNS) {
            val m = re.find(filenameNoExt) ?: continue
            val datePart = m.groupValues[1]
            val timePart = m.groupValues[2]
            val iso = toIso(datePart, timePart) ?: continue
            return iso
        }
        return null
    }

    private fun toIso(datePart: String, timePart: String): String? {
        val d = if (datePart.length == 6) "20$datePart" else datePart // yy -> 20yy
        if (d.length != 8 || timePart.length != 6) return null
        val year = d.substring(0, 4).toIntOrNull() ?: return null
        val month = d.substring(4, 6).toIntOrNull() ?: return null
        val day = d.substring(6, 8).toIntOrNull() ?: return null
        val hour = timePart.substring(0, 2).toIntOrNull() ?: return null
        val min = timePart.substring(2, 4).toIntOrNull() ?: return null
        val sec = timePart.substring(4, 6).toIntOrNull() ?: return null
        if (month !in 1..12 || day !in 1..31 || hour !in 0..23 || min !in 0..59 || sec !in 0..59) return null
        return "%04d-%02d-%02dT%02d:%02d:%02d".format(year, month, day, hour, min, sec)
    }
}
