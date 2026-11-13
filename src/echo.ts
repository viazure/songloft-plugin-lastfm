/**
 * 自写事件抑制登记。
 * 收藏写入（覆盖同步 / 写回合并）都先在这里登记预期事件，
 * 事件到达时据此丢弃回响。独立模块，避免 loved-playlist → writeback → store 的循环引用。
 *
 * 不能只靠 TTL：本轮登记的 songId:type 进 roundKeys，未消费的键保留到下一轮同步开始，
 * 避免宿主事件晚于 30s 时把本轮自写当成用户操作。下一轮 beginRound/clear 再淘汰。
 */

/** 自写产生的 expected 事件被消费一次；roundKeys 优先于 TTL。 */
export class EchoSuppressor {
  private entries = new Map<string, number>();
  /** 本轮同步登记的键；未消费则保留到下一轮 beginRound，不依赖 TTL。 */
  private roundKeys = new Set<string>();

  constructor(
    private now: () => number = () => Date.now(),
    private ttlMs: number = 30_000
  ) {}

  private key(playlistId: number, songId: number, type: "add" | "remove"): string {
    return `${playlistId}:${songId}:${type}`;
  }

  /** 新一轮写入开始：清掉上一轮残留，再登记本轮 expect。 */
  beginRound(): void {
    this.entries.clear();
    this.roundKeys.clear();
  }

  expect(playlistId: number, songId: number, type: "add" | "remove"): void {
    const k = this.key(playlistId, songId, type);
    this.entries.set(k, this.now() + this.ttlMs);
    this.roundKeys.add(k);
  }

  expectDiff(playlistId: number, toAdd: number[], toRemove: number[]): void {
    for (const id of toAdd) this.expect(playlistId, id, "add");
    for (const id of toRemove) this.expect(playlistId, id, "remove");
  }

  /** 命中即消费并返回 true（一次写入只吸收一次广播）。 */
  consume(playlistId: number, songId: number, type: "add" | "remove"): boolean {
    const key = this.key(playlistId, songId, type);
    if (this.roundKeys.has(key)) {
      this.roundKeys.delete(key);
      this.entries.delete(key);
      return true;
    }
    const expiresAt = this.entries.get(key);
    if (expiresAt == null) return false;
    this.entries.delete(key);
    return expiresAt > this.now();
  }

  /**
   * @deprecated 勿在 drain 后调用：会丢掉未到达的晚到回响。
   * 新语义由 beginRound / clear 在下一轮写入开始时清理。
   */
  endRound(): void {
    /* 保留 API；不再清空 roundKeys。 */
  }

  clear(): void {
    this.entries.clear();
    this.roundKeys.clear();
  }

  size(): number {
    return this.entries.size;
  }

  roundSize(): number {
    return this.roundKeys.size;
  }
}

export const favoritesEchoSuppressor = new EchoSuppressor();
