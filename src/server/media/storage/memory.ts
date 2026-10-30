// In-memory MediaStorage for scripts and offline demos that shouldn't touch the disk. It is the
// same class the tests use, re-exported so runtime code doesn't import from src/test directly.
// Objects live only as long as the process; never use it where Fluid instances share state.
export { MemoryStorage } from "@/test/memory-storage";
