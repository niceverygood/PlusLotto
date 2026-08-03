package kr.bottlecorp.pluslotto.recuploader.scan

import java.io.File

private val AUDIO_EXT = setOf("m4a", "amr", "mp3", "3gp", "wav", "aac")

data class CandidateFile(val file: File, val parsedPhone: String?, val recordedAtIso: String?)

/** MANAGE_EXTERNAL_STORAGE 권한 하에 설정된 폴더들을 훑어 오디오 파일 후보를 모은다.
 *  폴더가 없거나 접근 불가면 조용히 건너뛴다(기기마다 없는 폴더가 정상 — 에러 아님). */
class FileSystemScanner {

    fun scan(folderPaths: List<String>): List<CandidateFile> {
        val out = mutableListOf<CandidateFile>()
        for (path in folderPaths) {
            val dir = File(path)
            if (!dir.exists() || !dir.isDirectory) continue
            val files = dir.listFiles() ?: continue
            for (f in files) {
                if (!f.isFile) continue
                val ext = f.extension.lowercase()
                if (ext !in AUDIO_EXT) continue
                val nameNoExt = f.nameWithoutExtension
                out += CandidateFile(
                    file = f,
                    parsedPhone = RecordingFileMatcher.parsePhone(nameNoExt),
                    recordedAtIso = RecordingFileMatcher.parseRecordedAtIso(nameNoExt),
                )
            }
        }
        return out
    }
}
