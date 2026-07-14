// 제한 동시성 매핑 — 대량 비동기 작업(예: 단체문자 N건)을 limit 개씩 동시에 처리.
// 순차(1건씩)는 1000건에 8~15분 걸려 브라우저 탭이 그동안 열려 있어야 해 중간 끊김 위험이 크다.
// 동시 N개로 묶으면 체감 시간이 N배 줄고, 작업 순서와 무관하게 결과를 인덱스 순서로 보존한다.
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const conc = Math.max(1, Math.min(limit, items.length))
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: conc }, () => worker()))
  return out
}
