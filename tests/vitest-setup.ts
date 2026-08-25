/**
 * Vitest global setup — installs the Bun compatibility shim before any OMP
 * tool module loads (pi-utils reads `Bun.env` at import time).
 */
import { installBunShim } from '../src/tools/shared/bun-shim.ts'

installBunShim()
