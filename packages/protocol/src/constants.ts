/** Shared timing and sizing constants, so host and guest never disagree. */
export const NET = {
  /** Reconnect grace before a match is abandoned. */
  RECONNECT_GRACE_MS: 90_000,
  /** Rooms untouched for this long are garbage collected. */
  IDLE_SWEEP_MS: 10 * 60_000,
  /** Guest heartbeat interval. */
  PING_MS: 5_000,
  /**
   * A peer link silent for this long is treated as dead. WebRTC can take a long
   * while to notice a tab that vanished, so neither end waits for it to.
   */
  LINK_TIMEOUT_MS: 20_000,
  /**
   * Six letters rather than four: the code is also the host's address on a
   * public PeerJS broker, so it has to be hard to stumble on by guessing.
   */
  ROOM_CODE_LENGTH: 6,
} as const;
