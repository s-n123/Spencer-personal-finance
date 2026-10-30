// Upload limits shared by the /dev/chat client and the simulator route (no imports, so the client
// bundle can use it).

export const SIM_UPLOAD_LIMITS = {
  maxFileBytes: 8 * 1024 * 1024,
  maxFilesPerPost: 10,
  /**
   * With a proxy.ts present, Next buffers request bodies only up to 10 MB (proxyClientMaxBodySize)
   * and silently truncates the rest, so one post stays under that; the client splits bigger
   * selections into several posts, like Sendblue's one webhook per attachment.
   */
  maxRequestBytes: 9_500_000,
  maxTextChars: 5_000,
} as const;
